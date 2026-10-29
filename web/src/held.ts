// Marcus's page (?household=marcus): a bill that the data-quality rule in Zetaris holds
// back. While the server works it out (GET /api/held), the live list shows each query;
// then the page says what is on hold, why, and what was already checked.

import type { HeldCheck, HeldPayload } from "../../src/held.ts";
import { STATIC_DEMO } from "./env.ts";
import { esc, plainCheck, plainReason, usd } from "./format.ts";
import { liveQueries } from "./live.ts";
import { failure, friendlyError, icon, skeleton } from "./view.ts";

const CHECK_TITLES: Readonly<Record<string, string>> = {
  bill_recompute: "The bill matches the tariff",
  freshness: "The data covers every day",
};

const DQ_CHECK = /^\s*SHOW\s+DQ\s+INVALID\s+RECORD\b/i;

const atNoon = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
const monthOf = (iso: string): string => atNoon(iso).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
const day = (iso: string): string => atNoon(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function checkRow(c: HeldCheck): string {
  const program = c.check === "eligibility";
  const title = program ? c.about : (CHECK_TITLES[c.check] ?? c.check);
  const status = c.accepted ? "Accepted" : program ? "Not for this household now" : "Held";
  const [cls, ico] = c.accepted ? ["ok", "check-circle"] : program ? ["na", "minus-circle"] : ["no", "pause-circle"];
  return `<li class="${cls}">${icon(ico)}<span><b>${esc(status)}: ${esc(title)}</b> ${esc(plainCheck(plainReason(c.reason)))}</span></li>`;
}

/** Everything under the header for Marcus's latest bill. */
export function heldView(p: HeldPayload): string {
  const { bill, coverage } = p;
  const rule = coverage?.rule ?? null;
  const ruleQuery = p.queries.find((q) => DQ_CHECK.test(q.sql) && q.zetarisQueryId);
  const month = monthOf(bill.periodEnd);
  const missing = coverage ? coverage.days - coverage.weatherDays : 0;
  const headline =
    p.held && coverage
      ? `<span class="hl-line">Your ${esc(month)} bill is on hold</span>
         <span class="big held"><span class="num">${coverage.weatherDays}</span> <span class="of">of ${coverage.days} days</span></span>`
      : `<span class="hl-line">Your ${esc(month)} bill</span>`;
  const why =
    p.held && coverage
      ? `NOAA has published Columbus weather for ${coverage.weatherDays} of this bill’s ${coverage.days} days. Without ${missing === 1 ? "the last one" : `the other ${missing}`}, the weather share of the change would be a guess, so the split waits until NOAA has ${missing === 1 ? "it" : "them"}.`
      : p.held
        ? `The change is not split yet: ${p.held}`
        : `NOAA now has every day of this bill, so nothing is on hold.`;
  const ruleLine = rule
    ? `<p class="held-rule">${icon("list-checks")}<span>${p.held ? "Held by" : "Passed"} the data-quality rule <code translate="no">${esc(rule.name)}</code> in Zetaris, <code translate="no">${esc(rule.expression)}</code>.${
        ruleQuery?.zetarisQueryId ? ` Zetaris query <code translate="no">${esc(ruleQuery.zetarisQueryId.slice(0, 8))}</code>.` : ""
      }</span></p>`
    : "";
  return `
    <div class="wrap">
      <div class="lead held-lead">
        <div class="lead-main block" style="--b:0">
          <h1 class="headline" tabindex="-1">${headline}</h1>
          <p class="held-why">${esc(why)}</p>
          ${ruleLine}
        </div>
        <div class="lead-side block" style="--b:1">
          <div class="bills-wrap">
            <dl class="bills"><div class="bill-line now"><dt><b>${esc(month)} bill</b><span>${esc(`${day(bill.periodStart)} to ${day(bill.periodEnd)}, ${bill.days} days, ${bill.kwh.toLocaleString("en-US")} kWh`)}</span></dt><dd class="amt num">${usd(bill.totalUsd)}</dd></div></dl>
            <p class="unit-note">kWh means kilowatt-hours, the unit your meter counts.</p>
          </div>
        </div>
      </div>
      <section class="sec held-checks-sec block" style="--b:2" aria-labelledby="held-ck-h">
        <div class="sec-head"><h2 id="held-ck-h">${p.held ? "Checked while the split waits" : "Checked"}</h2><span class="aside">${icon("arrow-down")}In the order the checker ran them</span></div>
        <ul class="held-checks">${p.checks.map(checkRow).join("")}</ul>
      </section>
    </div>`;
}

/** Loads Marcus's bill into the page, with the live list of queries while it runs. */
export async function loadHeld(): Promise<void> {
  const page = document.getElementById("page");
  const root = document.getElementById("panel");
  const household = document.getElementById("household");
  if (!page || !root || !household) return;
  // One bill, so no tabs: the area is a plain region, not a tab panel.
  document.querySelector(".tabs")?.setAttribute("hidden", "");
  page.removeAttribute("role");
  page.removeAttribute("aria-labelledby");
  const liveRoot = document.getElementById("demoLive");
  const title = document.getElementById("demoLiveH")?.lastChild;
  if (title) title.textContent = "What the agents asked Zetaris for this bill";
  const live = liveRoot && !STATIC_DEMO ? liveQueries(liveRoot, { stream: "/api/events?for=held", foldWhenDone: true }) : null;

  const start = async (): Promise<void> => {
    let shown = false;
    page.setAttribute("aria-busy", "true");
    root.innerHTML = skeleton();
    if (liveRoot) page.prepend(liveRoot);
    live?.start();
    try {
      const res = await fetch("/api/held");
      const body = (await res.json().catch(() => null)) as HeldPayload | { error: string } | null;
      if (body === null || !res.ok || "error" in body) throw new Error(`The held-bill service answered ${res.status}.`);
      household.textContent = `${body.household.name}, ${body.household.utility} residential, ${body.household.city}`;
      root.innerHTML = heldView(body);
      shown = true;
    } catch (error: unknown) {
      // The page never shows the raw message; it stays in the console for whoever runs it.
      console.error("Why So High could not load Marcus's bill:", error);
      household.textContent = "Could not load the household";
      root.innerHTML = failure(friendlyError(error));
      document.getElementById("retry")?.addEventListener("click", () => void start());
    } finally {
      page.setAttribute("aria-busy", "false");
      live?.stop();
      if (liveRoot && shown) page.append(liveRoot);
    }
  };
  await start();
}
