import { describe, expect, it } from "vitest";
import { isDestructive, splitStatements } from "../src/zetaris/statements.ts";

describe("splitting a SQL file for Zetaris", () => {
  it("splits on semicolons outside quotes and drops comments", () => {
    const text = "-- first\nSELECT 'a;b' AS x;\n/* two\nlines */ SHOW LIGHTNING DATABASES;\n\n";
    expect(splitStatements(text)).toEqual(["SELECT 'a;b' AS x", "SHOW LIGHTNING DATABASES"]);
  });

  it("keeps a multi-table COMPILE USL whole and splits what follows it", () => {
    const text = [
      "COMPILE USL billing DEPLOY NAMESPACE lightning.metastore.whysohigh DDL",
      "CREATE TABLE household (household_id varchar(64) NOT NULL PRIMARY KEY);",
      "CREATE TABLE bill_weather (bill_id varchar(96) NOT NULL PRIMARY KEY);",
      "ACTIVATE USL TABLE lightning.metastore.whysohigh.billing.household AS SELECT 1",
    ].join("\n");
    const statements = splitStatements(text);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^COMPILE USL billing[\s\S]*CREATE TABLE household[\s\S]*;\nCREATE TABLE bill_weather/);
    expect(statements[1]).toMatch(/^ACTIVATE USL TABLE/);
  });

  it("flags statements that remove something or change access", () => {
    expect(isDestructive("  drop table x")).toBe(true);
    expect(isDestructive("REMOVE USL billing NAMESPACE lightning.metastore.whysohigh")).toBe(true);
    expect(isDestructive("REGISTER DQ weather_covers_bill TABLE t AS weather_days = days")).toBe(false);
    expect(isDestructive("SELECT 'drop' AS word")).toBe(false);
  });
});
