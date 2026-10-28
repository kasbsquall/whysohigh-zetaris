// Marcus, the page's second sample household. His latest bill closed on 28 Oct 2026 before
// NOAA had published every day of it, so the data-quality rule in Zetaris
// (weather_covers_bill) holds the split back while the price and help programs are still
// checked. The server runs it once per process, like Linda's demo.

import { readFileSync } from "node:fs";
import { parseHouseholdFacts, PROGRAMS } from "./actions/programs.ts";
import type { Bill } from "./agents/billReader.ts";
import type { Household } from "./demo.ts";
import { parseRunInput } from "./input.ts";
import { explain, ORCHESTRATOR, type Explanation } from "./pipeline.ts";
import type { Runtime } from "./runtime.ts";
import type { WeatherRuleVerdict } from "./zetaris/queries.ts";

export const HELD_HOUSEHOLD = "marcus";
const HELD_BILL = "samples/marcus-2026-10.json";
const HELD_FACTS = "samples/marcus.json";

/** One verdict of the run, with what it was about in the page's words. */
export interface HeldCheck {
  readonly about: string;
  readonly check: string;
  readonly accepted: boolean;
  readonly reason: string;
}

/** One statement the run sent to Zetaris; the id is null when it was replayed (sample mode). */
export interface HeldQuery {
  readonly agent: string;
  readonly sql: string;
  readonly zetarisQueryId: string | null;
  readonly rowCount: number;
}

export interface HeldPayload {
  readonly household: Household;
  readonly runId: string;
  readonly sampleMode: boolean;
  readonly bill: { readonly periodStart: string; readonly periodEnd: string; readonly days: number; readonly kwh: number; readonly totalUsd: number };
  /** Days of NOAA weather inside the bill and the rule's verdict on them, as Zetaris gave them. */
  readonly coverage: { readonly weatherDays: number; readonly days: number; readonly rule: WeatherRuleVerdict | null } | null;
  /** Why the change was not split; null when it was, so nothing is held. */
  readonly held: string | null;
  readonly checks: readonly HeldCheck[];
  readonly queries: readonly HeldQuery[];
}

/** The page's view of one run of Marcus's latest bill. */
export function heldPayload(e: Explanation, household: Household, run: { readonly runId: string; readonly sampleMode: boolean }, queries: readonly HeldQuery[]): HeldPayload {
  const { start, end } = e.rate.estimate.period;
  const current = e.history.find((b) => b.periodStart === start);
  const verdict = (about: string) => (v: { readonly check: string; readonly accepted: boolean; readonly reason: string }): HeldCheck => ({
    about,
    check: v.check,
    accepted: v.accepted,
    reason: v.reason,
  });
  return {
    household,
    runId: run.runId,
    sampleMode: run.sampleMode,
    bill: { periodStart: start, periodEnd: end, days: e.bill.days, kwh: e.bill.kwh, totalUsd: e.bill.totalUsd },
    coverage: current ? { weatherDays: current.weatherDays, days: current.days, rule: current.weatherRule ?? null } : null,
    held: e.change.skipped,
    checks: [
      ...e.rate.verdicts.map(verdict("price")),
      ...e.change.verdicts.map(verdict("weather")),
      ...e.actions.actions.flatMap((a) => (a.verdict ? [verdict(PROGRAMS[a.id].name)(a.verdict)] : [])),
    ],
    queries,
  };
}

/** The statements in a run's log, in the order they were sent. */
export function readQueries(logFile: string): readonly HeldQuery[] {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.step === "sql")
    .map((e) => ({
      agent: String(e.agent),
      sql: String(e.sql),
      zetarisQueryId: typeof e.zetarisQueryId === "string" ? e.zetarisQueryId : null,
      rowCount: Number(e.rowCount ?? 0),
    }));
}

const householdOf = (raw: Household): Household => ({
  id: raw.id,
  name: raw.name,
  city: raw.city,
  utility: raw.utility,
  householdSize: raw.householdSize,
  annualIncomeUsd: raw.annualIncomeUsd,
  electricHeat: raw.electricHeat,
});

/** Runs Marcus's latest bill from its printed fields; the caller owns the runtime, so it knows the run id first. */
export async function runHeld(runtime: Runtime): Promise<HeldPayload> {
  const { logger } = runtime;
  const raw = JSON.parse(readFileSync(HELD_FACTS, "utf8")) as Household;
  const fields = (parseRunInput({ bill: { fields: JSON.parse(readFileSync(HELD_BILL, "utf8")) as unknown } }).bill as { fields: Bill }).fields;
  logger.log({ agent: ORCHESTRATOR, step: "start", household: HELD_HOUSEHOLD, sampleMode: runtime.config.sampleMode, bill: HELD_BILL });
  const explanation = await explain(runtime, fields, { householdId: HELD_HOUSEHOLD, memoryDir: null, facts: parseHouseholdFacts(raw), recordDecision: true });
  logger.log({ agent: ORCHESTRATOR, step: "done", logFile: logger.file });
  return heldPayload(explanation, householdOf(raw), { runId: logger.runId, sampleMode: runtime.config.sampleMode }, readQueries(logger.file));
}
