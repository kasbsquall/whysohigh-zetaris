-- Namespace for the Why So High billing semantic layer.
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.whysohigh;

-- Households and their bills with NOAA degree days for each billing period.
-- A bill period includes period_start and excludes period_end. bill_id is household_id:period_start.
COMPILE USL billing DEPLOY NAMESPACE lightning.metastore.whysohigh DDL
CREATE TABLE household (
  household_id varchar(64) NOT NULL PRIMARY KEY,
  city varchar(64),
  noaa_station varchar(32),
  household_size int
);

CREATE TABLE bill_weather (
  bill_id varchar(96) NOT NULL PRIMARY KEY,
  household_id varchar(64) FOREIGN KEY REFERENCES household(household_id),
  period_start date,
  period_end date,
  days int,
  kwh double,
  weather_days int,
  cdd double,
  hdd double
);

-- One row per household from Postgres.
ACTIVATE USL TABLE lightning.metastore.whysohigh.billing.household AS
SELECT COALESCE(household_id, '') AS household_id, city, noaa_station, household_size
FROM household_pg.households;

-- Bills left-joined to Columbus daily weather. weather_days counts days with both TMAX and TMIN.
-- cdd and hdd are base-65 F degree days from the daily mean of TMAX and TMIN.
ACTIVATE USL TABLE lightning.metastore.whysohigh.billing.bill_weather AS
SELECT COALESCE(concat(b.household_id, ':', CAST(b.period_start AS STRING)), '') AS bill_id,
  b.household_id,
  b.period_start,
  b.period_end,
  b.days,
  CAST(b.kwh AS DOUBLE) AS kwh,
  CAST(count(CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) AS INT) AS weather_days,
  CAST(coalesce(round(sum(greatest((CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) / 2 - 65, 0)), 1), 0) AS DOUBLE) AS cdd,
  CAST(coalesce(round(sum(greatest(65 - (CAST(w.TMAX AS DOUBLE) + CAST(w.TMIN AS DOUBLE)) / 2, 0)), 1), 0) AS DOUBLE) AS hdd
FROM household_pg.bills b
LEFT JOIN noaa_ncei.cmh_daily_from_2024 w
  ON to_date(w.DATE) >= b.period_start AND to_date(w.DATE) < b.period_end
GROUP BY b.household_id, b.period_start, b.period_end, b.days, b.kwh;

-- NOAA covers every day of the bill when the counted weather days equal the bill length.
REGISTER DQ weather_covers_bill TABLE lightning.metastore.whysohigh.billing.bill_weather AS
weather_days = days;

-- A normal residential billing period is 25 to 35 days.
REGISTER DQ billing_days_normal TABLE lightning.metastore.whysohigh.billing.bill_weather AS
days BETWEEN 25 AND 35;
