Read AGENTS.md first and follow it, with one exception to save tokens: do not read the two
docs/zetaris guides whole. In docs/zetaris/zetaris-lightning-sql-commands.md read only lines
1723 to 2067 (section 13, Unified Semantic Layer, and section 14, Data Quality). Open the
companion guide only to look up a specific error, by searching it. Keep exploration short:
DESCRIBE and LIMIT 5 samples only.

Goal: put each household's bills and the weather of their billing period in a Zetaris semantic
layer, with a data-quality rule that says when NOAA does not yet cover every day of a bill.

1. Explore read-only: the household database and the NOAA daily weather table.
2. Create the namespace lightning.metastore.whysohigh and compile a USL named billing with two
   tables, columns in this order:
   - household: household_id (primary key), city, noaa_station, household_size
   - bill_weather: bill_id (primary key), household_id (foreign key to household), period_start,
     period_end, days, kwh, weather_days, cdd, hdd
   bill_id is household_id and period_start joined by ':'. weather_days counts the days of the
   bill period that have both TMAX and TMIN. cdd and hdd are cooling and heating degree days,
   base 65 F, from the daily mean of TMAX and TMIN. A bill period includes period_start and
   excludes period_end.
3. Activate both tables over household_pg and noaa_ncei.
4. Register two data-quality rules on bill_weather: weather_covers_bill (weather_days = days)
   and billing_days_normal (days between 25 and 35). Run both and show the invalid records.
5. Check Linda's three bills (household linda): the app shows 297, 322.5 and 81.5 cooling
   degree days for them.
6. Save the statements that changed the instance, in order and with a comment each, to
   zetaris/billing_usl.sql.

Report what you created, the counts of each rule, and every invalid record with its reason.
