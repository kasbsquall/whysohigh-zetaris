import { describe, expect, it } from "vitest";
import { billWeatherSql, parseBillWeather } from "../src/zetaris/queries.ts";
import { isAlreadyRegistered, redactSecrets, sourceStatements } from "../src/zetaris/sources.ts";

const secrets = { openeiApiKey: "openei-key-123", eiaApiKey: "eia-key-456", householdDbPassword: "pg-pass-789" };

describe("sourceStatements", () => {
  const statements = sourceStatements(secrets);

  it("registers every source the analysts join", () => {
    expect(new Set(statements.map((s) => s.source))).toEqual(new Set(["noaa", "urdb", "eia", "household"]));
    expect(statements.find((s) => s.sql.includes("cmh_daily"))?.sql).toContain("endDate=2027-12-31");
  });

  it("puts the secrets in the SQL and redaction removes all of them", () => {
    const all = statements.map((s) => s.sql).join("\n");
    for (const value of Object.values(secrets)) expect(all).toContain(value);
    const shown = redactSecrets(all, secrets);
    for (const value of Object.values(secrets)) expect(shown).not.toContain(value);
  });

  it("percent-encodes the EIA brackets", () => {
    const eia = statements.find((s) => s.sql.includes("api.eia.gov"))?.sql ?? "";
    expect(eia).not.toMatch(/[[\]]/);
  });

  it("recognises a rerun", () => {
    expect(isAlreadyRegistered("Lightning Database NOAA_NCEI already exists")).toBe(true);
    expect(isAlreadyRegistered("REST API call failed: 429")).toBe(false);
  });
});

describe("billWeather", () => {
  it("joins bills with station days inside each period", () => {
    const sql = billWeatherSql("linda");
    expect(sql).toContain("FROM household_pg.bills b LEFT JOIN noaa_ncei.cmh_daily_from_2024 w");
    expect(sql).toContain("WHERE b.household_id = 'linda'");
  });

  it("rejects a household id that could break out of the string", () => {
    expect(() => billWeatherSql("x' OR '1'='1")).toThrow(/Invalid household id/);
  });

  it("parses rows and refuses non-numeric cells", () => {
    expect(parseBillWeather([["2026-08-14", "2026-09-16", "33", "1184.0", "33", "322.5", "1.5"]])).toEqual([
      { periodStart: "2026-08-14", periodEnd: "2026-09-16", days: 33, kwh: 1184, weatherDays: 33, cdd: 322.5, hdd: 1.5 },
    ]);
    expect(() => parseBillWeather([["a", "b", "x", "1", "1", "1", "1"]])).toThrow(/days/);
    expect(() => parseBillWeather([["2026-08-14", "2026-08-14", "0", "1", "0", "0", "0"]])).toThrow(/days must be above 0/);
  });
});
