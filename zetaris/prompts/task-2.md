Read AGENTS.md first and follow it. Read-only: change nothing in Zetaris.

Write one SELECT that, for each of Linda's bills, returns the billing period, kWh, the total
paid, the price paid in cents per kWh, Ohio's average residential price from EIA for the latest
month published on or before the bill's month, the cooling degree days of the period from NOAA,
and the AEP Ohio residential tariff version (OpenEI URDB, rate RS) in effect on the bill's end
date. The statement must read household_pg, noaa_ncei, eia_api and openei_urdb.

Run it, check one number of each source against a separate query, and save it to
zetaris/four_sources.sql with a comment that explains each join.
