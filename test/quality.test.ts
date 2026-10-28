import { describe, expect, it } from "vitest";
import { checkFreshness } from "../src/agents/critic.ts";
import type { Row, SqlClient } from "../src/zetaris/client.ts";
import { billWeatherSql, type BillWeather } from "../src/zetaris/queries.ts";
import { failingPeriods, findWeatherRule, householdBills, layersSql, rulesSql, uslBillWeatherSql, weatherFailuresSql } from "../src/zetaris/quality.ts";
import { plainCheck } from "../web/src/format.ts";

const LIST_DQ: readonly Row[] = [
  ["bill_id", "bill_weather", "Primary key constraints", ""],
  ["weather_covers_bill", "bill_weather", "Custom Data Quality", "weather_days = days"],
  ["billing_days_normal", "bill_weather", "Custom Data Quality", "days BETWEEN 25 AND 35"],
];
const BILLS: readonly Row[] = [
  ["2026-08-27", "2026-09-26", "30", "1010.0", "30", "201.5", "0.0"],
  ["2026-09-26", "2026-10-27", "31", "690.0", "26", "60.5", "75.0"],
];
const INVALID: readonly Row[] = [["marcus:2026-09-26", "marcus", "2026-09-26", "2026-10-27", "31", "690.0", "26", "60.5", "75.0"]];

/** Answers each statement from a table and records what was asked, by whom. */
function fakeSql(answers: ReadonlyMap<string, readonly Row[]>): SqlClient & { asked: [string, string][] } {
  const asked: [string, string][] = [];
  return {
    asked,
    async run(agent: string, sql: string): Promise<readonly Row[]> {
      asked.push([agent, sql]);
      const rows = answers.get(sql);
      if (!rows) throw new Error(`unexpected statement: ${sql}`);
      return rows;
    },
  };
}

describe("the semantic layer and its weather rule", () => {
  it("reads the bills through the layer and marks the ones Zetaris's rule rejects", async () => {
    const sql = fakeSql(
      new Map([
        [layersSql(), [["billing", "usl", "976", "2", ""]]],
        [uslBillWeatherSql("marcus"), BILLS],
        [rulesSql(), LIST_DQ],
        [weatherFailuresSql(), INVALID],
      ]),
    );
    const bills = await householdBills(sql, "WeatherAnalyst", "ReconciliationCritic", "marcus");
    expect(bills.map((b) => b.weatherRule)).toEqual([
      { name: "weather_covers_bill", expression: "weather_days = days", passed: true },
      { name: "weather_covers_bill", expression: "weather_days = days", passed: false },
    ]);
    expect(sql.asked.map(([agent]) => agent)).toEqual(["WeatherAnalyst", "WeatherAnalyst", "ReconciliationCritic", "ReconciliationCritic"]);
  });

  it("falls back to the plain federated join when the layer is not on the instance", async () => {
    const sql = fakeSql(new Map([[layersSql(), []], [billWeatherSql("linda"), BILLS]]));
    const bills = await householdBills(sql, "WeatherAnalyst", "ReconciliationCritic", "linda");
    expect(bills).toHaveLength(2);
    expect(bills.every((b) => b.weatherRule === undefined)).toBe(true);
  });

  it("finds the rule by name and refuses an invalid-record answer with the wrong shape", () => {
    expect(findWeatherRule(LIST_DQ)).toEqual({ name: "weather_covers_bill", expression: "weather_days = days" });
    expect(findWeatherRule(LIST_DQ.slice(0, 1))).toBeNull();
    expect([...failingPeriods(INVALID, "marcus")]).toEqual(["2026-09-26"]);
    expect([...failingPeriods(INVALID, "linda")]).toEqual([]);
    expect(() => failingPeriods([["{\"records\":[]}"]], "marcus")).toThrow(/1 columns/);
    const shuffled = [["marcus", "marcus:2026-09-26", "2026-09-26", "2026-10-27", "31", "690.0", "26", "60.5", "75.0"]];
    expect(() => failingPeriods(shuffled, "marcus")).toThrow(/expected order/);
  });
});

const bill = (periodStart: string, periodEnd: string, days: number, weatherDays: number, passed?: boolean): BillWeather => ({
  periodStart,
  periodEnd,
  days,
  kwh: 700,
  weatherDays,
  cdd: 50,
  hdd: 50,
  ...(passed === undefined ? {} : { weatherRule: { name: "weather_covers_bill", expression: "weather_days = days", passed } }),
});

describe("check 5 with Zetaris's weather rule", () => {
  it("cites the rule when it rejects a bill", () => {
    const v = checkFreshness([], [bill("2026-08-27", "2026-09-26", 30, 30, true), bill("2026-09-26", "2026-10-27", 31, 26, false)]);
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("Zetaris rule weather_covers_bill (weather_days = days) rejects the bill 2026-09-26 to 2026-10-27: NOAA has 26 of 31 days");
  });

  it("fails closed when its own count disagrees with a rule that passed", () => {
    const v = checkFreshness([], [bill("2026-09-26", "2026-10-27", 31, 26, true)]);
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("although Zetaris rule weather_covers_bill passed it");
  });

  it("says the rule confirmed the weather, and the page puts it in plain words", () => {
    const tariffless = checkFreshness([], [bill("2026-07-28", "2026-08-27", 30, 30, true), bill("2026-08-27", "2026-09-26", 30, 30, true)]);
    // Without tariffs the tariff part fails; the weather part is what this test reads.
    expect(tariffless.reason).not.toContain("NOAA has");
    const accepted = "Published tariff covers every day of the 2 bills compared, and Zetaris rule weather_covers_bill confirms NOAA weather for each.";
    expect(plainCheck(accepted)).toBe("The price list and the daily weather records cover every day of the 2 bills compared, and the data rule kept in Zetaris agrees.");
  });
});
