// The household's bills through the semantic layer in Zetaris, with Zetaris's own
// verdict on whether NOAA covers every day of each bill. The layer,
// lightning.metastore.whysohigh.billing, holds two tables (household, and
// bill_weather: the bills joined with NOAA daily weather) and the data-quality
// rule weather_covers_bill. When the layer is not on this instance, the bills come
// from the plain federated join in queries.ts and the checker counts the weather
// days itself (critic check 5).

import type { Row, SqlClient } from "./client.ts";
import { assertId, billWeather, parseBillWeather, type BillWeather } from "./queries.ts";

export const BILLING_NAMESPACE = "lightning.metastore.whysohigh";
export const BILLING_USL = `${BILLING_NAMESPACE}.billing`;
export const BILL_WEATHER = `${BILLING_USL}.bill_weather`;
export const WEATHER_RULE = "weather_covers_bill";

/** The semantic layers in the namespace; a namespace that does not exist gives no rows. */
export const layersSql = (): string => `SHOW NAMESPACES OR TABLES IN ${BILLING_NAMESPACE}`;
/** Key constraints and data-quality rules of the billing layer: name, table, kind, expression. */
export const rulesSql = (): string => `LIST DQ USL ${BILLING_USL}`;
/** Every bill the weather rule rejects, with all the columns of bill_weather. */
export const weatherFailuresSql = (): string => `SHOW DQ INVALID RECORD ${WEATHER_RULE} TABLE ${BILL_WEATHER}`;

export function uslBillWeatherSql(householdId: string): string {
  assertId(householdId);
  return (
    "SELECT period_start, period_end, days, kwh, weather_days, cdd, hdd " +
    `FROM ${BILL_WEATHER} WHERE household_id = '${householdId}' ORDER BY period_start`
  );
}

// bill_weather's columns, in the order the layer defines them:
// bill_id, household_id, period_start, period_end, days, kwh, weather_days, cdd, hdd.
const BILL_WEATHER_COLUMNS = 9;
const HOUSEHOLD_COLUMN = 1;
const PERIOD_START_COLUMN = 2;

/** The weather rule as LIST DQ USL reports it, or null when it is not registered. */
export function findWeatherRule(rows: readonly Row[]): { readonly name: string; readonly expression: string } | null {
  const row = rows.find((r) => r[0] === WEATHER_RULE && r[1] === "bill_weather");
  return row ? { name: WEATHER_RULE, expression: row[3] ?? "" } : null;
}

/** Period starts of this household's bills that the rule rejects. */
export function failingPeriods(rows: readonly Row[], householdId: string): ReadonlySet<string> {
  const odd = rows.find((r) => r.length !== BILL_WEATHER_COLUMNS);
  if (odd) throw new Error(`SHOW DQ INVALID RECORD returned ${odd.length} columns; bill_weather has ${BILL_WEATHER_COLUMNS}.`);
  // bill_id is household_id:period_start, which also confirms the column order.
  const shuffled = rows.find((r) => r[0] !== `${r[HOUSEHOLD_COLUMN]}:${r[PERIOD_START_COLUMN]}`);
  if (shuffled) throw new Error(`bill_weather's columns are not in the expected order: bill_id ${shuffled[0]}.`);
  return new Set(rows.filter((r) => r[HOUSEHOLD_COLUMN] === householdId).map((r) => r[PERIOD_START_COLUMN]));
}

/**
 * The household's bills with their weather. reader reads them; checker asks
 * Zetaris which of them the weather rule rejects, so check 5 can cite it.
 */
export async function householdBills(sql: SqlClient, reader: string, checker: string, householdId: string): Promise<readonly BillWeather[]> {
  // A recording made before the layer existed has no answer for this statement:
  // no rows means no layer, so sample mode replays the plain join it recorded.
  const layers = await sql.run(reader, layersSql(), 50, () => []);
  if (!layers.some((r) => r[0] === "billing" && r[1] === "usl")) return billWeather(sql, reader, householdId);
  const bills = parseBillWeather(await sql.run(reader, uslBillWeatherSql(householdId)));
  const rule = findWeatherRule(await sql.run(checker, rulesSql()));
  if (!rule) return bills;
  const failing = failingPeriods(await sql.run(checker, weatherFailuresSql()), householdId);
  return bills.map((b) => ({ ...b, weatherRule: { ...rule, passed: !failing.has(b.periodStart) } }));
}
