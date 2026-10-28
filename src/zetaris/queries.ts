// Federated queries behind the analysts. Each joins the household's bills in
// Postgres with a public source, so every number traces to one SQL statement
// in the run log.

import type { Row, SqlClient } from "./client.ts";

export interface BillWeather {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: number;
  readonly kwh: number;
  /** Days of station data found inside the bill period. */
  readonly weatherDays: number;
  /** Cooling and heating degree days, base 65 F, from daily (TMAX + TMIN) / 2. */
  readonly cdd: number;
  readonly hdd: number;
  /** Zetaris's data-quality verdict on this bill's weather, when the bill came through the semantic layer (quality.ts). */
  readonly weatherRule?: WeatherRuleVerdict;
}

export interface WeatherRuleVerdict {
  readonly name: string;
  readonly expression: string;
  readonly passed: boolean;
}

const ID = /^[a-z0-9_-]+$/;

export function assertId(householdId: string): void {
  if (!ID.test(householdId)) throw new Error(`Invalid household id "${householdId}".`);
}

const mean = "(CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) / 2";

export function billWeatherSql(householdId: string): string {
  assertId(householdId);
  return (
    // A day counts only when both TMAX and TMIN are present (the sum is null otherwise).
    "SELECT b.period_start, b.period_end, b.days, CAST(b.kwh AS DOUBLE) AS kwh, " +
    "count(CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) AS weather_days, " +
    `coalesce(round(sum(greatest(${mean} - 65, 0)), 1), 0) AS cdd, coalesce(round(sum(greatest(65 - ${mean}, 0)), 1), 0) AS hdd ` +
    // LEFT JOIN keeps a bill with missing weather days, so the critic can see the gap.
    "FROM household_pg.bills b LEFT JOIN noaa_ncei.cmh_daily_from_2024 w " +
    "ON to_date(w.DATE) >= b.period_start AND to_date(w.DATE) < b.period_end " +
    `WHERE b.household_id = '${householdId}' ` +
    "GROUP BY b.period_start, b.period_end, b.days, b.kwh ORDER BY b.period_start"
  );
}

/** A bill the caller brings instead of one stored in the household database. */
export interface HistoryBill {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly kwh: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const daysBetween = (start: string, end: string): number => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;

function assertHistory(bills: readonly HistoryBill[]): void {
  if (bills.length === 0) throw new Error("The bill history is empty.");
  if (bills.length > 40) throw new Error(`The bill history has ${bills.length} bills; at most 40 go into one query.`);
  for (const b of bills) {
    const valid =
      ISO.test(b.periodStart) &&
      ISO.test(b.periodEnd) &&
      new Date(`${b.periodStart}T00:00:00Z`).toISOString().startsWith(b.periodStart) &&
      new Date(`${b.periodEnd}T00:00:00Z`).toISOString().startsWith(b.periodEnd) &&
      daysBetween(b.periodStart, b.periodEnd) > 0 &&
      // Bill periods are about a month; the cap also bounds the offline day loop.
      daysBetween(b.periodStart, b.periodEnd) <= 62 &&
      Number.isFinite(b.kwh) &&
      b.kwh >= 0;
    if (!valid) throw new Error(`Invalid bill in the history: ${JSON.stringify(b)}.`);
  }
}

/**
 * The same join as billWeatherSql, with the bills written into the statement as
 * an inline table, so a household that is not in the database still has its
 * bills joined with NOAA's weather by Zetaris in one query.
 */
export function billWeatherInlineSql(bills: readonly HistoryBill[]): string {
  assertHistory(bills);
  const rows = bills
    .map((b) => `(DATE '${b.periodStart}', DATE '${b.periodEnd}', ${daysBetween(b.periodStart, b.periodEnd)}, ${b.kwh})`)
    .join(", ");
  return (
    "SELECT b.period_start, b.period_end, b.days, CAST(b.kwh AS DOUBLE) AS kwh, " +
    "count(CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) AS weather_days, " +
    `coalesce(round(sum(greatest(${mean} - 65, 0)), 1), 0) AS cdd, coalesce(round(sum(greatest(65 - ${mean}, 0)), 1), 0) AS hdd ` +
    `FROM (VALUES ${rows}) AS b(period_start, period_end, days, kwh) ` +
    "LEFT JOIN noaa_ncei.cmh_daily_from_2024 w " +
    "ON to_date(w.DATE) >= b.period_start AND to_date(w.DATE) < b.period_end " +
    "GROUP BY b.period_start, b.period_end, b.days, b.kwh ORDER BY b.period_start"
  );
}

/** Daily TMAX and TMIN in F by ISO date, as NOAA_DAILY_SQL returns them. */
export type DailyWeather = ReadonlyMap<string, { readonly tmax: number | null; readonly tmin: number | null }>;

const cellNumber = (cell: string | undefined): number | null => {
  if (cell === undefined || cell === "") return null;
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
};

export function dailyWeather(rows: readonly Row[]): DailyWeather {
  return new Map(rows.map(([date, tmax, tmin]) => [date, { tmax: cellNumber(tmax), tmin: cellNumber(tmin) }]));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * What billWeatherInlineSql returns, computed from a saved copy of the NOAA
 * table. Used only in sample mode for a request that was never recorded.
 */
export function billWeatherOffline(bills: readonly HistoryBill[], weather: DailyWeather): readonly Row[] {
  assertHistory(bills);
  return [...bills]
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
    .map((b) => {
      let days = 0;
      let cdd = 0;
      let hdd = 0;
      for (let t = Date.parse(`${b.periodStart}T00:00:00Z`); t < Date.parse(`${b.periodEnd}T00:00:00Z`); t += DAY_MS) {
        const day = weather.get(new Date(t).toISOString().slice(0, 10));
        if (!day || day.tmax === null || day.tmin === null) continue;
        const dayMean = (day.tmax + day.tmin) / 2;
        days += 1;
        cdd += Math.max(dayMean - 65, 0);
        hdd += Math.max(65 - dayMean, 0);
      }
      return [b.periodStart, b.periodEnd, String(daysBetween(b.periodStart, b.periodEnd)), String(b.kwh), String(days), String(round1(cdd)), String(round1(hdd))];
    });
}

/** NOAA's daily temperatures for Columbus, as registered in Zetaris. */
export const NOAA_DAILY_SQL = "SELECT DATE, TMAX, TMIN FROM noaa_ncei.cmh_daily_from_2024 ORDER BY DATE";

const toNumber = (cell: string, column: string): number => {
  const value = Number(cell);
  if (cell === "" || !Number.isFinite(value)) throw new Error(`Column ${column} is not numeric: "${cell}".`);
  return value;
};

const positive = (value: number, column: string): number => {
  if (value <= 0) throw new Error(`Column ${column} must be above 0, got ${value}.`);
  return value;
};

export function parseBillWeather(rows: readonly Row[]): readonly BillWeather[] {
  return rows.map((row) => ({
    periodStart: row[0],
    periodEnd: row[1],
    days: positive(toNumber(row[2], "days"), "days"),
    kwh: toNumber(row[3], "kwh"),
    weatherDays: toNumber(row[4], "weather_days"),
    cdd: toNumber(row[5], "cdd"),
    hdd: toNumber(row[6], "hdd"),
  }));
}

/** AEP Ohio's bundled residential tariff (rate RS), every version URDB holds. */
export const RS_BUNDLED = "Residential Service Bundled Ohio Power Rate Zone (RS)";

export function tariffsSql(name: string = RS_BUNDLED): string {
  if (/['\\]/.test(name)) throw new Error(`Invalid tariff name "${name}".`);
  return (
    "SELECT t.label, t.name, t.startdate, t.enddate, t.approved, t.fixedchargefirstmeter, t.fixedchargeunits, " +
    "to_json(t.energyratestructure), to_json(t.energyweekdayschedule[0]), to_json(t.energyweekendschedule[0]) " +
    "FROM openei_urdb.aep_ohio_residential LATERAL VIEW explode(items) AS t " +
    `WHERE t.name = '${name}' ORDER BY t.startdate`
  );
}

export async function billWeather(sql: SqlClient, agent: string, householdId: string): Promise<readonly BillWeather[]> {
  return parseBillWeather(await sql.run(agent, billWeatherSql(householdId)));
}

/** Bills brought by the caller, joined with NOAA by Zetaris; in sample mode, by the saved NOAA copy when not recorded. */
export async function billWeatherFor(
  sql: SqlClient,
  agent: string,
  bills: readonly HistoryBill[],
  weatherSnapshot: () => DailyWeather,
): Promise<readonly BillWeather[]> {
  return parseBillWeather(await sql.run(agent, billWeatherInlineSql(bills), 1000, () => billWeatherOffline(bills, weatherSnapshot())));
}
