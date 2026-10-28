// "Read your own bill": the photo is shrunk in the browser, sent to POST /api/photo,
// read by BillReader (Nemotron vision) and explained by the same agents as Linda's bills.

import { PROGRAMS } from "../../src/actions/programs.ts";
import { BASE, STATIC_DEMO } from "./env.ts";
import { esc, plainCheck, plainReason, usd } from "./format.ts";
import { liveQueries } from "./live.ts";
import { stepLinks } from "./view.ts";

const MAX_SIDE = 1600;
const QUALITY = 0.85;

interface Verdict {
  readonly check: string;
  readonly accepted: boolean;
  readonly reason: string;
}
interface Component {
  readonly key: string;
  readonly usd: number;
}
interface PhotoResult {
  readonly status: "success" | "error";
  readonly error?: { readonly message: string };
  readonly output?: {
    readonly bill: {
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly days: number;
      readonly kwh: number;
      readonly totalUsd: number;
      readonly previous: { readonly kwh: number; readonly days: number; readonly totalUsd: number } | null;
    };
    readonly rate: { readonly verdicts: readonly Verdict[]; readonly possibleBillingErrorUsd: number | null };
    readonly change: { readonly verdicts: readonly Verdict[]; readonly skipped: string | null; readonly decomposition: { readonly changeUsd: number; readonly components: readonly Component[] } | null };
    readonly words: { readonly text: string; readonly source: string; readonly verdicts: readonly Verdict[] } | null;
    readonly actions?: { readonly actions: readonly { readonly id: string; readonly why: string; readonly status: string }[] };
  };
}

/** A bill above the published tariff: what it says against what the tariff gives, and what to do. */
function billGap(bill: { readonly kwh: number; readonly totalUsd: number }, gapUsd: number, complaint: { readonly why: string } | undefined): string {
  if (gapUsd <= 0) {
    return `<p class="photo-msg">AEP Ohio's published tariff gives a total ${usd(Math.abs(gapUsd))} higher than this bill for the same kWh. It is worth asking AEP Ohio about it.</p>`;
  }
  const step = PROGRAMS.puco_complaint.nextStep;
  const tariffUsd = Math.round((bill.totalUsd - gapUsd) * 100) / 100;
  return `
    <section class="bill-gap" aria-labelledby="gapH">
      <h3 class="photo-h" id="gapH">This bill is <span class="num">${usd(gapUsd)}</span> above AEP Ohio's published tariff</h3>
      <dl class="gap-rows">
        <div><dt>The bill says</dt><dd class="num">${usd(bill.totalUsd)}</dd></div>
        <div><dt>AEP Ohio's published tariff, same ${bill.kwh.toLocaleString("en-US")} kWh</dt><dd class="num">${usd(tariffUsd)}</dd></div>
      </dl>
      ${complaint ? `<p>${esc(plainReason(complaint.why))}</p><p class="gap-step">${esc(step.text)}</p>${stepLinks(step, "File a complaint online")}` : "<p>It is worth asking AEP Ohio about it.</p>"}
    </section>`;
}

const LABELS: Readonly<Record<string, string>> = {
  price: "Price per kWh",
  days: "Billing days",
  weather: "Weather",
  usage: "Your own use",
  unexplained: "Not explained",
};

const CHECKS: Readonly<Record<string, string>> = {
  bill_recompute: "The bill matches the tariff",
  freshness: "The data covers every day",
  weather_model: "The weather model is believable",
  closure: "The change adds up",
  explanation_numbers: "The summary uses only these numbers",
};

const OFFLINE_MESSAGE =
  "This online copy replays recorded runs, so it can show the sample photo but cannot read a new one. To read your own bill, run Why So High on your computer with its models (README, Run it live).";
const SAMPLE_FIGURE = `<figure class="photo-sample"><img src="${BASE}sample-photo.jpg" alt="The sample photo: a test bill shot at an angle, blurred and unevenly lit" width="320" loading="lazy"><figcaption>The sample photo, a test bill photographed at an angle, blurred and unevenly lit.</figcaption></figure>`;

/** Whether this copy can read a new photo; the static copy and sample mode cannot. */
async function photoAvailability(): Promise<{ available: boolean; message: string | null; sample?: boolean }> {
  if (STATIC_DEMO) {
    const sample = await fetch(`${BASE}photo-sample.json`, { method: "HEAD" }).then((r) => r.ok, () => false);
    return { available: false, sample, message: sample ? OFFLINE_MESSAGE : OFFLINE_MESSAGE.replace("it can show the sample photo but cannot read a new one", "it cannot read a photo") };
  }
  try {
    const res = await fetch("/api/photo");
    return res.ok ? ((await res.json()) as { available: boolean; message: string | null }) : { available: true, message: null };
  } catch {
    return { available: true, message: null };
  }
}

/** Draws the photo at most MAX_SIDE pixels on its long side and encodes it as JPEG. */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot prepare the photo.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", QUALITY);
}

export function photoResult(r: PhotoResult): string {
  const out = r.output;
  if (r.status !== "success" || !out) return `<p class="photo-msg">${esc(r.error?.message ?? "The photo could not be read.")}</p>`;
  const b = out.bill;
  const read = [
    ["Service period", `${b.periodStart} to ${b.periodEnd}, ${b.days} days`],
    ["Energy used", `${b.kwh.toLocaleString("en-US")} kWh`],
    ["Total", usd(b.totalUsd)],
    ...(b.previous ? [["Last bill", `${b.previous.kwh.toLocaleString("en-US")} kWh, ${b.previous.days} days, ${usd(b.previous.totalUsd)}`]] : []),
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="num">${esc(v)}</dd></div>`)
    .join("");
  const verdicts = [...out.rate.verdicts, ...out.change.verdicts, ...(out.words?.verdicts ?? [])];
  const passed = verdicts.filter((v) => v.accepted).length;
  const title = (v: Verdict): string => (v.check === "closure" && !v.accepted ? "Too much left unexplained" : (CHECKS[v.check] ?? v.check));
  const checks = verdicts
    .map((v, i) => {
      const again = verdicts.slice(0, i).some((w) => w.check === v.check) ? ", again" : "";
      return `<li class="${v.accepted ? "ok" : "no"}"><i class="ph-light ph-${v.accepted ? "check-circle" : "warning-circle"}" aria-hidden="true"></i><span><b>${esc(v.accepted ? "Accepted" : "Sent back")}: ${esc(title(v))}${again}</b> ${esc(plainCheck(plainReason(v.reason)))}</span></li>`;
    })
    .join("");
  const d = out.change.decomposition;
  const split = d
    ? `<h3 class="photo-h">Your bill went ${d.changeUsd < 0 ? "down" : "up"} <span class="num">${usd(Math.abs(d.changeUsd))}</span></h3>
       ${out.words ? `<p class="summary-text">${esc(out.words.text)}</p>` : ""}
       <ul class="photo-split">${d.components.map((c) => `<li><span>${esc(LABELS[c.key] ?? c.key)}</span><span class="num">${usd(c.usd, true)}</span></li>`).join("")}</ul>`
    : `<p class="photo-msg">${esc(out.change.skipped ?? "The change could not be split.")}</p>`;
  const complaint = out.actions?.actions.find((a) => a.id === "puco_complaint" && a.status === "recommended");
  const error = out.rate.possibleBillingErrorUsd !== null ? billGap(b, out.rate.possibleBillingErrorUsd, complaint) : "";
  return `
    <h3 class="photo-h">Read from your photo</h3>
    <dl class="photo-read">${read}</dl>
    ${error}
    ${split}
    <h3 class="photo-h">Checked before you see it</h3>
    <p class="summary-credit">${passed} of ${verdicts.length} results accepted, in the order the checker ran them. Without your household size and income it cannot check help programs.</p>
    <ul class="photo-checks">${checks}</ul>`;
}

export function wirePhoto(): void {
  const open = document.getElementById("photoOpen");
  const dialog = document.getElementById("photoDialog") as HTMLDialogElement | null;
  const input = document.getElementById("photoFile") as HTMLInputElement | null;
  const status = document.getElementById("photoStatus");
  const result = document.getElementById("photoResult");
  if (!open || !dialog || !input || !status || !result) return;
  const pick = dialog.querySelector<HTMLElement>(".photo-pick");
  open.addEventListener("click", () => {
    dialog.showModal();
    void photoAvailability().then(({ available, message, sample: hasSample }) => {
      if (hasSample === false) document.getElementById("photoSample")?.setAttribute("hidden", "");
      if (available) return;
      input.disabled = true;
      pick?.setAttribute("hidden", "");
      status.textContent = message ?? OFFLINE_MESSAGE;
    });
  });
  document.getElementById("photoClose")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => open.focus());
  const sample = document.getElementById("photoSample") as HTMLButtonElement | null;
  // The online copy replays a file and sends no queries, so it has no live list.
  const liveRoot = document.getElementById("photoLive");
  const live = liveRoot && !STATIC_DEMO ? liveQueries(liveRoot, { stream: "/api/events?for=photo" }) : null;
  const show = async (waiting: string, ask: () => Promise<Response>, figure: string): Promise<void> => {
    result.innerHTML = "";
    status.textContent = waiting;
    input.disabled = true;
    if (sample) sample.disabled = true;
    live?.start();
    try {
      const res = await ask();
      const body = (await res.json()) as PhotoResult;
      status.textContent = res.ok ? "Done." : "";
      result.innerHTML = res.ok ? figure + photoResult(body) : photoResult(body);
    } catch {
      status.textContent = "";
      result.innerHTML = `<p class="photo-msg">The photo could not be sent. Check the connection and try again.</p>`;
    } finally {
      live?.stop();
      input.disabled = pick?.hasAttribute("hidden") ?? false;
      if (sample) sample.disabled = false;
      input.value = "";
    }
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void show(
      "Reading your bill. This takes about a minute.",
      async () => fetch("/api/photo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: await shrink(file) }) }),
      "",
    );
  });
  sample?.addEventListener("click", () => {
    void show(
      STATIC_DEMO ? "Opening the recorded reading of the sample photo." : "Reading the sample photo. Live, this takes about a minute.",
      () => (STATIC_DEMO ? fetch(`${BASE}photo-sample.json`) : fetch("/api/photo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: true }) })),
      SAMPLE_FIGURE,
    );
  });
}
