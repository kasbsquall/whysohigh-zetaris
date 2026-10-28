// Orchestration of one explanation run. Agents hand their work to the critic,
// and a rejection sends the work back with the reason instead of going on.

import { PROGRAMS, type HouseholdFacts, type ProgramId } from "./actions/programs.ts";
import { planActions, type ActionPlan } from "./agents/actionPlanner.ts";
import { readBill, type Bill } from "./agents/billReader.ts";
import { checkRecompute, logVerdict, type Verdict } from "./agents/critic.ts";
import { explainInWords, weatherWord, type Explained } from "./agents/explainer.ts";
import {
  estimateBill,
  loadTariffs,
  logEstimate,
  priceEffect,
  type RateEstimate,
  type RateStrategy,
} from "./agents/rateAnalyst.ts";
import { join } from "node:path";
import { analyzeChange, type ChangeResult } from "./changeAnalysis.ts";
import { openHouseholdGraph, previousDiagnosis, recordActionPlan, recordRun, type PreviousDiagnosis } from "./memory/householdGraph.ts";
import {
  actionsTaken,
  notesAbout,
  oneOffPeriods,
  openHouseholdMemory,
  rememberDiagnosis,
  type RecalledNote,
} from "./memory/householdMemory.ts";
import type { Runtime } from "./runtime.ts";
import type { BillPeriod, Tariff } from "./tariff/tariff.ts";
import { historyForBill, noaaSnapshot } from "./input.ts";
import { billWeatherFor, type BillWeather, type HistoryBill } from "./zetaris/queries.ts";
import { householdBills } from "./zetaris/quality.ts";
import { recordDecision, type RecordedDecision } from "./zetaris/decisions.ts";
import { ohioPrice, type StatePrice } from "./zetaris/statePrice.ts";
import { componentUsd } from "./agents/usageAnalyst.ts";

export const ORCHESTRATOR = "Orchestrator";

export interface RateResult {
  readonly estimate: RateEstimate;
  readonly verdicts: readonly Verdict[];
  readonly closed: boolean;
  /** Set when no strategy closes the bill: billed minus tariff, positive when billed above the tariff. */
  readonly possibleBillingErrorUsd: number | null;
  readonly priceEffectUsd: number | null;
}

export interface MemoryUsed {
  /** What the household told us about the previous bill. */
  readonly notes: readonly RecalledNote[];
  /** What the run for the previous bill concluded, read from the household graph. */
  readonly previousDiagnosis: PreviousDiagnosis | null;
}

export interface Explanation {
  readonly bill: Bill;
  readonly history: readonly BillWeather[];
  readonly rate: RateResult;
  readonly change: ChangeResult;
  /** ActionPlanner's proposals, each judged by critic check 4. */
  readonly actions: ActionPlan;
  /** The Explainer's sentences after critic check 6; null when the change was not split. */
  readonly words: Explained | null;
  readonly memory: MemoryUsed | null;
  /** The decision written back to the household database through Zetaris; null when not asked for. */
  readonly recorded: RecordedDecision | null;
  /** Ohio's average residential price from EIA for the bill's month, next to this bill's. */
  readonly ohio: StatePrice | null;
}

const STRATEGIES: readonly RateStrategy[] = ["period_end", "prorated"];

/** MM/DD/YYYY to YYYY-MM-DD. */
export const isoDate = (printed: string): string => {
  const [m, d, y] = printed.split("/");
  return `${y}-${m}-${d}`;
};

export function analyzeRate(
  runtime: Runtime,
  tariffs: readonly Tariff[],
  bill: Bill,
  history: readonly BillWeather[],
): RateResult {
  const { logger } = runtime;
  const period: BillPeriod = { start: isoDate(bill.periodStart), end: isoDate(bill.periodEnd) };

  const verdicts: Verdict[] = [];
  let estimate: RateEstimate | null = null;
  for (let attempt = 1; attempt <= STRATEGIES.length; attempt++) {
    estimate = estimateBill(tariffs, period, bill.kwh, STRATEGIES[attempt - 1]);
    logEstimate(logger, estimate, attempt);
    const verdict = checkRecompute(estimate, bill.totalUsd);
    verdicts.push(verdict);
    logVerdict(logger, verdict, "RateAnalyst", attempt);
    if (verdict.accepted) break;
    if (attempt < STRATEGIES.length) {
      logger.log({ agent: ORCHESTRATOR, step: "retry", target: "RateAnalyst", next: STRATEGIES[attempt], reason: verdict.reason });
    }
  }
  const last = verdicts[verdicts.length - 1];
  if (!estimate) throw new Error("No rate strategy ran");

  const effect = priceEffectOrNull(runtime, tariffs, history, period, estimate.strategy);

  // When nothing closes, the finding uses the attempt closest to the bill, so
  // the amount is the smallest gap the published tariffs can explain.
  const closest = last.accepted ? null : verdicts.reduce((a, b) => (Math.abs(b.gapUsd) < Math.abs(a.gapUsd) ? b : a));
  if (closest) {
    logger.log({
      agent: ORCHESTRATOR,
      step: "finding",
      kind: "possible_billing_error",
      usd: closest.gapUsd,
      direction: closest.gapUsd > 0 ? "billed_above_tariff" : "billed_below_tariff",
      reason: closest.reason,
    });
  }
  return {
    estimate,
    verdicts,
    closed: last.accepted,
    possibleBillingErrorUsd: closest ? closest.gapUsd : null,
    priceEffectUsd: effect,
  };
}

/** Null when there is no previous bill or no approved tariff covers it; the reason is logged. */
function priceEffectOrNull(
  runtime: Runtime,
  tariffs: readonly Tariff[],
  history: readonly BillWeather[],
  period: BillPeriod,
  strategy: RateStrategy,
): number | null {
  const index = history.findIndex((h) => h.periodStart === period.start);
  const previous = index > 0 ? history[index - 1] : null;
  let usd: number | null = null;
  let reason: string | null = previous ? null : "No previous bill in the household history.";
  if (previous) {
    try {
      usd = priceEffect(tariffs, { start: previous.periodStart, end: previous.periodEnd }, period, previous.kwh, strategy);
    } catch (error: unknown) {
      reason = (error as Error).message;
    }
  }
  runtime.logger.log({ agent: "RateAnalyst", step: "price_effect", usd, strategy, previousPeriod: previous?.periodStart ?? null, reason });
  return usd;
}

export interface ExplainOptions {
  readonly householdId: string | null;
  /** Folder for the household's H-MEM and World Model state; null runs without memory. */
  readonly memoryDir: string | null;
  /** What the household told us about itself (size, income, heating); null if nothing. */
  readonly facts?: HouseholdFacts | null;
  /**
   * Earlier bills brought with the request. When set, the history is these bills
   * plus the previous and current bill, joined with NOAA in one query, instead of
   * the household's rows in the database.
   */
  readonly earlierBills?: readonly HistoryBill[];
  /** Write the accepted decision back to household_pg.decisions through Zetaris. */
  readonly recordDecision?: boolean;
}

async function billFor(runtime: Runtime, source: string | Bill): Promise<Bill> {
  if (typeof source === "string") return readBill(runtime.llm, runtime.logger, source);
  runtime.logger.log({ agent: "BillReader", step: "fields_given", reason: "The request carried the bill fields, so no model reads an image.", bill: source });
  return source;
}

async function historyOf(runtime: Runtime, bill: Bill, options: ExplainOptions): Promise<readonly BillWeather[]> {
  if (options.earlierBills) {
    return billWeatherFor(runtime.sql, "WeatherAnalyst", historyForBill(bill, options.earlierBills), noaaSnapshot);
  }
  return options.householdId ? householdBills(runtime.sql, "WeatherAnalyst", "ReconciliationCritic", options.householdId) : [];
}

/** Nemotron's plain-language sentences for the accepted split, checked number by number. */
async function wordsFor(runtime: Runtime, bill: Bill, history: readonly BillWeather[], change: ChangeResult, actions: ActionPlan): Promise<Explained | null> {
  const d = change.decomposition;
  if (!d || !change.closed) return null;
  const at = history.findIndex((h) => h.periodStart === isoDate(bill.periodStart));
  const previous = at > 0 ? history[at - 1] : null;
  if (!previous) return null;
  // The page and the API already lead with the change and the next step, so the sentences carry only the reasons.
  return explainInWords(runtime.llm, runtime.logger, {
    previousKwh: previous.kwh,
    currentKwh: bill.kwh,
    previousDays: previous.days,
    currentDays: history[at].days,
    decomposition: d,
    action: null,
    weather: weatherWord(previous, history[at], componentUsd(d, "weather")),
  });
}

/** Writes the run's decision back through Zetaris when the split closed and the caller asked for it. */
async function decisionOf(
  runtime: Runtime,
  options: ExplainOptions,
  rate: RateResult,
  change: ChangeResult,
  actions: ActionPlan,
  words: Explained | null,
): Promise<RecordedDecision | null> {
  const d = change.decomposition;
  if (!options.recordDecision || !options.householdId || !d || !change.closed || !words) return null;
  const verdicts = [...rate.verdicts, ...change.verdicts, ...actions.actions.flatMap((a) => (a.verdict ? [a.verdict] : [])), ...words.verdicts];
  const top = actions.actions.find((a) => a.status === "recommended" && a.amount?.kind === "monthly");
  const { start, end } = rate.estimate.period;
  return recordDecision(runtime.sql, {
    runKey: `${options.householdId}:${start}:${options.memoryDir ? "memory" : "no-memory"}`,
    householdId: options.householdId,
    periodStart: start,
    periodEnd: end,
    changeUsd: d.changeUsd,
    priceUsd: componentUsd(d, "price"),
    daysUsd: componentUsd(d, "days"),
    weatherUsd: componentUsd(d, "weather"),
    usageUsd: componentUsd(d, "usage"),
    unexplainedUsd: componentUsd(d, "unexplained"),
    checksPassed: verdicts.filter((v) => v.accepted).length,
    checksRun: verdicts.length,
    action: top ? PROGRAMS[top.id].name : null,
    actionUsd: top?.amount?.kind === "monthly" ? top.amount.usd : null,
    explanation: words.text,
  });
}

/** source is a bill image path for BillReader, or bill fields already read. */
export async function explain(runtime: Runtime, source: string | Bill, options: ExplainOptions): Promise<Explanation> {
  const { householdId, memoryDir } = options;
  const bill = await billFor(runtime, source);
  const history = await historyOf(runtime, bill, options);
  const tariffs = await loadTariffs(runtime.sql);
  const rate = analyzeRate(runtime, tariffs, bill, history);
  const { start, end } = rate.estimate.period;
  const ohio = await ohioPrice(runtime.sql, runtime.logger, end, bill.totalUsd, bill.kwh);
  const plan = (change: ChangeResult, taken: ReadonlyMap<ProgramId, { at: string; text: string }>): ActionPlan =>
    planActions(
      {
        facts: options.facts ?? null,
        billTotalUsd: bill.totalUsd,
        rate,
        change,
        billsOnRecord: history.filter((h) => h.periodEnd <= end).length,
        asOf: end,
        taken,
      },
      runtime.logger,
    );
  if (!householdId || !memoryDir) {
    const change = analyzeChange(runtime, tariffs, bill, history, rate);
    const actions = plan(change, new Map());
    const words = await wordsFor(runtime, bill, history, change, actions);
    const recorded = await decisionOf(runtime, options, rate, change, actions, words);
    return { bill, history, rate, change, actions, words, memory: null, recorded, ohio };
  }

  const memory = openHouseholdMemory(join(memoryDir, "hmem"), end);
  const graph = openHouseholdGraph(memoryDir, householdId);
  const previousStart = history.find((h) => h.periodEnd === start)?.periodStart ?? null;
  // Only what the household had said by the end of this bill, so replaying an old bill is stable.
  const notes = previousStart ? notesAbout(memory, previousStart, end) : [];
  runtime.logger.log({ agent: "HouseholdMemory", step: "notes", previousBill: previousStart, notes });
  const used: MemoryUsed = {
    notes,
    previousDiagnosis: previousStart ? previousDiagnosis(graph, householdId, previousStart, runtime.logger) : null,
  };

  const change = analyzeChange(runtime, tariffs, bill, history, rate, oneOffPeriods(memory, end));
  const actions = plan(change, actionsTaken(memory, end));
  const words = await wordsFor(runtime, bill, history, change, actions);
  // Graph first: if it fails, H-MEM is not left holding a diagnosis the graph lacks.
  await recordRun(
    graph,
    householdId,
    { periodStart: start, periodEnd: end, kwh: bill.kwh, totalUsd: bill.totalUsd },
    rate.estimate,
    change.decomposition,
    runtime.logger.runId,
    runtime.logger,
  );
  await recordActionPlan(graph, householdId, actions, end, runtime.logger.runId, runtime.logger);
  rememberDiagnosis(memory, householdId, start, end, summarize(bill, start, end, change), runtime.logger.runId, runtime.logger);
  const recorded = await decisionOf(runtime, options, rate, change, actions, words);
  return { bill, history, rate, change, actions, words, memory: used, recorded, ohio };
}

/** One line a later run can recall: the bill and how its change was split. */
function summarize(bill: Bill, start: string, end: string, change: ChangeResult): string {
  const head = `Bill ${start} to ${end}: ${bill.kwh} kWh, ${bill.totalUsd.toFixed(2)} USD.`;
  const d = change.decomposition;
  if (!d) return `${head} Change not split: ${change.skipped ?? "unknown reason"}`;
  const parts = d.components.map((c) => `${c.key} ${c.usd >= 0 ? "+" : ""}${c.usd.toFixed(2)}`).join(", ");
  return `${head} Change ${d.changeUsd >= 0 ? "+" : ""}${d.changeUsd.toFixed(2)} USD from the previous bill: ${parts} (${d.model.source}, confidence ${d.model.confidence}).`;
}
