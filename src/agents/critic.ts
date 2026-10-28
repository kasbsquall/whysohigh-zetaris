// ReconciliationCritic: checks the analysts' numbers against the bill and can
// reject them. Each check returns a verdict with its reason; nothing passes
// silently.

import { INCOME_LIMIT_USD, SUMMER_CRISIS_MIN_AGE, type HouseholdFacts, type Program } from "../actions/programs.ts";
import type { RunLogger } from "../log.ts";
import { segmentsFor, type Tariff } from "../tariff/tariff.ts";
import type { BillWeather } from "../zetaris/queries.ts";
import type { RateEstimate } from "./rateAnalyst.ts";
import { componentUsd, type Decomposition } from "./usageAnalyst.ts";
import { OHIO_PRIOR, type WeatherModel } from "./weatherAnalyst.ts";

export const AGENT = "ReconciliationCritic";

/** Check 1 tolerance: the recomputed bill must land within 2% of the billed total. */
export const RECOMPUTE_TOLERANCE = 0.02;

export interface Verdict {
  readonly check: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly gapUsd: number;
}

export function checkRecompute(estimate: RateEstimate, billedUsd: number): Verdict {
  const gapUsd = Math.round((billedUsd - estimate.charges.totalUsd) * 100) / 100;
  const share = billedUsd === 0 ? (gapUsd === 0 ? 0 : 1) : Math.abs(gapUsd) / Math.abs(billedUsd);
  const pct = (share * 100).toFixed(1);
  const accepted = share <= RECOMPUTE_TOLERANCE;
  const reason = accepted
    ? `Published tariff gives ${estimate.charges.totalUsd.toFixed(2)} USD, billed ${billedUsd.toFixed(2)} USD (${pct}% apart).`
    : `Published tariff gives ${estimate.charges.totalUsd.toFixed(2)} USD but the bill says ${billedUsd.toFixed(2)} USD: ` +
      `${Math.abs(gapUsd).toFixed(2)} USD (${pct}%) more than the ${RECOMPUTE_TOLERANCE * 100}% allowed.`;
  return { check: "bill_recompute", accepted, reason, gapUsd };
}

/** Check 2 tolerance: what stays unexplained must be under 5% of the change (never less than 1 USD). */
export const CLOSURE_SHARE = 0.05;
export const CLOSURE_FLOOR_USD = 1;

export function checkClosure(d: Decomposition): Verdict {
  const gapUsd = componentUsd(d, "unexplained");
  const allowed = Math.max(Math.abs(d.changeUsd) * CLOSURE_SHARE, CLOSURE_FLOOR_USD);
  const accepted = Math.abs(gapUsd) <= allowed;
  const reason = accepted
    ? `Price, days, weather and usage explain the ${Math.abs(d.changeUsd).toFixed(2)} USD change; ${Math.abs(gapUsd).toFixed(2)} USD is left, within the ${allowed.toFixed(2)} USD allowed.`
    : `${Math.abs(gapUsd).toFixed(2)} USD of the ${Math.abs(d.changeUsd).toFixed(2)} USD change is not explained, more than the ${allowed.toFixed(2)} USD allowed ` +
      `(${CLOSURE_SHARE * 100}% of the change, at least ${CLOSURE_FLOOR_USD} USD). ` +
      (d.usageStrategy === "model"
        ? `Usage was measured against ${d.model.source === "ohio_prior" ? "Ohio averages" : "the weather model fitted to the household's bills"}, which may not fit this household.`
        : "Usage was measured against the model calibrated to the household's previous bill.");
  return { check: "closure", accepted, reason, gapUsd };
}

/** Check 3 limits: slopes at most this many times the statewide ones, and a fit must explain half the variance. */
export const MAX_SLOPE_VS_OHIO = 4;
export const MIN_FIT_R2 = 0.5;

/** Check 3: the weather model must behave like electricity use does before its weather share is believed. */
export function checkWeatherModel(model: WeatherModel): Verdict {
  const maxCdd = OHIO_PRIOR.perCdd * MAX_SLOPE_VS_OHIO;
  const maxHdd = OHIO_PRIOR.perHdd * MAX_SLOPE_VS_OHIO;
  const problems = [
    model.basePerDay <= 0 ? `base use of ${model.basePerDay.toFixed(1)} kWh per day` : null,
    model.perCdd < 0 || model.perCdd > maxCdd ? `${model.perCdd.toFixed(3)} kWh per cooling degree day (allowed 0 to ${maxCdd.toFixed(3)})` : null,
    model.perHdd < 0 || model.perHdd > maxHdd ? `${model.perHdd.toFixed(3)} kWh per heating degree day (allowed 0 to ${maxHdd.toFixed(3)})` : null,
    model.r2 !== null && model.r2 < MIN_FIT_R2 ? `a fit that explains ${(model.r2 * 100).toFixed(0)}% of past bills (needs ${MIN_FIT_R2 * 100}%)` : null,
  ].filter((p): p is string => p !== null);
  const what =
    model.source === "household_fit" ? `The fit on ${model.billsUsed} bills` : "The Ohio prior";
  const calibrated = model.calibrationPerDay !== 0 ? `, calibrated by ${model.calibrationPerDay.toFixed(2)} kWh per day,` : "";
  const accepted = problems.length === 0;
  const reason = accepted
    ? `${what}${calibrated} has ${model.basePerDay.toFixed(1)} kWh per day of base use and slopes within ${MAX_SLOPE_VS_OHIO} times the Ohio ones.`
    : `${what}${calibrated} gives ${problems.join(" and ")}. Its weather share is not credible.`;
  return { check: "weather_model", accepted, reason, gapUsd: 0 };
}

/**
 * Check 5: the tariff and the weather data must cover every day of both bills.
 * When the bills came through the semantic layer, Zetaris's rule weather_covers_bill
 * gives the weather verdict and the count here must agree with it.
 */
export function checkFreshness(tariffs: readonly Tariff[], bills: readonly BillWeather[]): Verdict {
  const problems: string[] = [];
  for (const b of bills) {
    try {
      segmentsFor(tariffs, { start: b.periodStart, end: b.periodEnd });
    } catch (error: unknown) {
      problems.push(`${(error as Error).message.replace(/\.$/, "")} (bill ${b.periodStart} to ${b.periodEnd})`);
    }
    const rule = b.weatherRule;
    if (rule && !rule.passed) {
      problems.push(`Zetaris rule ${rule.name} (${rule.expression}) rejects the bill ${b.periodStart} to ${b.periodEnd}: NOAA has ${b.weatherDays} of ${b.days} days`);
    } else if (b.weatherDays !== b.days) {
      // Fail closed when the count and the rule disagree.
      problems.push(`NOAA has ${b.weatherDays} of ${b.days} days for the bill ${b.periodStart} to ${b.periodEnd}${rule ? `, although Zetaris rule ${rule.name} passed it` : ""}`);
    }
  }
  const accepted = problems.length === 0;
  const rule = bills.length > 0 && bills.every((b) => b.weatherRule) ? bills[0].weatherRule : undefined;
  const reason = !accepted
    ? `${problems.join("; ")}.`
    : rule
      ? `Published tariff covers every day of the ${bills.length} bills compared, and Zetaris rule ${rule.name} confirms NOAA weather for each.`
      : `Published tariff and NOAA weather cover every day of the ${bills.length} bills compared.`;
  return { check: "freshness", accepted, reason, gapUsd: 0 };
}

export function logVerdict(logger: RunLogger, verdict: Verdict, about: string, attempt: number): void {
  logger.log({ agent: AGENT, step: verdict.accepted ? "accepted" : "rejected", about, attempt, ...verdict });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const wholeUsd = (n: number): string => `${n.toLocaleString("en-US")} USD`;
const people = (n: number): string => (n === 1 ? "1 person" : `${n} people`);

/**
 * Check 4: the household must be able to take the action at the bill's date.
 * Income, household size and dates come from the program rules in src/actions/programs.ts.
 * A fact the rule needs and the household has not given rejects the action (fail closed).
 */
export function checkEligibility(program: Program, facts: HouseholdFacts | null, asOf: string, hasAmount: boolean): Verdict {
  const verdict = (accepted: boolean, reason: string): Verdict => ({ check: "eligibility", accepted, reason, gapUsd: 0 });
  const w = program.window;
  if (w && asOf < w.from) return verdict(false, `Not open yet: ${program.name} takes applications from ${longDate(w.from)} to ${longDate(w.to)}.`);
  if (w && asOf > w.to) return verdict(false, `Closed: ${program.name} ran from ${longDate(w.from)} to ${longDate(w.to)}.`);

  const reasons: string[] = [];
  if (program.incomeTested) {
    const size = facts?.householdSize;
    const income = facts?.annualIncomeUsd;
    if (size === undefined || income === undefined || !Number.isInteger(size) || size < 1 || !Number.isFinite(income) || income < 0) {
      return verdict(false, "We need the household size and yearly income to check the income limit.");
    }
    const limit = INCOME_LIMIT_USD[size];
    if (limit === undefined) return verdict(false, `Households of ${size} or more people are not supported yet.`);
    if (income > limit) return verdict(false, `${wholeUsd(income)} a year is over the ${wholeUsd(limit)} limit for ${people(size)}.`);
    reasons.push(`${wholeUsd(income)} a year is under the ${wholeUsd(limit)} limit for ${people(size)}`);
  }
  if (!hasAmount) return verdict(false, `We need ${program.id === "pipp_plus" ? "the yearly income and whether you heat with electricity" : "more facts"} to work out the amount.`);

  if (program.id === "summer_crisis") {
    const age = facts?.oldestMemberAge;
    const older = age !== undefined && age >= SUMMER_CRISIS_MIN_AGE;
    if (!older && facts?.disconnectionNotice !== true) {
      return verdict(false, `Needs someone ${SUMMER_CRISIS_MIN_AGE} or older at home, a doctor's note that cooling is needed, or a disconnection notice.`);
    }
    reasons.push(older ? `someone at home is ${age}` : "there is a disconnection notice");
  }
  if (program.id === "winter_crisis" && facts?.disconnectionNotice !== true) {
    return verdict(false, "Only with a disconnection notice, a service already cut off, a new service or a transfer.");
  }
  if (w) reasons.push(`it is open from ${longDate(w.from)} to ${longDate(w.to)}`);
  if (reasons.length === 0) reasons.push("anyone can do this; it has no income or date rules");
  const text = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join("; ")}; and ${reasons.at(-1)}`;
  return verdict(true, `${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
}
