import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cacheKey, fileCache, SampleMissError } from "../src/cache.ts";
import { createRunLogger, onLogEvent } from "../src/log.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wsh-"));

describe("createRunLogger", () => {
  it("writes one JSON line per event with runId and timestamp", () => {
    const echoed: string[] = [];
    const logger = createRunLogger({
      dir: tmp(),
      runId: "run-1",
      clock: () => new Date("2026-10-22T12:00:00Z"),
      echo: (line) => echoed.push(line),
    });
    logger.log({ agent: "BillReader", step: "extracted", kwh: 1184 });
    logger.log({ agent: "ReconciliationCritic", step: "rejected", reason: "gap" });

    const lines = readFileSync(logger.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts: "2026-10-22T12:00:00.000Z", runId: "run-1", agent: "BillReader", step: "extracted", kwh: 1184 });
    expect(echoed).toHaveLength(2);
  });

  it("hands each event to listeners until they stop, and a failing listener does not stop the run", () => {
    const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createRunLogger({ dir: tmp(), runId: "run-2", clock: () => new Date("2026-10-28T12:00:00Z"), echo: () => {} });
    const seen: unknown[] = [];
    const stop = onLogEvent((record) => seen.push(record));
    const stopBroken = onLogEvent(() => {
      throw new Error("the page went away");
    });
    logger.log({ agent: "WeatherAnalyst", step: "sql", sql: "SELECT 1", rowCount: 1 });
    stop();
    stopBroken();
    logger.log({ agent: "WeatherAnalyst", step: "sql", sql: "SELECT 2", rowCount: 1 });
    quiet.mockRestore();

    expect(seen).toEqual([{ ts: "2026-10-28T12:00:00.000Z", runId: "run-2", agent: "WeatherAnalyst", step: "sql", sql: "SELECT 1", rowCount: 1 }]);
    expect(readFileSync(logger.file, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("response cache", () => {
  it("keys requests independently of property order", () => {
    expect(cacheKey({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(cacheKey({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(cacheKey({ a: 1 })).not.toBe(cacheKey({ a: 2 }));
  });

  it("replays what was recorded and fails loudly on a miss", () => {
    const cache = fileCache(tmp());
    cache.write("sql", { sql: "SELECT 1" }, [["1"]]);
    expect(cache.read("sql", { sql: "SELECT 1" })).toEqual([["1"]]);
    expect(() => cache.read("sql", { sql: "SELECT 2" })).toThrow(SampleMissError);
  });

  it("names the file when a recorded sample is corrupt", () => {
    const root = tmp();
    const cache = fileCache(root);
    cache.write("sql", { sql: "SELECT 1" }, [["1"]]);
    writeFileSync(join(root, "sql", `${cacheKey({ sql: "SELECT 1" })}.json`), "{ half", "utf8");
    expect(() => cache.read("sql", { sql: "SELECT 1" })).toThrow(/Corrupt sample .*\.json/);
  });
});
