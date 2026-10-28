import { describe, expect, it } from "vitest";
import { statementRow } from "../web/src/live.ts";

const JOIN = "SELECT b.kwh FROM household_pg.bills b LEFT JOIN noaa_ncei.cmh_daily_from_2024 w ON to_date(w.DATE) >= b.period_start";

describe("the live list of Zetaris queries", () => {
  it("names the agent, the sources a statement reads and the id Zetaris keeps for it", () => {
    const html = statementRow(
      { agent: "WeatherAnalyst", step: "sql", source: "live", zetarisQueryId: "1a2b3c4d-0000-4000-8000-000000000000", sql: JOIN, rowCount: 3, latencyMs: 1815 },
      2300,
    );
    expect(html).toContain("Weather check");
    expect(html).toContain("Your bills, Postgres");
    expect(html).toContain("NOAA daily weather, REST");
    expect(html).toContain("+2.3 s");
    expect(html).toContain("1.8 s");
    expect(html).toContain("Zetaris query <code translate=\"no\">1a2b3c4d</code>");
    expect(html).toContain("query id 1a2b3c4d-0000-4000-8000-000000000000");
  });

  it("says the write-back goes to the saved decisions, in plain words", () => {
    const html = statementRow({ agent: "Orchestrator", step: "sql", source: "live", sql: "INSERT INTO household_pg.decisions VALUES ('x')", rowCount: 0, latencyMs: 400 }, 100);
    expect(html).toContain("Saving the result");
    expect(html).toContain("Writes to");
    expect(html).toContain("Saved decisions, Postgres");
    expect(html).not.toContain("Your bills, Postgres");
    expect(html).not.toContain("Orchestrator");
  });

  it("marks replayed statements as replayed and escapes the SQL", () => {
    const html = statementRow({ agent: "RateAnalyst", step: "sql", source: "sample", sql: "SELECT '<b>' FROM openei_urdb.aep_ohio_residential", rowCount: 1, latencyMs: 2 }, 0);
    expect(html).toContain("replayed from a recorded run");
    expect(html).toContain("1 row<br>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>'");
  });

  it("calls a data-quality statement a check of the rule in Zetaris", () => {
    const html = statementRow(
      { agent: "ReconciliationCritic", step: "sql", source: "live", sql: "SHOW DQ INVALID RECORD weather_covers_bill TABLE lightning.metastore.whysohigh.billing.bill_weather", rowCount: 1, latencyMs: 3271 },
      0,
    );
    expect(html).toContain("The checker");
    expect(html).toContain("Checks");
    expect(html).toContain("Data-quality rule in Zetaris");
    expect(html).not.toContain("Semantic layer in Zetaris");
  });

  it("shows a retry as a statement Zetaris turned down once", () => {
    expect(statementRow({ agent: "WeatherAnalyst", step: "sql_retry", reason: "HTTP 400" }, 0)).toContain("turned this statement down once");
  });
});
