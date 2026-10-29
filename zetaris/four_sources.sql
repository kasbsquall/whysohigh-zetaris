-- One question, four sources: Linda's bills (household_pg, Postgres over JDBC), NOAA daily
-- weather (noaa_ncei, REST), Ohio average price from EIA (eia_api, REST) and the AEP Ohio
-- tariff from OpenEI URDB (openei_urdb, REST). Written with Claude Code on 28 Oct 2026.
WITH w AS (
  SELECT b.period_start, b.period_end, b.days, CAST(b.kwh AS DOUBLE) AS kwh, CAST(b.total_usd AS DOUBLE) AS total_usd,
    count(CAST(n.TMAX AS DOUBLE) + CAST(n.TMIN AS DOUBLE)) AS weather_days, round(sum(greatest((CAST(n.TMAX AS DOUBLE) + CAST(n.TMIN AS DOUBLE)) / 2 - 65, 0)), 1) AS cdd
  FROM household_pg.bills b LEFT JOIN noaa_ncei.cmh_daily_from_2024 n
    ON to_date(n.DATE) >= b.period_start AND to_date(n.DATE) < b.period_end
  WHERE b.household_id = 'linda'
  GROUP BY b.period_start, b.period_end, b.days, b.kwh, b.total_usd),
t AS (SELECT x.label, x.startdate, x.enddate FROM openei_urdb.aep_ohio_residential LATERAL VIEW explode(items) AS x
  WHERE x.name = 'Residential Service Bundled Ohio Power Rate Zone (RS)'),
p AS (SELECT d.period, CAST(d.price AS DOUBLE) AS price FROM eia_api.oh_res_monthly LATERAL VIEW explode(response.data) e AS d)
SELECT w.period_start, w.period_end, w.kwh, w.total_usd, round(100 * w.total_usd / w.kwh, 1) AS cents_per_kwh,
  p.period AS eia_month, p.price AS ohio_avg_cents, w.cdd, w.weather_days, w.days, t.label AS tariff_version
FROM w
LEFT JOIN p ON p.period = date_format(add_months(w.period_end, -2), 'yyyy-MM')
LEFT JOIN t ON t.startdate <= unix_timestamp(w.period_end) AND (t.enddate IS NULL OR t.enddate > unix_timestamp(w.period_end))
ORDER BY w.period_start
