// "What the agents asked Zetaris": while a photo is being read, the server streams
// every SQL statement the agents send (GET /api/events) and this list shows each one
// as Zetaris answers it, with the query id Zetaris keeps in its query history.

import { esc } from "./format.ts";
import { agentName } from "./model.ts";

interface StatementEvent {
  readonly agent: string;
  readonly step: string;
  readonly source?: string;
  readonly zetarisQueryId?: string;
  readonly sql?: string;
  readonly rowCount?: number;
  readonly latencyMs?: number;
  readonly reason?: string;
  readonly waitMs?: number;
  readonly failedQueryId?: string;
  readonly check?: string;
  readonly accepted?: boolean;
}

/** Where each table lives, in the page's words, with its icon. The first match per pattern wins. */
const SOURCES: readonly (readonly [RegExp, string, string])[] = [
  [/\bhousehold_pg\.decisions\b/i, "Saved decisions, Postgres", "floppy-disk"],
  [/\bhousehold_pg\.(?!decisions\b)/i, "Your bills, Postgres", "database"],
  [/\bnoaa_ncei\./i, "NOAA daily weather, REST", "cloud-sun"],
  [/\bopenei_urdb\./i, "AEP Ohio tariff, OpenEI REST", "receipt"],
  [/\beia_api\./i, "Ohio average price, EIA REST", "chart-line-up"],
  [/\blightning\.metastore\./i, "Semantic layer in Zetaris", "stack"],
];

const SOURCE_NOTE: Readonly<Record<string, string>> = {
  sample: "replayed from a recorded run",
  snapshot: "computed from saved public data",
};

// Zetaris passes on an outside API's refusal with that API's URL (keys already redacted).
const APIS: readonly (readonly [RegExp, string])[] = [
  [/\/\/api\.eia\.gov\//i, "EIA"],
  [/\/\/api\.openei\.org\//i, "OpenEI"],
  [/\/\/(?:www\.)?ncei\.noaa\.gov\//i, "NOAA"],
];
const HTTP_WORDS: Readonly<Record<string, string>> = { "401": "key refused", "403": "access refused", "429": "too many requests" };

/** What a run does without when that source stays unavailable. */
const LEFT_OUT: Readonly<Record<string, string>> = { eia: "the Ohio average price from EIA" };

/** The checker's verdict on the weather rule in Zetaris, shortened for the list. */
function ruleVerdict(reason: string | undefined): string {
  const held = /rule (\w+) \([^)]*\) rejects the bill \S+ to \S+: NOAA has (\d+) of (\d+) days/.exec(reason ?? "");
  if (held) return `Rule ${held[1]} holds this bill: NOAA has ${held[2]} of ${held[3]} days.`;
  const passed = /every day of the (\d+) bills compared, and Zetaris rule (\w+) confirms/.exec(reason ?? "");
  if (passed) return `Rule ${passed[2]} passes the ${passed[1]} bills compared.`;
  return reason ?? "";
}

/** "EIA answered HTTP 429, too many requests", or null when the reason names no known API. */
export function refusal(reason: string | undefined): string | null {
  const match = /response code: (\d{3}) for URL: (\S+)/i.exec(reason ?? "");
  const api = match ? APIS.find(([pattern]) => pattern.test(match[2]))?.[1] : undefined;
  if (!match || !api) return null;
  const words = HTTP_WORDS[match[1]] ?? (match[1].startsWith("5") ? "server error" : "");
  return `${api} answered HTTP ${match[1]}${words ? `, ${words}` : ""}`;
}

// The last statements are logged just before the answer is sent; wait for them.
const CLOSE_AFTER_MS = 1_500;

const elapsed = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

// The run itself writes the decision back; the other names come from the agents.
const who = (agent: string): string => (agent === "Orchestrator" ? "Saving the result" : agentName(agent));

const chip = (label: string, iconName: string): string =>
  `<span class="zsrc"><i class="ph-light ph-${iconName}" aria-hidden="true"></i>${esc(label)}</span>`;

// A data-quality statement names the layer too, but what it asks is the rule's verdict.
const QUALITY = /^\s*(?:SHOW|LIST|RUN)\s+DQ\b/i;

function sourcesOf(sql: string): string {
  if (QUALITY.test(sql)) return `<span class="zverb">Checks</span>${chip("Data-quality rule in Zetaris", "list-checks")}`;
  const chips = SOURCES.filter(([pattern]) => pattern.test(sql))
    .map(([, label, iconName]) => chip(label, iconName))
    .join("");
  const verb = /^\s*INSERT\b/i.test(sql) ? "Writes to" : "Reads";
  return `<span class="zverb">${verb}</span>${chips || `<span class="zsrc">${esc(sql.slice(0, 40))}</span>`}`;
}

export function statementRow(e: StatementEvent, atMs: number): string {
  const at = `<span class="zt num">+${(atMs / 1000).toFixed(1)} s</span>`;
  if (e.step === "sql_retry") {
    const cause = refusal(e.reason);
    const again = `so it was sent again${e.waitMs ? ` after ${elapsed(e.waitMs)}` : ""}.`;
    const text = cause ? `${cause}. Zetaris passed that on, ${again}` : `Zetaris turned this statement down once, ${again}`;
    const failed = e.failedQueryId ? ` <span class="zfail">Failed Zetaris query <code translate="no">${esc(e.failedQueryId.slice(0, 8))}</code></span>` : "";
    return `<li class="zrow zretry">${at}<span class="zmain"><b>${esc(who(e.agent))}</b><span class="zline">${esc(text)}${failed}</span></span></li>`;
  }
  if (e.step === "accepted" || e.step === "rejected") {
    const held = e.accepted === false;
    return `<li class="zrow${held ? " zheld" : ""}">${at}<span class="zmain"><b>${esc(who(e.agent))}</b><span class="zline"><span class="zverb">${held ? "Held" : "Accepted"}</span>${esc(ruleVerdict(e.reason))}</span></span></li>`;
  }
  if (e.step === "context_unavailable") {
    const cause = refusal(e.reason);
    const text = `This run goes on without ${LEFT_OUT[e.source ?? ""] ?? "one of its sources"}${cause ? `, because ${cause}` : ""}.`;
    return `<li class="zrow zretry">${at}<span class="zmain"><b>${esc(who(e.agent))}</b><span class="zline">${esc(text)}</span></span></li>`;
  }
  const sql = e.sql ?? "";
  const note = e.source && SOURCE_NOTE[e.source] ? `<span class="znote">${esc(SOURCE_NOTE[e.source])}</span>` : "";
  const id = e.zetarisQueryId ? `Zetaris query <code translate="no">${esc(e.zetarisQueryId.slice(0, 8))}</code>` : "SQL";
  const rows = e.rowCount ?? 0;
  return `<li class="zrow">${at}
    <span class="zmain"><b>${esc(who(e.agent))}</b><span class="zline">${sourcesOf(sql)}${note}</span></span>
    <span class="zn num">${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"}<br>${elapsed(e.latencyMs ?? 0)}</span>
    <details class="zsql"><summary>${id}</summary><pre class="sql"><code translate="no">${esc(sql)}</code>${
      e.zetarisQueryId ? `\n<span class="zid">-- query id ${esc(e.zetarisQueryId)}</span>` : ""
    }</pre></details></li>`;
}

export interface LiveQueries {
  start(): void;
  stop(): void;
}

export interface LiveOptions {
  /** The server-sent events to listen to: /api/events?for=photo or ?for=demo. */
  readonly stream: string;
  /** Fold the list into its summary line once the run is over (root holds a details element). */
  readonly foldWhenDone?: boolean;
}

/** Fills root's list with the statements of the run in progress. */
export function liveQueries(root: HTMLElement, options: LiveOptions): LiveQueries {
  const list = root.querySelector<HTMLOListElement>(".zlist");
  const total = root.querySelector<HTMLElement>(".ztotal");
  let source: EventSource | null = null;
  let closing: ReturnType<typeof setTimeout> | undefined;
  let count = 0;

  const close = (): void => {
    clearTimeout(closing);
    source?.close();
    source = null;
    // A run that never reached Zetaris (a refused photo, or a demo already worked out) leaves no empty list behind.
    if (count === 0) root.hidden = true;
    else if (options.foldWhenDone) root.querySelector("details")?.removeAttribute("open");
  };

  return {
    start(): void {
      if (!list || !total) return;
      close();
      list.innerHTML = "";
      total.textContent = "Waiting for the first query…";
      root.hidden = false;
      root.querySelector("details")?.setAttribute("open", "");
      const started = performance.now();
      count = 0;
      let rows = 0;
      let busyMs = 0;
      source = new EventSource(options.stream);
      source.onmessage = (message: MessageEvent<string>): void => {
        const e = JSON.parse(message.data) as StatementEvent;
        list.insertAdjacentHTML("beforeend", statementRow(e, performance.now() - started));
        if (e.step !== "sql") return;
        count += 1;
        rows += e.rowCount ?? 0;
        busyMs += e.latencyMs ?? 0;
        total.textContent = `${count} ${count === 1 ? "query" : "queries"}, ${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"}, ${elapsed(busyMs)} inside Zetaris`;
      };
    },
    stop(): void {
      clearTimeout(closing);
      closing = setTimeout(close, CLOSE_AFTER_MS);
    },
  };
}
