// Zetaris REST client, ported from the RestChannel in zetaris/getting-started
// (scripts/zetaris_sql.py). Signs in through the UI proxy, then runs one
// Lightning SQL statement per call. Every statement is logged so the SQL
// behind each number is visible.

import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { SampleMissError, type ResponseCache } from "../cache.ts";
import type { RunLogger } from "../log.ts";

export type Row = readonly string[];

export interface SqlClient {
  /**
   * offline computes the same rows from saved public data. Sample mode uses it
   * only when the statement was never recorded, and logs the source as "snapshot".
   */
  run(agent: string, sql: string, limit?: number, offline?: () => readonly Row[]): Promise<readonly Row[]>;
}

const TIMEOUT_MS = 300_000;

export class ZetarisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZetarisError";
  }
}

/** Zetaris echoes a failing REST source's URL, key included; keys never reach the log. */
export const redactUrlKeys = (text: string): string => text.replace(/(api_key|apikey|token)=[^&\s"']+/gi, "$1=[redacted]");

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { msg?: string };
    return redactUrlKeys((parsed.msg ?? text).slice(0, 400));
  } catch {
    return redactUrlKeys(text.slice(0, 400));
  }
}

/** Cells come back as strings today; numbers and nulls are coerced so callers can rely on Row. */
export function normalizeRows(data: unknown): readonly Row[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : [],
  );
}

export function createZetarisRest(config: Config["zetaris"], fetchImpl: typeof fetch = fetch) {
  let token: string | undefined;

  async function login(): Promise<string> {
    const response = await fetchImpl(`${config.uiUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
      body: JSON.stringify({ username: config.email, password: config.password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ZetarisError(`Zetaris login failed: HTTP ${response.status}`);
    const body = (await response.json()) as { idToken?: string; token?: string; accessToken?: string };
    const found = body.idToken ?? body.token ?? body.accessToken;
    if (!found) throw new ZetarisError("Zetaris login did not return an access token.");
    return found;
  }

  const post = (sql: string, limit: number, bearer: string, queryId: string): Promise<Response> =>
    fetchImpl(`${config.apiUrl}/sql-editor/sqls/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Org-ID": config.orgId,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ queryId, sql, source: "SqlEditor", limit }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  /** queryId is the id Zetaris keeps for the statement in its query history; the run log records it. */
  async function run(sql: string, limit = 1000, queryId: string = randomUUID()): Promise<readonly Row[]> {
    return (await query(sql, limit, queryId)).rows;
  }

  /** The whole answer: column names, rows, and the time Zetaris says the statement took. */
  async function query(sql: string, limit = 1000, queryId: string = randomUUID()): Promise<Answer> {
    token ??= await login();
    let response = await post(sql, limit, token, queryId);
    if (response.status === 401) {
      // The session token expired or Zetaris restarted: sign in again once.
      token = await login();
      response = await post(sql, limit, token, queryId);
    }
    if (!response.ok) {
      const raw = await readError(response);
      const detail = config.password ? raw.replaceAll(config.password, "[redacted]") : raw;
      throw new ZetarisError(`Zetaris HTTP ${response.status}: ${detail}`);
    }
    const body = (await response.json()) as { headers?: unknown; data?: unknown; timeUsed?: unknown } | null;
    return {
      headers: Array.isArray(body?.headers) ? body.headers.map(String) : [],
      rows: normalizeRows(body?.data),
      timeUsedMs: typeof body?.timeUsed === "number" ? body.timeUsed : null,
    };
  }

  return { run, query };
}

export interface Answer {
  readonly headers: readonly string[];
  readonly rows: readonly Row[];
  readonly timeUsedMs: number | null;
}

export interface SqlDeps {
  readonly config: Config;
  readonly cache: ResponseCache;
  readonly logger: RunLogger;
  readonly fetchImpl?: typeof fetch;
  readonly retryMs?: number;
}

// Seen on 22 Oct during the evaluation: Zetaris answered one statement with a bare
// "HTTP 400: Bad Request" and ran the same statement fine right after, so a
// failed statement is tried once more, and the retry is logged.
const RETRY_MS = 2_000;

/** Live, recording or replaying SQL client depending on SAMPLE_MODE and RECORD_SAMPLES. */
export function createSqlClient(deps: SqlDeps): SqlClient {
  const { config, cache, logger } = deps;
  const rest = createZetarisRest(config.zetaris, deps.fetchImpl);
  const liveRun = async (agent: string, sql: string, limit: number): Promise<{ rows: readonly Row[]; queryId: string }> => {
    const first = randomUUID();
    try {
      return { rows: await rest.run(sql, limit, first), queryId: first };
    } catch (error: unknown) {
      if (!(error instanceof ZetarisError)) throw error;
      const waitMs = deps.retryMs ?? RETRY_MS;
      logger.log({ agent, step: "sql_retry", waitMs, failedQueryId: first, reason: error.message.slice(0, 200) });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const second = randomUUID();
      return { rows: await rest.run(sql, limit, second), queryId: second };
    }
  };
  return {
    async run(agent: string, sql: string, limit = 1000, offline?: () => readonly Row[]): Promise<readonly Row[]> {
      const started = Date.now();
      const request = { sql, limit };
      let source: "sample" | "snapshot" | "live" = config.sampleMode ? "sample" : "live";
      let rows: readonly Row[];
      let zetarisQueryId: string | undefined;
      if (!config.sampleMode) {
        ({ rows, queryId: zetarisQueryId } = await liveRun(agent, sql, limit));
      } else {
        try {
          rows = cache.read<Row[]>("sql", request);
        } catch (error: unknown) {
          if (!(error instanceof SampleMissError) || !offline) throw error;
          rows = offline();
          source = "snapshot";
        }
      }
      if (config.recordSamples) cache.write("sql", request, rows);
      logger.log({
        agent,
        step: "sql",
        source,
        ...(zetarisQueryId ? { zetarisQueryId } : {}),
        sql,
        rowCount: rows.length,
        latencyMs: Date.now() - started,
      });
      return rows;
    },
  };
}
