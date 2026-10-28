// Runs Lightning SQL against the Zetaris set in .env, one statement per call, for
// people and coding agents working on this repo (AGENTS.md). Each statement prints
// its columns and rows, how long it took, and the query id Zetaris keeps in its
// query history. Credentials stay in .env and are never printed.
//   npm run zsql -- "SHOW LIGHTNING DATABASES"
//   npm run zsql -- --file zetaris/billing_usl.sql --dry-run
//   npm run zsql -- --file zetaris/billing_usl.sql [--limit 50]
// Statements that drop, remove, delete, truncate, grant or revoke need --allow-destructive.
// Every statement is also logged to logs/<run id>.jsonl, like the agents' own.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { createRunLogger } from "../src/log.ts";
import { createZetarisRest, type Answer } from "../src/zetaris/client.ts";
import { isDestructive, splitStatements } from "../src/zetaris/statements.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    limit: { type: "string", default: "50" },
    "dry-run": { type: "boolean", default: false },
    "allow-destructive": { type: "boolean", default: false },
  },
});

const usage = 'Usage: npm run zsql -- "<statement>"   or   npm run zsql -- --file <path.sql> [--dry-run] [--limit 50]\n';
const limit = Number(values.limit);
if ((positionals.length === 0) === !values.file || !Number.isInteger(limit) || limit < 1) {
  process.stderr.write(usage);
  process.exit(2);
}
const statements = values.file ? splitStatements(readFileSync(values.file, "utf8")) : [positionals.join(" ").trim().replace(/;\s*$/, "")];
const blocked = statements.find((s) => isDestructive(s));
if (blocked && !values["allow-destructive"]) {
  process.stderr.write(`Refused: "${blocked.split("\n")[0].slice(0, 80)}" removes something or changes access. Run it only if your task asks for it, with --allow-destructive.\n`);
  process.exit(2);
}

const CELL = 40;
const cell = (value: string): string => (value.length > CELL ? `${value.slice(0, CELL - 1)}…` : value);

function table(answer: Answer): string {
  const rows = answer.rows.map((r) => r.map(cell));
  const headers = answer.headers.length ? answer.headers.map(cell) : (rows[0] ?? []).map((_, i) => `col${i + 1}`);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]): string => r.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

if (values["dry-run"]) {
  statements.forEach((s, i) => process.stdout.write(`-- ${i + 1}/${statements.length}\n${s}\n\n`));
  process.exit(0);
}

loadDotEnv();
const config = loadConfig({ ...process.env, SAMPLE_MODE: "false" });
const zetaris = createZetarisRest(config.zetaris);
const logger = createRunLogger({ echo: () => {} });
for (const [i, sql] of statements.entries()) {
  const queryId = randomUUID();
  const started = Date.now();
  process.stdout.write(`-- ${i + 1}/${statements.length}  ${sql.split("\n")[0].slice(0, 100)}\n`);
  try {
    const answer = await zetaris.query(sql, limit, queryId);
    const ms = Date.now() - started;
    logger.log({ agent: "zsql", step: "sql", source: "live", zetarisQueryId: queryId, sql, rowCount: answer.rows.length, latencyMs: ms });
    process.stdout.write(`   query ${queryId}  ${answer.rows.length} rows  ${ms} ms\n`);
    if (answer.rows.length || answer.headers.length) process.stdout.write(`${table(answer)}\n`);
    process.stdout.write("\n");
  } catch (error: unknown) {
    const message = (error as Error).message;
    logger.log({ agent: "zsql", step: "sql_failed", zetarisQueryId: queryId, sql, error: message });
    process.stdout.write(`   query ${queryId}  FAILED after ${Date.now() - started} ms\n   ${message}\n`);
    process.exit(1);
  }
}
