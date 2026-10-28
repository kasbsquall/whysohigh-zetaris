import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { callNightshift, createLlmClient, splitReasoning } from "../src/llm/nightshift.ts";
import type { LogEvent, RunLogger } from "../src/log.ts";
import { createSqlClient, createZetarisRest, parseHistory, redactUrlKeys, ZetarisError } from "../src/zetaris/client.ts";

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(responses: readonly Response[], calls: Captured[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses[i++];
  }) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryLogger(): RunLogger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { runId: "t", file: "", events, log: (e) => events.push(e) };
}

const live = loadConfig({ SAMPLE_MODE: "false", METERLESS_RUNTIME_TOKEN: "tok", ZETARIS_PASSWORD: "pw" });

describe("splitReasoning", () => {
  it("separates a reasoning trace from the answer", () => {
    expect(splitReasoning("thinking about it</think>{\"a\":1}")).toEqual({ text: "{\"a\":1}", reasoning: "thinking about it" });
    expect(splitReasoning("  plain answer ")).toEqual({ text: "plain answer", reasoning: "" });
  });
});

describe("callNightshift", () => {
  it("sends the Meterless headers and reports the model that actually answered", async () => {
    const calls: Captured[] = [];
    const result = await callNightshift(
      live.meterless,
      { model: "nvidia/nemotron-3.5-lightning-30b-a3b", messages: [{ role: "user", content: "hi" }] },
      fakeFetch([json({ model: "nvidia/nemotron-3-ultra-550b-a55b", choices: [{ message: { content: "r</think>ok" } }] })], calls),
    );
    expect(result).toMatchObject({ text: "ok", modelRequested: "nvidia/nemotron-3.5-lightning-30b-a3b", modelServed: "nvidia/nemotron-3-ultra-550b-a55b" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["meterless-scope"]).toBe("user");
  });

  it("raises an explicit error on a non-2xx reply and redacts the token", async () => {
    await expect(
      callNightshift(live.meterless, { model: "m", messages: [] }, fakeFetch([new Response("rejected key tok", { status: 401 })], [])),
    ).rejects.toThrow(/HTTP 401 for m: rejected key \[redacted\]/);
  });

  it("reports truncation instead of a misleading parse error", async () => {
    const cut = json({ model: "m", choices: [{ finish_reason: "length", message: { content: "still thinking" } }] });
    await expect(
      callNightshift(live.meterless, { model: "m", messages: [], maxTokens: 50 }, fakeFetch([cut], [])),
    ).rejects.toThrow(/cut at max_tokens \(50\)/);
  });
});

describe("Zetaris REST", () => {
  it("signs in once and sends one statement per call with org and request ids", async () => {
    const calls: Captured[] = [];
    const rest = createZetarisRest(
      live.zetaris,
      fakeFetch([json({ idToken: "id-1" }), json({ data: [["1"]] }), json({ data: [["2"]] })], calls),
    );
    expect(await rest.run("SELECT 1")).toEqual([["1"]]);
    expect(await rest.run("SELECT 2")).toEqual([["2"]]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:3000/api/auth/login",
      "http://localhost:8888/api/v1.0/sql-editor/sqls/run",
      "http://localhost:8888/api/v1.0/sql-editor/sqls/run",
    ]);
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer id-1");
    expect(headers["X-Org-ID"]).toBe("1");
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ sql: "SELECT 1", source: "SqlEditor" });
  });

  it("signs in again once when the session token expired", async () => {
    const calls: Captured[] = [];
    const rest = createZetarisRest(
      live.zetaris,
      fakeFetch([json({ idToken: "old" }), json({}, 401), json({ idToken: "new" }), json({ data: [[1, null]] })], calls),
    );
    expect(await rest.run("SELECT 1, NULL")).toEqual([["1", ""]]);
    expect((calls[3].init.headers as Record<string, string>).Authorization).toBe("Bearer new");
  });

  it("surfaces the Zetaris error message", async () => {
    const rest = createZetarisRest(live.zetaris, fakeFetch([json({ idToken: "x" }), json({ msg: "table not found" }, 400)], []));
    await expect(rest.run("SELECT * FROM nope")).rejects.toThrow(ZetarisError);
  });

  const ENTRY = { id: "71deceb9-dc6a-42f5-8072-4e9dc8ea7209", sql: "INSERT INTO household_pg.decisions VALUES (********)", status: "Success", time: "2026-10-28T19:06:46.570262Z" };

  it("reads one query id from Zetaris's query history", async () => {
    const calls: Captured[] = [];
    const rest = createZetarisRest(live.zetaris, fakeFetch([json({ idToken: "x" }), json(ENTRY)], calls));
    expect(await rest.history(ENTRY.id)).toEqual([ENTRY]);
    expect(calls[1].url).toBe(`http://localhost:8888/api/v1.0/sql-editor/sqls/history/${ENTRY.id}`);
    expect((calls[1].init.headers as Record<string, string>)["X-Org-ID"]).toBe("1");
  });

  it("finds a short id, as the page prints it, in the whole history", async () => {
    const calls: Captured[] = [];
    const other = { ...ENTRY, id: "d48eddc4-2340-4c06-ac73-3848a895e259" };
    const rest = createZetarisRest(live.zetaris, fakeFetch([json({ idToken: "x" }), json([other, ENTRY, { id: 7 }])], calls));
    expect(await rest.history("71DECEB9")).toEqual([ENTRY]);
    expect(calls[1].url).toBe("http://localhost:8888/api/v1.0/sql-editor/sqls/history");
  });

  it("returns nothing for an id Zetaris never ran", async () => {
    const rest = createZetarisRest(live.zetaris, fakeFetch([json({ idToken: "x" }), json(null)], []));
    expect(await rest.history(ENTRY.id)).toEqual([]);
  });
});

describe("parseHistory", () => {
  it("keeps well-formed entries that start with the id asked for", () => {
    const entry = { id: "abcdef12-0000-4000-8000-000000000000", sql: "SELECT 1", status: "Failed", time: "2026-10-28T19:00:00Z" };
    expect(parseHistory([entry, { id: "abcdef99", sql: 1 }, "x"], "abcdef")).toEqual([entry]);
    expect(parseHistory(entry, "abcdef12-0000-4000-8000-000000000000")).toEqual([entry]);
    expect(parseHistory({ msg: "not found" }, "abcdef")).toEqual([]);
  });
});

describe("live SQL client", () => {
  const cache = () => fileCache(mkdtempSync(join(tmpdir(), "wsh-")));

  it("tries a failed statement once more and logs the retry", async () => {
    const logger = memoryLogger();
    const sql = createSqlClient({
      config: live,
      cache: cache(),
      logger,
      retryMs: 0,
      fetchImpl: fakeFetch([json({ idToken: "x" }), new Response("Bad Request", { status: 400 }), json({ data: [["1"]] })], []),
    });
    expect(await sql.run("WeatherAnalyst", "SELECT 1")).toEqual([["1"]]);
    expect(logger.events.map((e) => e.step)).toEqual(["sql_retry", "sql"]);
  });

  it("logs the query id it sent, so the run can be found in Zetaris' query history", async () => {
    const logger = memoryLogger();
    const calls: Captured[] = [];
    const sql = createSqlClient({
      config: live,
      cache: cache(),
      logger,
      retryMs: 0,
      fetchImpl: fakeFetch([json({ idToken: "x" }), new Response("Bad Request", { status: 400 }), json({ data: [["1"]] })], calls),
    });
    await sql.run("WeatherAnalyst", "SELECT 1");
    const sent = calls.slice(1).map((c) => (JSON.parse(String(c.init.body)) as { queryId: string }).queryId);
    expect(sent[0]).not.toBe(sent[1]);
    expect(logger.events).toMatchObject([
      { step: "sql_retry", failedQueryId: sent[0] },
      { step: "sql", source: "live", zetarisQueryId: sent[1] },
    ]);
  });

  it("gives up after the second failure", async () => {
    const sql = createSqlClient({
      config: live,
      cache: cache(),
      logger: memoryLogger(),
      retryMs: 0,
      fetchImpl: fakeFetch([json({ idToken: "x" }), json({ msg: "table not found" }, 400), json({ msg: "table not found" }, 400)], []),
    });
    await expect(sql.run("WeatherAnalyst", "SELECT * FROM nope")).rejects.toThrow(/table not found/);
  });
});

describe("live model client", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
  const ok = json({ model: "m", choices: [{ message: { content: "ok" } }] });

  it("retries a provider 5xx and logs the retry", async () => {
    const logger = memoryLogger();
    const llm = createLlmClient({
      config: live,
      cache: fileCache(mkdtempSync(join(tmpdir(), "wsh-"))),
      logger,
      backoffMs: [0, 0],
      fetchImpl: fakeFetch([new Response("upstream", { status: 502 }), ok], []),
    });
    expect((await llm.chat("BillReader", request)).text).toBe("ok");
    expect(logger.events.map((e) => e.step)).toEqual(["provider_retry", "model_call"]);
  });

  it("does not retry a client error", async () => {
    const calls: Captured[] = [];
    const llm = createLlmClient({
      config: live,
      cache: fileCache(mkdtempSync(join(tmpdir(), "wsh-"))),
      logger: memoryLogger(),
      backoffMs: [0, 0],
      fetchImpl: fakeFetch([new Response("bad", { status: 400 }), ok], calls),
    });
    await expect(llm.chat("BillReader", request)).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it("records a provider failure so sample mode replays the same failure", async () => {
    const cache = fileCache(mkdtempSync(join(tmpdir(), "wsh-")));
    const recording = loadConfig({ SAMPLE_MODE: "false", RECORD_SAMPLES: "true", METERLESS_RUNTIME_TOKEN: "tok", ZETARIS_PASSWORD: "pw" });
    const down = new Response("multimodal processing is not enabled", { status: 502 });
    const live = createLlmClient({ config: recording, cache, logger: memoryLogger(), fetchImpl: fakeFetch([down], []) });
    await expect(live.chat("BillReader", request)).rejects.toMatchObject({ name: "NightshiftError", status: 502 });

    const logger = memoryLogger();
    const replay = createLlmClient({ config: loadConfig({}), cache, logger });
    await expect(replay.chat("BillReader", request)).rejects.toThrow(/multimodal processing is not enabled/);
    expect(logger.events).toMatchObject([{ step: "model_call_failed", source: "sample", status: 502 }]);
  });

  it("keeps a good recording when a re-record hits a provider failure", async () => {
    const cache = fileCache(mkdtempSync(join(tmpdir(), "wsh-")));
    cache.write("llm", request, { text: "ok", reasoning: "", modelRequested: "m", modelServed: "m" });
    const recording = loadConfig({ SAMPLE_MODE: "false", RECORD_SAMPLES: "true", METERLESS_RUNTIME_TOKEN: "tok", ZETARIS_PASSWORD: "pw" });
    const down = new Response("upstream", { status: 400 });
    const live = createLlmClient({ config: recording, cache, logger: memoryLogger(), fetchImpl: fakeFetch([down], []) });
    await expect(live.chat("BillReader", request)).rejects.toThrow(/HTTP 400/);
    expect(cache.read<{ text: string }>("llm", request).text).toBe("ok");
  });
});

describe("sample mode clients", () => {
  it("replay recorded answers and log the source, SQL and served model", async () => {
    const cache = fileCache(mkdtempSync(join(tmpdir(), "wsh-")));
    const sampleConfig = loadConfig({});
    const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
    cache.write("llm", request, { text: "ok", reasoning: "", modelRequested: "m", modelServed: "m" });
    cache.write("sql", { sql: "SELECT 1", limit: 1000 }, [["1"]]);
    const logger = memoryLogger();

    const llm = createLlmClient({ config: sampleConfig, cache, logger });
    const sql = createSqlClient({ config: sampleConfig, cache, logger });
    expect((await llm.chat("BillReader", request)).text).toBe("ok");
    expect(await sql.run("WeatherAnalyst", "SELECT 1")).toEqual([["1"]]);
    expect(logger.events).toMatchObject([
      { agent: "BillReader", step: "model_call", source: "sample", modelServed: "m" },
      { agent: "WeatherAnalyst", step: "sql", source: "sample", sql: "SELECT 1", rowCount: 1 },
    ]);
  });
});

describe("Zetaris error messages", () => {
  it("never carry a REST source's key", () => {
    const raw = "REST API call failed: HTTP 429 for URL: https://api.eia.gov/v2/x/?api_key=abc123SECRET&frequency=monthly";
    expect(redactUrlKeys(raw)).toBe("REST API call failed: HTTP 429 for URL: https://api.eia.gov/v2/x/?api_key=[redacted]&frequency=monthly");
  });
});
