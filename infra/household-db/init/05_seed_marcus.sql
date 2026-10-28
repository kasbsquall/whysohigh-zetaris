-- Marcus: a second illustrative household, synthetic like Linda. The latest bill
-- closed on 28 Oct 2026, a few days before NOAA publishes the last days of that
-- period, so it shows what the checker does when the weather is not complete yet.
-- Each total is AEP Ohio's published tariff (rate RS) for that kWh, as RateAnalyst
-- computes it, so the price check passes and the weather check is the one that holds.

INSERT INTO households VALUES
  ('marcus', 'Marcus', 'Columbus, OH', 14006, 'USW00014821', 2, 61000, false, true);

INSERT INTO bills VALUES
  ('marcus', '2026-05-28', '2026-06-26', 29, 880, 166.42, 'synthetic, published tariff'),
  ('marcus', '2026-06-26', '2026-07-28', 32, 1190, 218.43, 'synthetic, published tariff'),
  ('marcus', '2026-07-28', '2026-08-27', 30, 1236, 226.15, 'synthetic, published tariff'),
  ('marcus', '2026-08-27', '2026-09-28', 32, 1041, 193.43, 'synthetic, published tariff'),
  ('marcus', '2026-09-28', '2026-10-28', 30, 671, 131.36, 'synthetic, published tariff');
