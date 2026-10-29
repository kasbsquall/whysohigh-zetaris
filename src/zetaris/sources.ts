// The data sources Zetaris federates for Why So High, as Lightning SQL.
// Public REST APIs are queried in place; the household history lives in its
// own Postgres and is registered over JDBC. Keys and passwords are injected
// from the environment and redacted before any statement is logged.

export interface SourceStatement {
  readonly source: string;
  readonly sql: string;
}

export interface SourceSecrets {
  readonly openeiApiKey: string;
  readonly eiaApiKey: string;
  readonly householdDbPassword: string;
}

/** AEP Ohio (Ohio Power) in EIA Form 861 and OpenEI URDB. */
export const AEP_OHIO_EIAID = 14006;
/** NOAA GHCN-Daily id of John Glenn Columbus International Airport. */
export const CMH_STATION = "USW00014821";
// From 2024 so the evaluation households have a year of history before each tariff version.
const WEATHER_START = "2024-01-01";
// A date ahead of today: NOAA returns every day published so far. Registering with the day of
// registration froze the table at 2026-10-22.
const WEATHER_END = "2027-12-31";

const rest = (table: string, db: string, endpoint: string): string =>
  `CREATE LIGHTNING REST TABLE ${table} FROM ${db} REQUEST(endpoint "${endpoint}", ` +
  `method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`;

export function sourceStatements(secrets: SourceSecrets): readonly SourceStatement[] {
  const noaa =
    "https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries" +
    `&stations=${CMH_STATION}&startDate=${WEATHER_START}&endDate=${WEATHER_END}&dataTypes=TMAX,TMIN&units=standard&format=json`;
  const urdb =
    `https://api.openei.org/utility_rates?version=8&format=json&api_key=${secrets.openeiApiKey}` +
    `&eia=${AEP_OHIO_EIAID}&sector=Residential&detail=full&limit=20&orderby=startdate&direction=desc`;
  // Brackets are percent-encoded: Zetaris passes the endpoint through as is.
  const eia =
    `https://api.eia.gov/v2/electricity/retail-sales/data/?api_key=${secrets.eiaApiKey}&frequency=monthly` +
    "&data%5B0%5D=price&data%5B1%5D=sales&facets%5Bstateid%5D%5B%5D=OH&facets%5Bsectorid%5D%5B%5D=RES" +
    "&start=2024-01&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=asc";

  return [
    { source: "noaa", sql: 'CREATE LIGHTNING DATABASE NOAA_NCEI DESCRIBE BY "NOAA NCEI Access Data Service, daily summaries"' },
    { source: "noaa", sql: rest("cmh_daily_from_2024", "NOAA_NCEI", noaa) },
    { source: "urdb", sql: 'CREATE LIGHTNING DATABASE OPENEI_URDB DESCRIBE BY "OpenEI Utility Rate Database"' },
    { source: "urdb", sql: rest("aep_ohio_residential", "OPENEI_URDB", urdb) },
    { source: "urdb", sql: "CACHE TABLE openei_urdb.aep_ohio_residential" },
    { source: "eia", sql: 'CREATE LIGHTNING DATABASE EIA_API DESCRIBE BY "EIA Open Data API v2"' },
    { source: "eia", sql: rest("oh_res_monthly", "EIA_API", eia) },
    { source: "eia", sql: "CACHE TABLE eia_api.oh_res_monthly" },
    {
      source: "household",
      sql:
        'CREATE DATASOURCE household_pg DESCRIBE BY "Why So High household history, synthetic" OPTIONS (' +
        'jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://household-db:5432/household", ' +
        `username "whysohigh", password "${secrets.householdDbPassword}", fetchsize "1000")`,
    },
    { source: "household", sql: 'REGISTER DATASOURCE TABLE "households" FROM household_pg' },
    { source: "household", sql: 'REGISTER DATASOURCE TABLE "bills" FROM household_pg' },
    { source: "household", sql: 'REGISTER DATASOURCE TABLE "decisions" FROM household_pg' },
  ];
}

/** Replaces every secret value with [redacted]; empty values are ignored. */
export function redactSecrets(text: string, secrets: SourceSecrets): string {
  return Object.values(secrets)
    .filter((value) => value.length >= 6)
    .reduce((out, value) => out.replaceAll(value, "[redacted]"), text);
}

/** Zetaris has no IF NOT EXISTS for these commands; a rerun meets these errors. */
export const isAlreadyRegistered = (message: string): boolean => /already exist|duplicate/i.test(message);
