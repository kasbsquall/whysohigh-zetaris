// Registers the Zetaris sources once per machine. Safe to rerun: statements
// for sources that already exist are reported and skipped.
//   npm run setup:sources

import { loadConfig, loadDotEnv } from "../src/config.ts";
import { createZetarisRest } from "../src/zetaris/client.ts";
import { isAlreadyRegistered, redactSecrets, sourceStatements, type SourceSecrets } from "../src/zetaris/sources.ts";

loadDotEnv();
const config = loadConfig({ ...process.env, SAMPLE_MODE: "false" });

const householdDbPassword = process.env.HOUSEHOLD_DB_PASSWORD?.trim();
if (!householdDbPassword) {
  process.stderr.write("Set HOUSEHOLD_DB_PASSWORD in .env (the same value infra/household-db uses).\n");
  process.exit(2);
}
const secrets: SourceSecrets = {
  // DEMO_KEY works but is rate limited per IP; a free key from api.data.gov avoids HTTP 429.
  // EIA's API takes the same api.data.gov keys, so it falls back to the OpenEI one.
  openeiApiKey: process.env.OPENEI_API_KEY?.trim() || "DEMO_KEY",
  eiaApiKey: process.env.EIA_API_KEY?.trim() || process.env.OPENEI_API_KEY?.trim() || "DEMO_KEY",
  householdDbPassword,
};

const zetaris = createZetarisRest(config.zetaris);
let failed = 0;

for (const { source, sql } of sourceStatements(secrets)) {
  const shown = redactSecrets(sql, secrets).slice(0, 140);
  try {
    await zetaris.run(sql);
    process.stdout.write(`OK      ${source}: ${shown}\n`);
  } catch (error: unknown) {
    const message = redactSecrets((error as Error).message, secrets);
    if (isAlreadyRegistered(message)) {
      process.stdout.write(`EXISTS  ${source}: ${shown}\n`);
    } else {
      failed += 1;
      process.stdout.write(`FAIL    ${source}: ${shown}\n        ${message.slice(0, 300)}\n`);
    }
  }
}
process.exitCode = failed === 0 ? 0 : 1;
