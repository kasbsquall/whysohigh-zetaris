# Agent instructions

Why So High explains why a household's electricity bill changed. Its agents read the
household's bills from Postgres and three public sources (NOAA daily weather, AEP Ohio's
tariff from the OpenEI Utility Rate Database, and Ohio's average price from EIA) through
Zetaris Lightning, running on this computer. You are acting as a data engineer on this
repo against that Zetaris instance.

These rules adapt the `AGENTS.md` of [zetaris/getting-started](https://github.com/zetaris/getting-started)
(Apache-2.0) to this repo. Its SQL guides are copied, unchanged, in `docs/zetaris/`.

## Connect first

- The connection lives in `.env`. Never open, print, copy or log `.env` or any value in it;
  `npm run zsql` reads it for you.
- One statement: `npm run zsql -- "SELECT 1"`. A file: `npm run zsql -- --file <path>`, after
  `--dry-run` to list its statements without running them.
- Each statement prints its columns and rows, how long it took, and the query id Zetaris
  keeps in its query history. It is also logged to `logs/`.
- Before your task, confirm the connection with `SELECT 1` and `SHOW LIGHTNING DATABASES`, and
  report a short pass or fail.

## What this instance holds

| Source | How Zetaris reaches it | Tables |
|---|---|---|
| `household_pg` | Postgres over JDBC | `households`, `bills`, `decisions` |
| `noaa_ncei` | REST, NOAA daily summaries for Columbus airport (station USW00014821) | `cmh_daily_from_2024` |
| `openei_urdb` | REST, OpenEI Utility Rate Database | `aep_ohio_residential` |
| `eia_api` | REST, EIA retail sales | `oh_res_monthly` |

`SHOW DATASOURCES` lists `household_pg` but not the REST tables; use `SHOW LIGHTNING DATABASES`
and `SHOW TABLES IN <database>` for those. Inspect before you write: `DESCRIBE` and small
`SELECT ... LIMIT 5` samples. How the sources were registered is in `src/zetaris/sources.ts`,
and the queries the app runs today are in `src/zetaris/`.

## Writing SQL

- Zetaris Lightning SQL only. Not Spark SQL or Hive SQL, and never start a local Spark session.
- One statement per call, no trailing semicolon, qualified names (`<source>.<table>`). A file
  may hold several statements separated by `;`. `zsql` splits them and keeps a multi-table
  `COMPILE USL ... DDL` whole, as it must be sent.
- **USL:** `lightning.metastore` must exist before `CREATE NAMESPACE IF NOT EXISTS lightning.metastore.<name>`
  works; check with `SHOW NAMESPACES OR TABLES IN lightning.metastore`.
- Read `docs/zetaris/zetaris-lightning-sql-commands.md` for syntax (USL in section 13,
  data-quality rules in section 14) and `docs/zetaris/zetaris-lightning-sql-companion.md` for
  confirmed gotchas and limits before writing new SQL.

## Safety

- Start read-only (`SHOW`, `DESCRIBE`, `SELECT`). Create only what your task names.
- Never drop, remove, delete, grant or revoke unless your task says so. `zsql` refuses those
  statements without `--allow-destructive`.
- Keep passwords and keys out of prompts, logs, source files and commits.
- Do not call port 8889 on the local instance.
- Do not change `src/`, `test/`, `web/` or `infra/` unless your task asks for it. Save the SQL
  you write under `zetaris/`, one file per piece of work, with a comment on each statement.
- When you finish, list every statement that changed the instance and how you checked the result.
