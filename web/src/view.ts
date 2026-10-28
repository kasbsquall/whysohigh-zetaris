// HTML for each part of the page, from the view model. Text from the server is escaped.
// Agents carry their plain names here; their names in the code appear only in the evidence.

import { BASE } from "./env.ts";
import { day, esc, kwh, month, short, usd } from "./format.ts";
import type { DemoRules } from "../../src/demo.ts";
import type { DemoWeather } from "../../src/demoWeather.ts";
import {
  AGENT_JOBS,
  AGENT_NAMES,
  agentName,
  stripView,
  type ActionView,
  type BillEnd,
  type CauseView,
  type CheckView,
  type Evidence,
  type PageView,
  type RunView,
  type StripView,
} from "./model.ts";

export type Tab = "first" | "second";

export const icon = (name: string, cls = ""): string => `<i class="ph-light ph-${name}${cls ? ` ${cls}` : ""}" aria-hidden="true"></i>`;
const NEW_TAB = `<span class="sr-only"> (opens in a new tab)</span>`;

const AGENT_ICONS: Readonly<Record<string, string>> = {
  BillReader: "scan",
  RateAnalyst: "receipt",
  WeatherAnalyst: "cloud-sun",
  UsageAnalyst: "calculator",
  ReconciliationCritic: "list-checks",
  HouseholdMemory: "notebook",
  ActionPlanner: "hand-heart",
  Explainer: "pen-nib",
};

const CAUSE_ICONS: Readonly<Record<CauseView["key"], string>> = {
  price: "tag",
  one_off: "notebook",
  days: "calendar-dots",
  weather: "thermometer-simple",
  usage: "plug",
  unexplained: "question",
};

/** Whole dollars without cents, cents otherwise: "$8", "$2.36". */
const money = (n: number): string => (Number.isInteger(n) ? usd(n).replace(/\.00$/, "") : usd(n));

const range = (b: BillEnd): string =>
  b.start ? `${short(b.start)} to ${short(b.end)}, ${b.days} days, ${kwh(b.kwh)}` : `${b.days} days, ${kwh(b.kwh)}`;

// ---------- Tabs and the address bar ----------

/** The word a tab uses in the address bar: the bill's month, "september". */
export const tabKey = (run: RunView): string => month(run.to.end).toLowerCase();

/** The dates a bill covers, for the tab. */
export const tabWhen = (run: RunView): string => (run.to.start ? `${short(run.to.start)} to ${short(run.to.end)}` : "");

/**
 * Reads "#october", "#october-check-4" or "#september-act-pipp_plus" into a tab and the id
 * of the element to show on it; anything else picks nothing.
 */
export function parseHash(hash: string, keys: Readonly<Record<Tab, string>>): { tab: Tab | null; target: string | null } {
  const m = /^#([a-z]+)(?:-(check-\d+|act-[a-z_]+))?$/.exec(hash);
  if (!m) return { tab: null, target: null };
  const tab = (Object.keys(keys) as Tab[]).find((t) => keys[t] === m[1]) ?? null;
  return { tab, target: tab && m[2] ? `${m[1]}-${m[2]}` : null };
}

// ---------- Lead ----------

function who(code: string, source: string): string {
  return `<div class="who"><b>${icon(AGENT_ICONS[code] ?? "user")}${esc(agentName(code))}</b>${source ? `<span>${esc(source)}</span>` : ""}</div>`;
}

/** One calm line under the headline: the answer was checked twice, and why. */
function doubleChecked(run: RunView, key: string): string {
  const i = run.checks.findIndex((c) => !c.accepted);
  if (i < 0) return "";
  const c = run.checks[i];
  const left = /^(\$[\d,]+\.\d{2}) of the /.exec(c.text)?.[1];
  const redo = c.sentBackTo ? `, so ${esc(agentName(c.sentBackTo))} worked it out again` : ", so it was worked out again";
  const why = left ? `The first try left ${left} unexplained${redo}.` : `The first try did not add up${redo}.`;
  return `<p class="notice">${icon("seal-check")}<span>We double-checked this. ${why} <a href="#${key}-check-${i + 1}">See result ${i + 1}</a>.</span></p>`;
}

/** Where the sample bill template prints "Total amount due", in the image's own pixels. */
const TOTAL_RING = { cx: 768, cy: 391, rx: 54, ry: 22 } as const;
const BILL_W = 850;
const BILL_H = 560;
/** The printed part of the sample bill with a 20px margin, for the full-size view. */
const BILL_CROP = "24 21 802 410";

const billSvg = (src: string, viewBox: string, attrs: string): string =>
  `<svg viewBox="${viewBox}" ${attrs}><image href="${src}" width="${BILL_W}" height="${BILL_H}"></image><ellipse class="ring" cx="${TOTAL_RING.cx}" cy="${TOTAL_RING.cy}" rx="${TOTAL_RING.rx}" ry="${TOTAL_RING.ry}"></ellipse></svg>`;

/** The bill the household sent, small, with its total circled; it opens full size. */
function billThumb(run: RunView): string {
  if (!run.billImage) return "";
  const src = `${BASE}${esc(run.billImage)}`;
  return `
    <figure class="bill-thumb block" style="--b:2">
      <button type="button" class="thumb-btn" id="billOpen" aria-haspopup="dialog" aria-controls="billDialog">
        ${billSvg(src, `0 0 ${BILL_W} ${BILL_H}`, 'aria-hidden="true" focusable="false"')}
        <span class="thumb-tag">Sample</span>
        <span class="sr-only">: open the picture of your ${esc(run.to.label)} full size</span>
      </button>
      <figcaption>Your ${esc(run.to.label)}, total ${usd(run.to.usd)} circled. <span class="open">${icon("arrows-out-simple")}Open it full size</span></figcaption>
    </figure>`;
}

export function billDialog(run: RunView): string {
  if (!run.billImage) return "";
  const when = run.to.start ? ` for ${day(run.to.start)} to ${day(run.to.end)}` : "";
  return `
    <dialog id="billDialog" class="bill-dialog" aria-labelledby="billDlgH">
      <div class="dlg-head">
        <h2 id="billDlgH">Your ${esc(run.to.label)}, a sample</h2>
        <button type="button" class="btn line" id="billClose">${icon("x")}Close</button>
      </div>
      <div class="bill-full" tabindex="0" aria-label="The bill at full size; on a phone, slide it sideways to read it all">
        ${billSvg(`${BASE}${esc(run.billImage)}`, BILL_CROP, `role="img" aria-label="Your ${esc(run.to.label)}, a sample statement${esc(when)}: ${esc(kwh(run.to.kwh))}, total amount due ${usd(run.to.usd)}, circled."`)}
      </div>
      <p class="bill-hint">${icon("arrows-left-right")}Slide the bill sideways to read it all.</p>
    </dialog>`;
}

/** Programs the notes take off the list: taken with the notes, suggested again without them. */
const backWithout = (page: PageView): string[] =>
  page.withMemory.actions
    .filter((a) => a.status === "already_taken" && page.withoutMemory.actions.find((b) => b.id === a.id)?.status === "recommended")
    .map((a) => a.name);

/**
 * October's switch, beside "Here is why.": it re-reads the whole bill with or without what
 * the household told us, and one line says what turning it off changes, from both runs.
 */
export function memorySwitch(page: PageView, on: boolean): string {
  const notes = page.withMemory.notes;
  if (notes.length === 0) return "";
  const back = backWithout(page);
  const usage = page.withoutMemory.causes.find((c) => c.key === "usage");
  const effects = [
    back.length ? `${listOf(back)} ${back.length === 1 ? "is" : "are"} suggested again` : "",
    usage ? `your own use reads ${usd(usage.usd, true)}` : "",
  ].filter(Boolean);
  const which = notes.length === 1 ? "Your note is" : `Your ${notes.length} notes are`;
  const then = effects.length ? `: ${listOf(effects)}` : "";
  const line = on
    ? `Off reads this bill as if you had told us nothing${then}.`
    : `${which} left out${then}. Turn it on to use them.`;
  return `
    <div class="mem-ctl">
      <button class="switch" id="memSwitch" type="button" role="switch" aria-checked="${on}" aria-describedby="memLine">
        <span class="track" aria-hidden="true"></span><span class="switch-label">Use what you told us</span><span class="switch-state" aria-hidden="true">${on ? "On" : "Off"}</span>
      </button>
      <p class="switch-line" id="memLine">${esc(line)}</p>
    </div>`;
}

/** Nemotron's summary of the split, with who wrote it and what checked it. */
export function summary(run: RunView): string {
  const w = run.words;
  if (!w) return "";
  const credit = w.byModel
    ? `Written by Nemotron through Meterless Nightshift. ${esc(agentName("ReconciliationCritic"))} matched every number in it to the split below before showing it.`
    : `Built from the numbers below. Nemotron's summary did not pass ${esc(agentName("ReconciliationCritic").toLowerCase())}, so it is not shown.`;
  return `<div class="summary"><p class="summary-text">${esc(w.text)}</p><p class="summary-credit">${icon(AGENT_ICONS.Explainer)}<span>${credit}</span></p></div>`;
}

/** This bill's price per kWh next to Ohio's average that month, from EIA through Zetaris. */
export function ohioNote(run: RunView): string {
  const o = run.ohio;
  if (!o) return "";
  const [y, m] = o.month.split("-");
  const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return `<p class="unit-note ohio-note">This bill works out to <span class="num">${o.billCentsPerKwh.toFixed(2)}</span> cents per kWh, fixed charge included. Ohio homes paid <span class="num">${o.ohioCentsPerKwh.toFixed(2)}</span> cents on average in ${esc(month)}, the latest month the US Energy Information Administration has published.</p>`;
}

function lead(run: RunView, rules: DemoRules, key: string, today: string, memory: string): string {
  const dir = run.changeUsd < 0 ? "down" : "up";
  const conf = run.confidence;
  const higher = conf?.fitted ? "Higher, from your own bills" : `Higher, once we have ${rules.minBillsToFit} of your bills`;
  const meter = conf
    ? `<div class="confidence" role="group" aria-labelledby="conf-h">
        <h2 id="conf-h">${icon("gauge")}How sure we are</h2>
        <div class="meter" aria-hidden="true"><span class="on"></span><span${conf.fitted ? ' class="on"' : ""}></span></div>
        <p class="meter-labels"><span${conf.fitted ? "" : ' class="is"'}>Low</span><span${conf.fitted ? ' class="is"' : ""}>${esc(higher)}</span></p>
        <p class="conf-why">${esc(conf.reason)}</p>
      </div>`
    : "";
  const bill = (b: BillEnd, cls: string): string =>
    `<div class="bill-line ${cls}"><dt><b>${esc(b.label)}</b><span>${esc(range(b))}</span></dt><dd class="amt num">${usd(b.usd)}</dd></div>`;
  return `
    <div class="lead">
      <div class="lead-main block" style="--b:0">
        <h1 class="headline" tabindex="-1"><span class="hl-line">Your bill went ${dir}</span>
          <span class="big ${dir}">${icon(dir === "up" ? "arrow-up" : "arrow-down", "dir")}<span class="num">${usd(Math.abs(run.changeUsd))}</span></span></h1>
        <div class="why-row"><div class="why-head"><p class="why">Here is why.</p>${memory}</div>${summary(run)}${doubleChecked(run, key)}${nextStepLine(run, today, key)}</div>
      </div>
      <div class="lead-side block" style="--b:1">
        <div class="bills-wrap">
          <dl class="bills">${bill(run.from, "then")}${bill(run.to, "now")}</dl>
          <p class="unit-note">kWh means kilowatt-hours, the unit your meter counts.</p>
          ${ohioNote(run)}
        </div>
        ${meter}
      </div>
      ${billThumb(run)}
    </div>
    ${billDialog(run)}`;
}

// ---------- Weather chart ----------

const TEMP_STEPS: readonly (readonly [number, string])[] = [
  [60, "under 60"],
  [65, "60 to 65"],
  [70, "65 to 70"],
  [75, "70 to 75"],
  [80, "75 to 80"],
  [Infinity, "80 and up"],
];

const tempStep = (meanF: number): number => TEMP_STEPS.findIndex(([limit]) => meanF < limit) + 1;
const pct = (n: number): string => `${n.toFixed(2)}%`;

/** What the chart's readout says before anyone picks a day. */
export const stripHint = (touch: boolean): string => (touch ? "Tap a day for its high and low." : "Point at a day for its high and low.");

/** Words for one day, as the readout and the slider say them. */
export const dayText = (s: StripView, d: StripView["days"][number]): string =>
  `${day(d.date)}: high ${d.tmaxF}°F, low ${d.tminF}°F, average ${d.meanF.toFixed(1)}°F. In the ${s.brackets[d.bill].label}.`;

/** The weather chart under the headline: one bar a day, each bill's average and hottest day labelled on it. */
export function strip(run: RunView, weather: DemoWeather, more: boolean): string {
  const s = stripView(run, weather);
  if (!s) return "";
  const n = s.days.length;
  const y = (t: number): number => ((t - s.lowF) / (s.highF - s.lowF)) * 100;
  const split = s.days.findIndex((d) => d.bill === 1);
  const at = split < 0 ? n : split;
  const span = (i: 0 | 1): { left: number; width: number } => (i === 0 ? { left: 0, width: (at / n) * 100 } : { left: (at / n) * 100, width: ((n - at) / n) * 100 });
  const hasBase = 65 > s.lowF && 65 < s.highF;
  const axis = [
    `<span style="bottom:100%">${s.highF}°F</span>`,
    hasBase ? `<span class="y65" style="bottom:${pct(y(65))}">65°F</span>` : "",
    `<span style="bottom:0%">${s.lowF}°F</span>`,
  ].join("");
  const hot = s.hottest;
  const bars = s.days
    .map(
      (d, i) =>
        `<span class="day${d === hot ? " hot" : ""}" data-text="${esc(dayText(s, d))}"><span class="bar t${tempStep(d.meanF)}" style="--i:${i};bottom:${pct(y(d.tminF))};height:${pct(Math.max(y(d.tmaxF) - y(d.tminF), 2))}"></span></span>`,
    )
    .join("");
  const noted = s.brackets.findIndex((b) => b.noted);
  const notedBand = noted === 0 || noted === 1 ? `<div class="noted-band" style="left:${pct(span(noted).left)};width:${pct(span(noted).width)}"></div>` : "";
  const hotX = hot ? ((s.days.indexOf(hot) + 0.5) / n) * 100 : 0;
  // Each average is a line across its bill, labelled above the bars at the bill's start, or
  // at its end when the hottest-day label would sit on the start.
  const avgs = s.brackets
    .map((b, i) => {
      if (b.avgF === null) return "";
      const { left, width } = span(i as 0 | 1);
      const atEnd = hot !== null && hotX >= left && hotX - left < 25;
      return `<div class="avg${atEnd ? " end" : ""}" style="left:${pct(left)};width:${pct(width)};bottom:${pct(y(b.avgF))};--up:${(100 - y(b.avgF)).toFixed(2)}"><span>Average ${b.avgF.toFixed(1)}°F</span></div>`;
    })
    .join("");
  const hotLabel = hot
    ? `<p class="hot-label${hotX > 75 ? " end" : hotX < 25 ? " start" : ""}" style="left:${pct(hotX)}" aria-hidden="true">Hottest day: ${esc(short(hot.date))}, ${hot.tmaxF}°F</p>`
    : "";
  const first = s.days[0];
  const last = s.days[n - 1];
  const legend = TEMP_STEPS.map(([, label], i) => `<li><span class="sw t${i + 1}"></span>${label}</li>`).join("");
  const needs = s.brackets
    .map(
      (b) =>
        `<li><b>${esc(b.label)}</b>, ${esc(short(b.start))} to ${esc(short(b.end))}, ${b.days} days${b.drawn < b.days ? ` (${b.drawn} with readings)` : ""}${b.avgF === null ? "" : `, average ${b.avgF.toFixed(1)}°F`}.${b.need ? ` ${esc(b.need)}.` : ""}${b.noted ? ` Not a normal month, from your note.` : ""}</li>`,
    )
    .join("");
  const summary = [
    ...s.brackets.map((b) => (b.avgF === null ? "" : `${b.label} averaged ${b.avgF.toFixed(1)}°F.`)),
    hot ? `The hottest day was ${day(hot.date)}, at ${hot.tmaxF}°F.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <section class="strip block" style="--b:3" id="strip" aria-labelledby="strip-h">
      <div class="strip-side">
        <h2 id="strip-h">${icon("cloud-sun")}Columbus weather, day by day</h2>
        <p class="strip-sum">${esc(summary)}</p>
        <p class="readout" id="readout">${esc(stripHint(false))}</p>
        <span class="mini-scale" aria-hidden="true"><span>cooler</span><span class="sw t1"></span><span class="sw t2"></span><span class="sw t3"></span><span class="sw t4"></span><span class="sw t5"></span><span class="sw t6"></span><span>hotter</span></span>
        <div class="strip-tools">
          <button type="button" class="more-btn" id="stripMore" aria-expanded="${more}" aria-controls="strip-more">${icon("info")}How to read this chart</button>
          <button type="button" class="clear-btn" id="clearShade" hidden>${icon("x")}Clear the shading</button>
        </div>
      </div>
      <div class="strip-chart">
        <div class="plot-wrap">
          <div class="yaxis" aria-hidden="true"><div class="yaxis-in">${axis}</div></div>
          <div class="plot" role="slider" tabindex="0" aria-label="Daily temperatures in Columbus, ${esc(short(first.date))} to ${esc(short(last.date))}, ${first.date.slice(0, 4)}. Each bar runs from the day's low to its high." aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="1" aria-valuetext="${esc(stripHint(false))}">
            ${hotLabel}
            <div class="plot-in">
              ${notedBand}
              <div class="band" style="left:0;width:${pct(span(0).width)}"></div>
              <div class="band" style="left:${pct(span(1).left)};right:0"></div>
              ${hasBase ? `<div class="base-line" style="bottom:${pct(y(65))}"></div>` : ""}
              <div class="days">${bars}</div>
              ${avgs}
            </div>
          </div>
        </div>
        <div class="brackets" style="grid-template-columns:${at}fr ${n - at}fr">${s.brackets
          .map((b) => `<p class="bracket${b.noted ? " noted" : ""}"><b>${esc(b.label)}</b> <span>${esc(short(b.start))} to ${esc(short(b.end))}</span>${b.noted ? `<span class="nb-note">, not a normal month</span>` : ""}</p>`)
          .join("")}</div>
      </div>
      <div class="strip-more" id="strip-more"${more ? "" : " hidden"}>
        <div class="legend"><p>Bar color is the day's average temperature, in °F:</p><ol>${legend}</ol></div>
        <p>${hasBase ? "The dashed line is 65°F, the base for degree days. " : ""}The solid line across each bill is its average temperature. A degree day measures how much heating or cooling a day needs: a day averaging 75°F has 10 cooling degree days.</p>
        <ul class="needs">${needs}</ul>
        <p class="strip-foot">${icon(AGENT_ICONS.WeatherAnalyst)}<span><b>${esc(agentName("WeatherAnalyst"))}</b>, from the official daily weather records for Columbus airport. Where they come from is under “Where the numbers come from”.</span></p>
      </div>
    </section>`;
}

// ---------- Cascade ----------

interface Scale {
  readonly lo: number;
  readonly hi: number;
  readonly x: (usd: number) => number;
}

/** Running-total axis on whole $5 steps around the bills. */
function bridgeScale(run: RunView): Scale {
  const totals = [run.from.usd];
  for (const c of run.causes) totals.push(Math.round((totals[totals.length - 1] + c.usd) * 100) / 100);
  totals.push(run.to.usd);
  const lo = Math.floor((Math.min(...totals) - 1) / 5) * 5;
  const hi = Math.ceil((Math.max(...totals) + 1) / 5) * 5;
  return { lo, hi, x: (t) => ((t - lo) / (hi - lo)) * 100 };
}

function billRow(b: BillEnd, note: string, label: string, scale: Scale, i: number): string {
  return `
    <tr class="billrow row-in" style="--i:${i}">
      <td class="c-cause"><div class="cause">${icon("file-text")}<div><h3>${esc(b.label)}</h3><p>${esc(range(b))}</p>${who("BillReader", note)}</div></div></td>
      <td class="amount"><span class="usd num">${usd(b.usd)}</span><span class="eff">${esc(label)}</span></td>
      <td class="c-bridge"><div class="bridge" aria-hidden="true"><span class="mark" style="left:${pct(scale.x(b.usd))}"></span></div></td>
    </tr>`;
}

function causeRow(c: CauseView, before: number, after: number, scale: Scale, i: number): string {
  const tone = c.usd > 0 ? "up" : c.usd < 0 ? "down" : "zero";
  const verb = c.usd > 0 ? "Added" : c.usd < 0 ? "Took off" : c.key === "unexplained" ? "Nothing left" : "No change";
  const eff = c.usd > 0 ? "arrow-up" : c.usd < 0 ? "arrow-down" : "equals";
  const left = scale.x(Math.min(before, after));
  const width = Math.abs(scale.x(after) - scale.x(before));
  const seg =
    tone === "zero"
      ? `<span class="seg zero" style="left:${pct(scale.x(after))}"></span>`
      : `<span class="seg ${tone}" style="left:${pct(left)};width:${pct(width)};--i:${i}"></span>`;
  const weatherBtn =
    c.key === "weather"
      ? `<button type="button" class="weather-btn" aria-pressed="false" aria-controls="strip">${icon("chart-bar")}Shade both bills on the weather chart</button>`
      : "";
  return `
    <tr class="row-in${c.key === "weather" ? " is-weather-row" : ""}" style="--i:${Math.min(i, 7)}">
      <td class="c-cause"><div class="cause">${icon(CAUSE_ICONS[c.key])}<div><h3>${esc(c.title)}</h3><p>${esc(c.detail)}</p>${who(c.agent, c.source)}${weatherBtn}</div></div></td>
      <td class="amount ${tone}"><span class="usd num">${usd(c.usd, true)}</span>${c.kwh === null ? "" : `<span class="kwh num">${kwh(c.kwh, true)}</span>`}<span class="eff">${icon(eff)}${verb}</span></td>
      <td class="c-bridge"><div class="bridge" aria-hidden="true">${seg}</div></td>
    </tr>`;
}

/** Short names for the phone chart, which has room for a word or two per row. */
const SHORT: Readonly<Record<CauseView["key"], string>> = {
  price: "Price",
  one_off: "Not repeated",
  days: "Days",
  weather: "Weather",
  usage: "Your own use",
  unexplained: "Not explained",
};

/** The running total as one chart, for narrow screens where a bar per table row falls apart. */
function bridgeChart(run: RunView, scale: Scale): string {
  let total = run.from.usd;
  const rows = [
    `<li class="bm-bill"><span class="bm-l">${esc(run.from.label)}</span><span class="bm-t"><span class="mark" style="left:${pct(scale.x(run.from.usd))}"></span></span><span class="bm-v num">${usd(run.from.usd)}</span></li>`,
    ...run.causes.map((c) => {
      const before = total;
      total = Math.round((total + c.usd) * 100) / 100;
      const tone = c.usd > 0 ? "up" : c.usd < 0 ? "down" : "zero";
      const seg =
        tone === "zero"
          ? `<span class="seg zero" style="left:${pct(scale.x(total))}"></span>`
          : `<span class="seg ${tone}" style="left:${pct(scale.x(Math.min(before, total)))};width:${pct(Math.abs(scale.x(total) - scale.x(before)))}"></span>`;
      return `<li><span class="bm-l">${esc(SHORT[c.key])}</span><span class="bm-t">${seg}</span><span class="bm-v num ${tone}">${usd(c.usd, true)}</span></li>`;
    }),
    `<li class="bm-bill"><span class="bm-l">${esc(run.to.label)}</span><span class="bm-t"><span class="mark" style="left:${pct(scale.x(run.to.usd))}"></span></span><span class="bm-v num">${usd(run.to.usd)}</span></li>`,
  ];
  return `
    <figure class="bridge-mini" aria-hidden="true">
      <ol>${rows.join("")}</ol>
      <figcaption><span>${money(scale.lo)}</span><span>Running total</span><span>${money(scale.hi)}</span></figcaption>
    </figure>`;
}

export function cascade(run: RunView): string {
  if (run.skipped) {
    return `<p class="notice plain">${icon("warning")}<span>We could not split this change: ${esc(run.skipped)}</span></p>`;
  }
  const scale = bridgeScale(run);
  let total = run.from.usd;
  const rows = run.causes.map((c, k) => {
    const before = total;
    total = Math.round((total + c.usd) * 100) / 100;
    return causeRow(c, before, total, scale, k + 1);
  });
  const lo = money(scale.lo);
  const hi = money(scale.hi);
  return `${bridgeChart(run, scale)}
    <table class="cascade" id="cascade">
      <caption><span class="cap">${icon("arrows-horizontal")}<span>The running-total bars go from ${lo} on the left to ${hi} on the right, not from $0, so each change shows at a size you can read.</span></span></caption>
      <thead><tr>
        <th scope="col">Cause, and who worked it out</th>
        <th scope="col" class="r">Change</th>
        <th scope="col" class="bridge-col">Running total, from ${lo} to ${hi}</th>
      </tr></thead>
      <tbody>
        ${billRow(run.from, `Read from your ${run.from.label}`, "Starting point", scale, 0)}
        ${rows.join("")}
        ${billRow(run.to, `Matches the price list: ${usd(run.recomputedUsd)}`, "Where it ends", scale, 7)}
      </tbody>
    </table>`;
}

// ---------- Checks ----------

function check(c: CheckView, n: number, key: string): string {
  if (!c.accepted) {
    return `
      <li class="rejected" id="${key}-check-${n}" tabindex="-1">
        <p class="rej-head">${icon("warning-octagon")}Rejected${c.attempt === 1 ? ", first pass" : ""}</p>
        <div class="rej-body">
          <span class="ck-n num">${n}</span>
          <div class="ck"><h4>${esc(c.title)}</h4><p>${esc(c.text)}</p>
          ${c.sentBackTo ? `<p class="sent">${icon("arrow-u-up-left")}Sent back to ${esc(agentName(c.sentBackTo))} to try again</p>` : ""}</div>
        </div>
      </li>`;
  }
  const status = `Accepted${c.attempt > 1 ? ", second pass" : ""}`;
  return `
    <li id="${key}-check-${n}" tabindex="-1">
      <span class="ck-n num">${n}</span>
      <div class="ck"><span class="ck-status">${icon("check-circle")}${status}</span><h4>${esc(c.title)}</h4><p>${esc(c.text)}</p></div>
    </li>`;
}

export function rulesLine(run: RunView, rules: DemoRules): string {
  const pc = (n: number): string => `${Math.round(n * 100)}%`;
  return run.allowedUsd === null
    ? ""
    : `<p class="rule">${icon("ruler")}<span>The rules: the price list must give within ${pc(rules.recomputeTolerance)} of what the bill says, and no more than ${usd(run.allowedUsd)} of the change may stay unexplained (${pc(rules.closureShare)} of the change, at least ${money(rules.closureFloorUsd)}).</span></p>`;
}

export function checks(run: RunView, rules: DemoRules, key: string): string {
  const passes = [...new Set(run.checks.map((c) => c.attempt))].sort((a, b) => a - b);
  const rejected = run.checks.find((c) => !c.accepted && c.sentBackTo);
  let n = 0;
  const groups = passes.map((attempt, p) => {
    const items = run.checks.filter((c) => c.attempt === attempt);
    const start = n + 1;
    const html = items.map((c) => check(c, ++n, key)).join("");
    const title =
      passes.length === 1
        ? ""
        : p === 0
          ? `<h3 class="pass-title">First pass</h3>`
          : `<h3 class="pass-title">${p === 1 ? "Second pass" : `Pass ${p + 1}`}${rejected?.sentBackTo ? `, after ${esc(agentName(rejected.sentBackTo))} tried again` : ""}</h3>`;
    return `${title}<ol class="checks" start="${start}">${html}</ol>`;
  });
  return `
    <p class="agent">${icon(AGENT_ICONS.ReconciliationCritic)}<span><b>${esc(agentName("ReconciliationCritic"))}</b> recomputes everything and sends work back when it does not add up. Its six checks gave ${run.checks.length} results, in the order they ran; the help-program check is with the next step.</span></p>
    ${groups.join("")}
    ${rulesLine(run, rules)}`;
}

// ---------- Actions ----------

function amountText(a: ActionView): { big: string; small: string } {
  const amt = a.amount;
  if (!amt) return { big: "Amount not known", small: "We need more facts about your household." };
  switch (amt.kind) {
    case "monthly":
      return { big: `about ${money(amt.usd)} a month`, small: `instead of this bill's ${usd(amt.insteadOfUsd)}` };
    case "range":
      return {
        big: `${money(amt.minUsd)} to ${money(amt.maxUsd)}`,
        small: amt.withPipp ? "once, for the heating season, once PIPP Plus is approved" : "once, for the heating season",
      };
    case "up_to":
      return { big: `up to ${money(amt.usd)}`, small: "toward the bill" };
    case "disputed":
      return { big: usd(amt.usd), small: "in question on this bill" };
    case "share_of_change":
      return { big: usd(amt.usd), small: "of the change came from your own use" };
  }
}

const ACTION_ICONS: Readonly<Record<string, string>> = {
  pipp_plus: "hand-coins",
  heap: "flame",
  summer_crisis: "sun",
  winter_crisis: "snowflake",
  puco_complaint: "scales",
  usage_note: "note-pencil",
};

const DECLINED_ICONS: Readonly<Record<string, string>> = {
  summer_crisis: "calendar-x",
  heap: "calendar-x",
  winter_crisis: "calendar-x",
  puco_complaint: "seal-check",
  usage_note: "note-pencil",
  budget_billing: "hourglass-medium",
};

/** Names that are letters, spelled out the first time they appear in the list. */
const SPELLED: Readonly<Record<string, string>> = {
  puco_complaint: "PUCO is the Public Utilities Commission of Ohio, which handles complaints about utilities.",
};

/** Escapes text and keeps phone numbers on one line. */
const keepPhones = (text: string): string => esc(text).replace(/\(\d{3}\) \d{3}-\d{4}/g, (m) => `<span class="nb">${m}</span>`);

const telHref = (phone: string): string => `tel:+1${phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")}`;

function noteForm(nextWithNote: string | null): string {
  return `
    <button type="button" class="btn solid" id="noteOpen" aria-expanded="false" aria-controls="noteForm">${icon("note-pencil")}Write a note for your next bill</button>
    <form class="note-form" id="noteForm" hidden novalidate>
      <label for="noteText">What was different at home this month?</label>
      <textarea id="noteText" rows="3" maxlength="400" placeholder="For example: my grandson stayed with me for three weeks."></textarea>
      <button type="submit" class="btn line">${icon("eye")}Show how the note would read</button>
      <p class="note-result" id="noteResult" hidden></p>
      <p class="note-limit">${icon("info")}<span>This demo does not save notes, so your next bill will not use what you write here.${nextWithNote ? ` To see a note at work, open the ${esc(nextWithNote)}.` : ""}</span></p>
    </form>`;
}

export function stepLinks(step: ActionView["nextStep"], urlLabel = "Apply or read more"): string {
  if (!step.url && !step.phone) return "";
  return `<div class="links">
      ${step.url ? `<a class="btn solid" href="${esc(step.url)}" target="_blank" rel="noopener noreferrer">${icon("arrow-square-out")}${esc(urlLabel)}${NEW_TAB}</a>` : ""}
      ${step.phone ? `<a class="btn line" href="${telHref(step.phone)}">${icon("phone")}${esc(step.phone)}</a>` : ""}
    </div>`;
}

function actionCard(a: ActionView, primary: boolean, asOf: string, nextWithNote: string | null, key: string): string {
  const amt = amountText(a);
  const step = a.nextStep;
  const rules = a.source.startsWith("https://")
    ? ` <a href="${esc(a.source)}" target="_blank" rel="noopener noreferrer">Read the program rules${icon("arrow-square-out")}${NEW_TAB}</a>`
    : "";
  const by =
    a.id === "usage_note"
      ? `<b>${esc(agentName("ReconciliationCritic"))}</b>: anyone can add a note; it has no income or date rules. A saved note is kept in <b>${esc(agentName("HouseholdMemory"))}</b>.`
      : `<b>${esc(agentName("ReconciliationCritic"))}</b>: fits the program rules at this bill's date, ${esc(day(asOf))}.${rules}`;
  return `
    <article class="act${primary ? " primary" : ""}" id="${key}-act-${a.id}" tabindex="-1">
      <h3>${icon(ACTION_ICONS[a.id] ?? "check")}${esc(a.name)}</h3>
      ${a.longName && a.longName !== a.name ? `<p class="full">${esc(a.longName)}</p>` : ""}
      <p class="body">${esc(a.why)}</p>
      <p class="figure"><span class="v num${primary ? "" : " sm"}">${esc(amt.big)}</span><span class="c">${esc(amt.small)}</span></p>
      ${a.id === "usage_note" ? "" : `<p class="fit">${icon("check-circle")}<span>${esc(a.reason)}</span></p>`}
      <p class="next"><b>Next step.</b> ${keepPhones(step.text)}</p>
      ${a.id === "usage_note" ? noteForm(nextWithNote) : ""}
      ${stepLinks(step)}
      <p class="checked">${icon(a.id === "usage_note" ? AGENT_ICONS.ReconciliationCritic : "calendar-check")}<span>${by}</span></p>
    </article>`;
}

/**
 * A program that opened after the bill's date and is open today. It sits with the actions,
 * with the amounts and next step the planner gave it; the checker only judged it at the
 * bill's date, so the card says so and claims no eligibility.
 */
function openNowCard(a: ActionView, asOf: string, today: string, key: string): string {
  const amt = amountText(a);
  const step = a.nextStep;
  return `
    <article class="act open-now" id="${key}-act-${a.id}" tabindex="-1">
      <h3>${icon(ACTION_ICONS[a.id] ?? "check")}${esc(a.name)}</h3>
      ${a.longName && a.longName !== a.name ? `<p class="full">${esc(a.longName)}</p>` : ""}
      <p class="status">${icon("calendar-check")}<span>Open now, since ${esc(day(a.window?.from ?? ""))}</span></p>
      <p class="body">${esc(a.why)}</p>
      <p class="figure"><span class="v num sm">${esc(amt.big)}</span><span class="c">${esc(amt.small)}</span></p>
      <p class="next"><b>Next step.</b> ${keepPhones(step.text)}</p>
      ${stepLinks(step)}
      <p class="checked">${icon("calendar-check")}<span><b>${esc(agentName("ReconciliationCritic"))}</b> checked this at the bill's date, ${esc(day(asOf))}, before it opened; open today, ${esc(day(today))}. Your next bill checks whether you qualify.</span></p>
    </article>`;
}

/** An action the household told us it already took: small, with what it told us. */
function takenCard(a: ActionView): string {
  return `
    <article class="act taken">
      <h3>${icon(ACTION_ICONS[a.id] ?? "check")}${esc(a.name)}</h3>
      <p class="status">${icon("notebook")}<span>You applied, so it is not suggested again.</span></p>
      <p class="quote">From your note of ${esc(short(a.takenAt ?? ""))}: “${esc(a.reason)}”</p>
      <p class="checked">${icon(AGENT_ICONS.HouseholdMemory)}<span><b>${esc(agentName("HouseholdMemory"))}</b>: what you told us on ${esc(day(a.takenAt ?? ""))}.</span></p>
    </article>`;
}

/** Today's date in Columbus, YYYY-MM-DD. */
export const todayInOhio = (now: Date = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);

/** Names that are letters keep their full name beside them: "HEAP (Home Energy Assistance Program)". */
const named = (a: { id: string; name: string; longName?: string }): string =>
  a.longName && a.longName !== a.name && /^[A-Z]{3,}\b/.test(a.name) ? `${a.name} (${a.longName})` : a.name;

/** A season that ended since the bill's date is closed today, whatever the bill's date said. */
const closedNow = (a: ActionView, today: string): boolean => a.status === "recommended" && a.window !== null && today > a.window.to;

/** The actions the page offers today, in the planner's order. */
export const offeredNow = (run: RunView, today: string): ActionView[] => run.actions.filter((a) => a.status === "recommended" && !closedNow(a, today));

/** One sentence that says what an action could do, from its amount. */
export function actionPitch(a: ActionView): string {
  const amt = a.amount;
  const name = named(a);
  if (!amt) return `${name}.`;
  switch (amt.kind) {
    case "monthly":
      return `${name} could make your bill about ${money(amt.usd)} a month, instead of this bill's ${usd(amt.insteadOfUsd)}.`;
    case "range":
      return `${name} could take ${money(amt.minUsd)} to ${money(amt.maxUsd)} off your bill, one time this heating season${amt.withPipp ? ", after PIPP Plus is approved" : ""}.`;
    case "up_to":
      return `${name} could pay up to ${money(amt.usd)} toward your bill.`;
    case "disputed":
      return `${name}: ${usd(amt.usd)} of this bill is in question.`;
    case "share_of_change":
      return `${name}: ${usd(amt.usd)} of the change came from your own use.`;
  }
}

/** The first thing to do, under "Here is why.", linked to its card further down. */
export function nextStepLine(run: RunView, today: string, key: string): string {
  const a = offeredNow(run, today)[0];
  if (!a) return "";
  const how = a.id === "usage_note" ? "See how" : "See how to apply";
  return `<p class="next-up">${icon("arrow-circle-down")}<span><b>Next step:</b> ${esc(actionPitch(a))} <a href="#${key}-act-${a.id}">${how}</a></span></p>`;
}

interface Declined {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  /** Who checked the row; shown in bold, like every agent name. */
  readonly agent: string;
  /** What today's date changes, when it changes something. */
  readonly today: string | null;
}

/**
 * The run judges eligibility at the bill's date so replays stay the same. Each row says
 * the date it was checked against. A season that ended since the bill is shown as closed
 * today. A season that opened since the bill and is open today sits with the actions as
 * "Open now", with its amounts and next step, and says the checker has not judged it yet.
 */
export function actions(run: RunView, today: string, nextWithNote: string | null = null): string {
  const asOf = run.actionsAsOf;
  const key = tabKey(run);
  const openedSince = (a: ActionView): boolean =>
    a.status === "rejected" && a.window !== null && asOf < a.window.from && today >= a.window.from && today <= a.window.to;
  const stillNotOpen = (a: ActionView): boolean => a.status === "rejected" && a.window !== null && today < a.window.from;
  const offered = offeredNow(run, today);
  const openNow = run.actions.filter(openedSince);
  const taken = run.actions.filter((a) => a.status === "already_taken");
  const checker = agentName("ReconciliationCritic");
  const declined: Declined[] = [
    ...run.actions
      .filter((a) => closedNow(a, today))
      .map((a) => ({
        id: a.id,
        name: named(a),
        reason: `Closed on ${day(a.window?.to ?? "")}, so you cannot apply now; ask about next season.`,
        agent: checker,
        today: `closed today, ${day(today)}`,
      })),
    ...run.actions
      .filter((a) => a.status === "rejected" && !openedSince(a))
      .map((a) => ({ id: a.id, name: named(a), reason: a.reason, agent: checker, today: stillNotOpen(a) ? `still not open today, ${day(today)}` : null })),
    ...run.notOffered.map((x) => ({
      id: x.id,
      name: x.name,
      reason: `${SPELLED[x.id] ? `${SPELLED[x.id]} ` : ""}${x.reason}`,
      agent: agentName("ActionPlanner"),
      today: null,
    })),
  ];
  const usesToday = openNow.length > 0 || declined.some((d) => d.today !== null);
  const lead = offered[0];
  const openCards = openNow.map((a) => openNowCard(a, asOf, today, key));
  const side = [
    ...offered.slice(1).map((a) => actionCard(a, false, asOf, nextWithNote, key)),
    ...(lead ? [] : openCards),
    ...taken.map(takenCard),
  ];
  const foot = (d: Declined): string =>
    `<b>${esc(d.agent)}</b> checked this at the bill's date, ${esc(day(asOf))}${d.today ? `; ${esc(d.today)}` : ""}.`;
  return `
    <div class="sec-head">
      <h2 id="act-h">What you can do about this bill</h2>
      <span class="aside">${icon("calendar-check")}Checked at this bill's date, ${esc(day(asOf))}${usesToday ? `, and against today's date, ${esc(day(today))}` : ""}</span>
    </div>
    ${
      lead
        ? `<div class="actions-grid${side.length ? "" : " single"}">
            ${
              openCards.length
                ? `<div class="act-side">${actionCard(lead, true, asOf, nextWithNote, key)}${openCards.join("")}</div>`
                : actionCard(lead, true, asOf, nextWithNote, key)
            }
            ${side.length ? `<div class="act-side">${side.join("")}</div>` : ""}
          </div>`
        : `${side.length ? `<div class="act-side solo">${side.join("")}</div>` : ""}<p class="notice plain">${icon("info")}<span>None of the programs we check fit this bill right now.</span></p>`
    }
    ${
      declined.length
        ? `<div class="notoffered"><h3>Looked at and not offered (${declined.length})</h3><ul>${declined
            .map((d) => `<li>${icon(DECLINED_ICONS[d.id] ?? "x-circle")}<div><b>${esc(d.name)}</b><p>${esc(d.reason)}</p><small>${foot(d)}</small></div></li>`)
            .join("")}</ul></div>`
        : ""
    }`;
}

// ---------- October: what the household told us ----------

const lowerFirst = (t: string): string => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const listOf = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The reading the switch gives, in one paragraph; also what the live region announces. */
export function reading(page: PageView, on: boolean): string {
  const withUsage = page.withMemory.causes.find((c) => c.key === "usage");
  const withoutUsage = page.withoutMemory.causes.find((c) => c.key === "usage");
  if (on) {
    const others = page.withMemory.causes
      .filter((c) => c.key !== "usage" && c.key !== "unexplained" && Math.abs(c.usd) >= 1)
      .sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd))
      .map((c) => `${c.key === "one_off" ? c.title : lowerFirst(c.title)} (${usd(c.usd, true)})`);
    return `<b>With your notes.</b> Your own use changed by <span class="nb">${withUsage ? usd(withUsage.usd, true) : "nothing"}</span>.${others.length ? ` The change comes from ${esc(listOf(others))}.` : ""}`;
  }
  const unusual = esc(page.withMemory.from.label.replace(" bill", ""));
  const without = !withoutUsage
    ? "The same bill has no usage figure without your notes."
    : withoutUsage.usd < 0
      ? `The same bill reads as if you cut back by <span class="nb">${usd(Math.abs(withoutUsage.usd))}</span>.`
      : `The same bill reads as if you used <span class="nb">${usd(withoutUsage.usd)}</span> more.`;
  return `<b>Without your notes.</b> ${without} Your note says ${unusual} was not a normal month, and this reading leaves that out.`;
}

export function memoryPanel(page: PageView, on: boolean): string {
  const notes = page.withMemory.notes;
  if (notes.length === 0) return "";
  const back = backWithout(page);
  const covers = `The switch “Use what you told us”, under the headline, reads the bill as if you had told us nothing: ${notes.length === 1 ? "the note is" : `all ${notes.length} notes are`} left out${back.length ? `, so ${esc(listOf(back))} ${back.length === 1 ? "is" : "are"} suggested again` : ""}.`;
  return `
    <div class="note" role="group" aria-labelledby="note-h">
      <div class="note-quote">
        <h3 id="note-h">${icon(AGENT_ICONS.HouseholdMemory)}What you told us</h3>
        <ul class="notes">${notes.map((n) => `<li><span class="when">${esc(short(n.at))}</span><q>${esc(n.text)}</q></li>`).join("")}</ul>
        <p class="by">Kept in <b>${esc(agentName("HouseholdMemory"))}</b>. ${covers}</p>
      </div>
      <div class="note-switch">
        <p class="reading ${on ? "right" : "wrong"}">${icon(on ? "check-circle" : "warning")}<span>${reading(page, on)}</span></p>
      </div>
    </div>`;
}

export function comparison(page: PageView, on: boolean): string {
  const keys = [...new Set([...page.withMemory.causes, ...page.withoutMemory.causes].map((c) => c.key))];
  const cell = (run: RunView, key: CauseView["key"]): string => {
    const c = run.causes.find((x) => x.key === key);
    if (!c) return `<td class="v ns">Not shown</td>`;
    return `<td class="v num">${usd(c.usd, true)}${c.kwh === null ? "" : `<small>${kwh(c.kwh, true)}</small>`}</td>`;
  };
  const differs = (key: CauseView["key"]): boolean =>
    page.withMemory.causes.find((x) => x.key === key)?.usd !== page.withoutMemory.causes.find((x) => x.key === key)?.usd;
  const title = (key: CauseView["key"]): string =>
    (page.withMemory.causes.find((x) => x.key === key) ?? page.withoutMemory.causes.find((x) => x.key === key))?.title ?? key;
  const a = page.withMemory.normalBill;
  const b = page.withoutMemory.normalBill;
  const daysWhy =
    differs("days") && a && b && a !== b
      ? ` The days row changes too: each day is counted at your normal daily use, and your note makes your ${esc(a)} the normal month instead of your ${esc(b)}.`
      : "";
  return `
    <div class="compare-wrap">
      <h3 id="cmp-h">Same bill, with and without your notes</h3>
      <table class="compare" aria-labelledby="cmp-h">
        <caption>Shaded rows change with your notes.${daysWhy} Both readings end at ${usd(page.withMemory.to.usd)}, this bill's total.</caption>
        <thead><tr><th scope="col">Cause</th><th scope="col"${on ? ' class="live"' : ""}>With your notes</th><th scope="col"${on ? "" : ' class="live"'}>Without them</th></tr></thead>
        <tbody>
          ${keys
            .map(
              (k) =>
                `<tr class="${differs(k) ? "diff" : ""}"><th scope="row">${differs(k) ? `${icon("arrows-left-right")}<span class="sr-only">Changes with your notes: </span>` : ""}${esc(k === "usage" ? "Your own use" : title(k))}</th>${cell(page.withMemory, k)}${cell(page.withoutMemory, k)}</tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

// ---------- Evidence ----------

const SOURCE_TEXT: Readonly<Record<DemoWeather["source"], string>> = {
  live: "Read live from Zetaris when this page's data was prepared.",
  sample: "Replayed from an answer Zetaris gave in a recorded run (sample mode).",
  snapshot: "Sample mode had no recorded answer for this query, so the rows come from a saved copy of the same Zetaris NOAA table.",
};

export function evidence(run: RunView, weather: DemoWeather): string {
  const e: Evidence = run.evidence;
  const block = (k: string, title: string, ico: string, body: string): string => `
    <details data-key="${k}">
      <summary>${icon(ico, "lead-i")}<b>${title}</b>${icon("caret-down", "chev")}</summary>
      <div class="ev-body">${body}</div>
    </details>`;
  const agents = Object.keys(AGENT_NAMES)
    .map((code) => `<tr><td>${esc(agentName(code))}</td><td><code translate="no">${esc(code)}</code></td><td>${esc(AGENT_JOBS[code] ?? "")}</td></tr>`)
    .join("");
  const s = stripView(run, weather);
  const drawn = s ? s.days.length : 0;
  const lastDay = weather.days.at(-1)?.date ?? weather.toExclusive;
  const words = run.checks.map((c, i) => `<li><b>${i + 1}. ${esc(c.title)}.</b> ${esc(c.detail)}</li>`).join("");
  return `
    <div class="sec-head">
      <h2 id="ev-h">Where the numbers come from</h2>
      <span class="aside">${icon("magnifying-glass")}One step further, for anyone who wants to check</span>
    </div>
    ${
      e.weatherSql
        ? block(
            "ev-join",
            "Your bills joined with Columbus weather",
            "database",
            e.weatherSql.includes("lightning.metastore.")
              ? `<p>Your bills and their weather come from a semantic layer in Zetaris, <code translate="no">lightning.metastore.whysohigh.billing</code>. Its <code translate="no">bill_weather</code> table joins <code translate="no">household_pg.bills</code> with the daily weather of NOAA (the US weather service) for station <code translate="no">${esc(weather.station)}</code>, John Glenn Columbus International Airport.</p><pre class="sql"><code translate="no">${esc(e.weatherSql)}</code></pre>${
                  e.weatherRuleSql
                    ? `<p>Before splitting the change, ${esc(agentName("ReconciliationCritic").toLowerCase())} asks Zetaris which bills its data-quality rule <code translate="no">weather_covers_bill</code> rejects: a bill must have weather for every day it covers.</p><pre class="sql"><code translate="no">${esc(e.weatherRuleSql)}</code></pre>`
                    : ""
                }`
              : `<p>One federated SQL query in Zetaris joins <code translate="no">household_pg.bills</code> with the daily weather of NOAA (the US weather service) for station <code translate="no">${esc(weather.station)}</code>, John Glenn Columbus International Airport.</p><pre class="sql"><code translate="no">${esc(e.weatherSql)}</code></pre>`,
          )
        : ""
    }
    ${block(
      "ev-weather",
      "The daily weather on the chart",
      "cloud-sun",
      `<p>${esc(agentName("WeatherAnalyst"))} read ${weather.days.length} days of weather, ${esc(day(weather.from))} to ${esc(day(lastDay))}. The chart on this tab shows the ${drawn} days of its two bills. ${SOURCE_TEXT[weather.source]}</p><pre class="sql"><code translate="no">${esc(weather.sql)}</code></pre>`,
    )}
    ${
      e.tariff
        ? block(
            "ev-tariff",
            "The price list used to recompute your bill",
            "receipt",
            `<p>${esc(e.tariff.name)}, in force since ${esc(day(e.tariff.start))}. OpenEI URDB rate <code translate="no">${esc(e.tariff.label)}</code>.</p>
             <p><a href="https://apps.openei.org/IURDB/rate/view/${encodeURIComponent(e.tariff.label)}" target="_blank" rel="noopener noreferrer">Open the published tariff${icon("arrow-square-out")}${NEW_TAB}</a></p>`,
          )
        : ""
    }
    ${block("ev-words", "What the checker wrote, word for word", "list-checks", `<ol class="words">${words}</ol>`)}
    ${
      e.decisionSql
        ? block(
            "ev-saved",
            "Saved to your record through Zetaris",
            "floppy-disk",
            `<p>Once every check passed, the decision was written back to <code translate="no">household_pg.decisions</code>, next to your bills, and read back through Zetaris to confirm it is there.</p><pre class="sql"><code translate="no">${esc(e.decisionSql)}</code></pre><pre class="sql"><code translate="no">${esc(e.decisionReadSql ?? "")}</code></pre>${
              e.decisionReadBack
                ? `<p>Read back: <code translate="no">${esc(e.decisionReadBack.map((c) => (/^-?\d+\.\d+$/.test(c) ? Number(c).toFixed(2) : c)).join(", "))}</code></p>`
                : ""
            }`,
          )
        : ""
    }
    ${
      e.ohioSql
        ? block(
            "ev-ohio",
            "Ohio's average price that month",
            "chart-line",
            `<p>From the US Energy Information Administration's API, read through Zetaris. EIA nests its rows, so the query unpacks them first.</p><pre class="sql"><code translate="no">${esc(e.ohioSql)}</code></pre>`,
          )
        : ""
    }
    ${
      e.modelCalls.length > 0
        ? block(
            "ev-models",
            "Every model call, with its Meterless receipt",
            "cpu",
            `<p>Nightshift routes each request and returns a compute receipt with it. The model asked for and the model that answered can differ.</p><div class="agents-scroll"><table class="agents"><thead><tr><th scope="col">Step</th><th scope="col">Asked for</th><th scope="col">Answered</th><th scope="col">Receipt</th></tr></thead><tbody>${e.modelCalls
              .map(
                (c) =>
                  `<tr><td>${esc(agentName(c.agent))}</td><td><code translate="no">${esc(c.modelRequested.replace(/^nvidia\//, ""))}</code></td><td><code translate="no">${esc(c.modelServed.replace(/^nvidia\//, ""))}</code></td><td>${
                    c.receiptId ? `<code translate="no">${esc(c.receiptId)}</code>${c.consensus ? `, ${esc(c.consensus)}` : ""}${c.crossChecks.length ? `, ${c.crossChecks.filter((x) => x.endsWith("passed")).length} cross-checks passed` : ""}` : "Recorded before receipts were kept"
                  }</td></tr>`,
              )
              .join("")}</tbody></table></div>`,
          )
        : ""
    }
    ${block(
      "ev-run",
      "This run",
      "play-circle",
      `<p>Run <code translate="no">${esc(e.runId)}</code>. ${e.sampleMode ? "Replayed from responses recorded in a live run (sample mode)." : "Live run against Zetaris and Nightshift."}</p>
       ${e.billModel ? `<p>Bill read by <code translate="no">${esc(e.billModel)}</code> through Meterless Nightshift.</p>` : ""}`,
    )}
    ${block(
      "ev-agents",
      "Who did what: the agents and their names in the code",
      "users-three",
      `<div class="agents-scroll"><table class="agents"><thead><tr><th scope="col">On this page</th><th scope="col">In the code</th><th scope="col">What it does</th></tr></thead><tbody>${agents}</tbody></table></div>`,
    )}`;
}

// ---------- The whole panel ----------

/** What the page keeps across a re-render of the same bill. */
export interface PanelState {
  readonly stripMore: boolean;
}

/** Everything under the tabs for one tab and switch position. */
export function panel(page: PageView, tab: Tab, memoryOn: boolean, today: string, state: PanelState = { stripMore: false }): string {
  const second = tab === "second";
  const run = second ? (memoryOn ? page.withMemory : page.withoutMemory) : page.first;
  const key = tabKey(run);
  const verb = run.changeUsd < 0 ? "came off" : "adds up";
  const nextWithNote = !second && page.withMemory.notes.length > 0 ? page.withMemory.tabLabel : null;
  return `
    <div class="wrap">
      ${lead(run, page.rules, key, today, second ? memorySwitch(page, memoryOn) : "")}
      ${strip(run, page.weather, state.stripMore)}
      <div class="work">
        <section class="cascade-sec block" style="--b:4" aria-labelledby="casc-h">
          <div class="sec-head"><h2 id="casc-h">How the ${usd(Math.abs(run.changeUsd))} ${verb}</h2><span class="aside">${icon("arrow-down")}Last bill to this bill, one cause at a time</span></div>
          ${cascade(run)}
          ${second ? memoryPanel(page, memoryOn) : ""}
          ${second ? comparison(page, memoryOn) : ""}
        </section>
        <section class="checks-sec block" style="--b:5" aria-labelledby="ck-h">
          <div class="sec-head"><h2 id="ck-h">Checked before you see it</h2></div>
          ${checks(run, page.rules, key)}
        </section>
      </div>
      <section class="sec actions-sec block" style="--b:6" aria-labelledby="act-h">${actions(run, today, nextWithNote)}</section>
      <section class="sec evidence block" style="--b:7" aria-labelledby="ev-h">${evidence(run, page.weather)}</section>
    </div>`;
}

export function skeleton(): string {
  const row = (i: number): string => `<div class="sk-row" style="--i:${i}"><span class="sk-line w60"></span><span class="sk-line w30"></span></div>`;
  return `
    <div class="wrap loading" role="status">
      <div class="lead"><div class="lead-main"><span class="sk-line w40 tall"></span><span class="sk-line w30 huge"></span></div><div class="sk-box"></div></div>
      <div class="sk-strip"></div>
      <p class="loading-msg">${icon("hourglass-medium")}We are reading the bill and checking each cause…</p>
      <div class="work"><div>${[0, 1, 2, 3, 4].map(row).join("")}</div><div>${[0, 1, 2].map(row).join("")}</div></div>
    </div>`;
}

/** A failure in words for the household; the original error goes to the console, never to the page. */
export function friendlyError(error: unknown): string {
  return error instanceof TypeError
    ? "We could not load your bills. Check your internet connection and try again."
    : "Something went wrong on our side. Please try again in a minute.";
}

export function failure(message: string): string {
  return `
    <div class="wrap">
      <div class="failure" role="alert">
        <h2>${icon("warning")}This bill could not be explained right now</h2>
        <p>${esc(message)}</p>
        <button class="btn solid" id="retry" type="button">${icon("arrow-clockwise")}Try again</button>
      </div>
    </div>`;
}
