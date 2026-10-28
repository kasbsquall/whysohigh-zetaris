import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Household } from "../src/demo.ts";
import { heldPayload, readQueries } from "../src/held.ts";
import type { Explanation } from "../src/pipeline.ts";
import { heldView } from "../web/src/held.ts";

const MARCUS: Household = {
  id: "marcus",
  name: "Marcus",
  city: "Columbus, OH",
  utility: "AEP Ohio",
  householdSize: 2,
  annualIncomeUsd: 61000,
  electricHeat: false,
};

const RULE = { name: "weather_covers_bill", expression: "weather_days = days", passed: false };
const HELD_REASON = "Zetaris rule weather_covers_bill (weather_days = days) rejects the bill 2026-09-28 to 2026-10-28: NOAA has 25 of 30 days.";

/** Only the parts of an explanation that a held bill uses. */
const explanation = (overrides: { skipped?: string | null; rule?: typeof RULE } = {}): Explanation =>
  ({
    bill: { periodStart: "09/28/2026", periodEnd: "10/28/2026", days: 30, kwh: 671, totalUsd: 131.36, previous: null, lineItems: [] },
    history: [
      { periodStart: "2026-08-27", periodEnd: "2026-09-28", days: 32, kwh: 1041, weatherDays: 32, cdd: 120, hdd: 10, weatherRule: { ...RULE, passed: true } },
      { periodStart: "2026-09-28", periodEnd: "2026-10-28", days: 30, kwh: 671, weatherDays: 25, cdd: 20, hdd: 90, weatherRule: overrides.rule ?? RULE },
    ],
    rate: {
      estimate: { period: { start: "2026-09-28", end: "2026-10-28" } },
      verdicts: [{ check: "bill_recompute", accepted: true, reason: "Published tariff gives 131.36 USD, billed 131.36 USD (0.0% apart).", gapUsd: 0 }],
      possibleBillingErrorUsd: null,
    },
    change: {
      decomposition: null,
      verdicts: [{ check: "freshness", accepted: false, reason: HELD_REASON, gapUsd: 0 }],
      skipped: overrides.skipped === undefined ? HELD_REASON : overrides.skipped,
    },
    actions: {
      asOf: "2026-10-28",
      actions: [
        { id: "pipp_plus", status: "rejected", verdict: { check: "eligibility", accepted: false, reason: "61,000 USD a year is over the 37,870 USD limit for 2 people.", gapUsd: 0 } },
        { id: "winter_crisis", status: "rejected", verdict: { check: "eligibility", accepted: false, reason: "Not open yet: Winter Crisis Program takes applications from Nov 1.", gapUsd: 0 } },
      ],
      notProposed: [],
    },
  }) as unknown as Explanation;

const QUERIES = [
  { agent: "WeatherAnalyst", sql: "SELECT period_start FROM lightning.metastore.whysohigh.billing.bill_weather", zetarisQueryId: "3119eaaf-23d9-4e3b-b42a-2e88fabf51a2", rowCount: 5 },
  {
    agent: "ReconciliationCritic",
    sql: "SHOW DQ INVALID RECORD weather_covers_bill TABLE lightning.metastore.whysohigh.billing.bill_weather",
    zetarisQueryId: "37f37f57-5b3c-443e-80e5-11eb1ef7314e",
    rowCount: 1,
  },
];

describe("heldPayload", () => {
  it("keeps the bill, the weather coverage Zetaris gave and every verdict, in the order they ran", () => {
    const p = heldPayload(explanation(), MARCUS, { runId: "r1", sampleMode: false }, QUERIES);
    expect(p.bill).toEqual({ periodStart: "2026-09-28", periodEnd: "2026-10-28", days: 30, kwh: 671, totalUsd: 131.36 });
    expect(p.coverage).toEqual({ weatherDays: 25, days: 30, rule: RULE });
    expect(p.held).toBe(HELD_REASON);
    expect(p.checks.map((c) => [c.about, c.accepted])).toEqual([
      ["price", true],
      ["weather", false],
      ["PIPP Plus", false],
      ["Winter Crisis Program", false],
    ]);
    expect(p.queries).toHaveLength(2);
  });

  it("says nothing is held once NOAA covers every day", () => {
    const p = heldPayload(explanation({ skipped: null, rule: { ...RULE, passed: true } }), MARCUS, { runId: "r2", sampleMode: false }, []);
    expect(p.held).toBeNull();
    expect(p.coverage?.rule?.passed).toBe(true);
  });
});

describe("readQueries", () => {
  it("reads the statements of a run log with the ids Zetaris keeps", () => {
    const file = join(mkdtempSync(join(tmpdir(), "wsh-held-")), "run.jsonl");
    const lines = [
      { agent: "Orchestrator", step: "start" },
      { agent: "WeatherAnalyst", step: "sql", source: "live", zetarisQueryId: "3119eaaf-23d9-4e3b-b42a-2e88fabf51a2", sql: "SELECT 1", rowCount: 5, latencyMs: 9 },
      { agent: "RateAnalyst", step: "sql", source: "sample", sql: "SELECT 2", rowCount: 3, latencyMs: 1 },
    ];
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(readQueries(file)).toEqual([
      { agent: "WeatherAnalyst", sql: "SELECT 1", zetarisQueryId: "3119eaaf-23d9-4e3b-b42a-2e88fabf51a2", rowCount: 5 },
      { agent: "RateAnalyst", sql: "SELECT 2", zetarisQueryId: null, rowCount: 3 },
    ]);
  });
});

describe("the held bill on the page", () => {
  const page = heldView(heldPayload(explanation(), MARCUS, { runId: "r1", sampleMode: false }, QUERIES));

  it("says the bill is on hold, with the days NOAA has as the big number", () => {
    expect(page).toContain("Your October bill is on hold");
    expect(page).toMatch(/<span class="num">25<\/span>\s*<span class="of">of 30 days<\/span>/);
    expect(page).toContain("NOAA has published Columbus weather for 25 of this bill’s 30 days");
  });

  it("names the rule in Zetaris and the query that checked it", () => {
    expect(page).toContain("<code translate=\"no\">weather_covers_bill</code>");
    expect(page).toContain("<code translate=\"no\">weather_days = days</code>");
    expect(page).toContain("Zetaris query <code translate=\"no\">37f37f57</code>");
  });

  it("shows what was already checked in plain words, the price first", () => {
    expect(page).toContain("The bill matches the tariff");
    expect(page).toContain("AEP Ohio&#39;s price list gives $131.36 for this use, and the bill says $131.36 (0.0% apart).");
    expect(page).toContain("The daily weather records cover 25 of this bill&#39;s 30 days so far, so the data rule weather_covers_bill kept in Zetaris holds the split.");
    expect(page.indexOf("The bill matches the tariff")).toBeLessThan(page.indexOf("PIPP Plus"));
    expect(page).toContain("$61,000 a year is over the $37,870 limit for 2 people.");
    expect(page).toContain("$131.36");
  });

  it("says plainly when nothing is held any more", () => {
    const done = heldView(heldPayload(explanation({ skipped: null, rule: { ...RULE, passed: true } }), MARCUS, { runId: "r2", sampleMode: false }, QUERIES));
    expect(done).toContain("nothing is on hold");
    expect(done).not.toContain("is on hold</span>");
  });
});
