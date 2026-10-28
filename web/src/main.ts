// Loads Linda's runs from the server and keeps the page in step with the tab, the
// memory switch and the address bar (#september, #october, #october-check-4).
// ?household=marcus loads Marcus's held bill instead (held.ts).

import { BASE, STATIC_DEMO } from "./env.ts";
import "./styles.css";
import type { DemoPayload } from "../../src/demo.ts";
import { pageView, type PageView } from "./model.ts";
import { failure, friendlyError, panel, parseHash, skeleton, stripHint, tabKey, tabWhen, todayInOhio, type Tab } from "./view.ts";
import { wirePhoto } from "./photo.ts";
import { liveQueries } from "./live.ts";
import { loadHeld } from "./held.ts";

interface State {
  readonly tab: Tab;
  readonly memoryOn: boolean;
}

const TABS: readonly Tab[] = ["first", "second"];
/** Today in Columbus, read once when the page loads, so every tab and re-render says the same date. */
const TODAY = todayInOhio();

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html.`);
  return el;
};

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const touchOnly = (): boolean => window.matchMedia("(hover: none)").matches;

/** The one live region on the page; it stays put across renders so readers announce it. */
const announce = (text: string): void => {
  const live = $("live");
  live.textContent = "";
  window.setTimeout(() => {
    live.textContent = text;
  }, 30);
};

const inView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
};

/** Reading one day of the weather chart: pointer, tap, or the slider keys. */
function wireStrip(root: HTMLElement, hint: string): void {
  const plot = root.querySelector<HTMLElement>(".plot");
  const out = root.querySelector<HTMLElement>("#readout");
  if (!plot || !out) return;
  out.textContent = hint;
  plot.setAttribute("aria-valuetext", hint);
  const cells = [...plot.querySelectorAll<HTMLElement>(".day")];
  let current = -1;
  const text = (cell: HTMLElement): string => cell.dataset.text ?? "";
  const show = (i: number, speak: boolean): void => {
    const k = Math.max(0, Math.min(cells.length - 1, i));
    if (k !== current) {
      cells[current]?.classList.remove("is-on");
      current = k;
      cells[k].classList.add("is-on");
      out.textContent = text(cells[k]);
      plot.setAttribute("aria-valuenow", String(k + 1));
      plot.setAttribute("aria-valuetext", out.textContent);
    }
    // The slider announces its own value; a tap or click goes through the live region.
    if (speak) announce(out.textContent ?? "");
  };
  const at = (e: PointerEvent): number => {
    const r = plot.getBoundingClientRect();
    return Math.floor(((e.clientX - r.left) / r.width) * cells.length);
  };
  const reset = (): void => {
    cells[current]?.classList.remove("is-on");
    current = -1;
    out.textContent = hint;
  };
  plot.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") show(at(e), false);
  });
  plot.addEventListener("pointerdown", (e) => show(at(e), true));
  plot.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && document.activeElement !== plot) reset();
  });
  plot.addEventListener("blur", reset);
  // Keyboard users learn the keys when they reach the chart, so the resting line stays short.
  plot.addEventListener("focus", () => {
    if (current < 0) out.textContent = "Use the left and right arrow keys to move from day to day.";
  });
  plot.addEventListener("keydown", (e) => {
    const steps: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 7, PageDown: -7 };
    let next: number | null = null;
    if (e.key in steps) next = current < 0 ? 0 : current + steps[e.key];
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = cells.length - 1;
    if (next === null) return;
    e.preventDefault();
    show(next, false);
  });
}

/** The chart's reading guide, opened and closed in place. */
function wireStripMore(root: HTMLElement, onChange: (open: boolean) => void): void {
  const btn = root.querySelector<HTMLButtonElement>("#stripMore");
  const box = root.querySelector<HTMLElement>("#strip-more");
  if (!btn || !box) return;
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    box.hidden = !open;
    onChange(open);
  });
}

/**
 * The weather row shades both bills on the chart. Hover only shades when the chart is on
 * screen; the button keeps the shading, brings the chart into view and moves focus to the
 * chart's own "Clear the shading", so the focused control is never left off screen.
 */
function wireWeather(root: HTMLElement, pinnedBefore: boolean): void {
  const stripEl = root.querySelector<HTMLElement>("#strip");
  const row = root.querySelector<HTMLElement>(".is-weather-row");
  const btn = row?.querySelector<HTMLButtonElement>(".weather-btn");
  const clear = root.querySelector<HTMLButtonElement>("#clearShade");
  if (!stripEl || !row || !btn || !clear) return;
  const pinned = (): boolean => btn.getAttribute("aria-pressed") === "true";
  const shade = (on: boolean): void => {
    stripEl.classList.toggle("is-weather", on);
  };
  const pin = (on: boolean): void => {
    btn.setAttribute("aria-pressed", String(on));
    clear.hidden = !on;
    shade(on);
  };
  row.addEventListener("pointerenter", () => {
    if (inView(stripEl)) shade(true);
  });
  row.addEventListener("pointerleave", () => shade(pinned()));
  btn.addEventListener("click", () => {
    const on = !pinned();
    pin(on);
    if (!on) return;
    if (!inView(stripEl)) stripEl.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
    clear.focus({ preventScroll: true });
    announce("Both bills are shaded on the weather chart.");
  });
  clear.addEventListener("click", () => {
    pin(false);
    btn.focus();
    announce("Shading cleared.");
  });
  if (pinnedBefore) pin(true);
}

/** Tells the sticky checks column its own height, so a tall column can still show its end. */
function wireSticky(root: HTMLElement): void {
  const sec = root.querySelector<HTMLElement>(".checks-sec");
  if (!sec) return;
  const set = (): void => sec.style.setProperty("--ck-h", `${sec.offsetHeight}px`);
  new ResizeObserver(set).observe(sec);
  set();
}

/** The bill picture opens full size in a dialog; closing it gives focus back to the picture. */
function wireBill(root: HTMLElement): void {
  const open = root.querySelector<HTMLButtonElement>("#billOpen");
  const dialog = root.querySelector<HTMLDialogElement>("#billDialog");
  const close = root.querySelector<HTMLButtonElement>("#billClose");
  if (!open || !dialog || !close) return;
  open.addEventListener("click", () => dialog.showModal());
  close.addEventListener("click", () => dialog.close());
  // A click on the dimmed backdrop lands on the dialog itself, outside its content.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => open.focus());
}

/** The note form under "Tell us what changed at home". Nothing is saved; the page says so. */
function wireNote(root: HTMLElement): void {
  const open = root.querySelector<HTMLButtonElement>("#noteOpen");
  const form = root.querySelector<HTMLFormElement>("#noteForm");
  const text = root.querySelector<HTMLTextAreaElement>("#noteText");
  const result = root.querySelector<HTMLElement>("#noteResult");
  if (!open || !form || !text || !result) return;
  open.addEventListener("click", () => {
    const show = form.hidden;
    form.hidden = !show;
    open.setAttribute("aria-expanded", String(show));
    if (show) text.focus();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const words = text.value.trim();
    result.hidden = false;
    result.classList.toggle("is-empty", words === "");
    // textContent, never innerHTML: what the visitor types is shown as text.
    result.textContent =
      words === ""
        ? "Write a few words first, for example who stayed with you or what you bought."
        : `Your note would read: “${words}”${/[.!?]$/.test(words) ? "" : "."} It is not saved.`;
    announce(result.textContent);
  });
}

function setTabsReady(ready: boolean): void {
  for (const t of TABS) $(`tab-${t}`).setAttribute("aria-disabled", String(!ready));
}

function render(page: PageView, state: State, onToggle: () => void, opts: { keep?: boolean; focusSwitch?: boolean; scrollTo?: string | null } = {}): void {
  const second = state.tab === "second";
  const root = $("panel");
  // Kept across a re-render of the same bill: open disclosures, the weather shading, the chart guide.
  const openKeys = opts.keep ? [...root.querySelectorAll<HTMLDetailsElement>("details[data-key]")].filter((d) => d.open).map((d) => d.dataset.key) : [];
  const pinned = opts.keep ? root.querySelector(".weather-btn")?.getAttribute("aria-pressed") === "true" : false;
  const stripMore = opts.keep ? root.querySelector("#stripMore")?.getAttribute("aria-expanded") === "true" : false;

  $("household").textContent = `${page.household.name}, ${page.household.utility} residential, ${page.household.city}`;
  $("tab-first-label").textContent = page.first.tabLabel;
  $("tab-first-when").textContent = tabWhen(page.first);
  $("tab-second-label").textContent = page.withMemory.tabLabel;
  $("tab-second-when").textContent = tabWhen(page.withMemory);
  setTabsReady(true);
  for (const [id, on] of [["tab-first", !second], ["tab-second", second]] as const) {
    $(id).setAttribute("aria-selected", String(on));
    $(id).tabIndex = on ? 0 : -1;
  }
  const tabpanel = $("page");
  tabpanel.setAttribute("aria-labelledby", second ? "tab-second" : "tab-first");
  // The entrance plays when a bill is shown, not when the switch changes the reading.
  tabpanel.classList.toggle("settled", opts.keep === true);
  root.innerHTML = panel(page, state.tab, state.memoryOn, TODAY, { stripMore });
  tabpanel.setAttribute("aria-busy", "false");

  for (const k of openKeys) {
    const d = root.querySelector<HTMLDetailsElement>(`details[data-key="${k}"]`);
    if (d) d.open = true;
  }
  wireStrip(root, stripHint(touchOnly()));
  wireStripMore(root, () => undefined);
  wireWeather(root, pinned);
  wireNote(root);
  wireBill(root);
  wireSticky(root);
  const sw = document.getElementById("memSwitch");
  sw?.addEventListener("click", onToggle);
  if (opts.focusSwitch) sw?.focus();
  if (opts.scrollTo) {
    const target = document.getElementById(opts.scrollTo);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }
}

async function load(): Promise<void> {
  let page: PageView | null = null;
  let state: State = { tab: "first", memoryOn: true };
  let pendingHash = location.hash;
  const keys = (): Record<Tab, string> | null => (page ? { first: tabKey(page.first), second: tabKey(page.withMemory) } : null);
  const writeHash = (): void => {
    const k = keys();
    if (k) history.replaceState(null, "", `#${k[state.tab]}`);
  };

  const toggle = (): void => {
    state = { ...state, memoryOn: !state.memoryOn };
    if (!page) return;
    render(page, state, toggle, { keep: true, focusSwitch: true });
    announce(document.querySelector(".reading")?.textContent ?? "");
  };
  const choose = (tab: Tab, focus: boolean): void => {
    if (!page) return; // tabs are disabled until there is something to show
    if (state.tab !== tab) {
      state = { ...state, tab };
      render(page, state, toggle);
      writeHash();
    }
    if (focus) $(`tab-${tab}`).focus();
  };

  TABS.forEach((tab, i) => {
    const el = $(`tab-${tab}`);
    el.addEventListener("click", () => choose(tab, false));
    el.addEventListener("keydown", (e) => {
      const to: Readonly<Record<string, number>> = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 };
      if (!(e.key in to)) return;
      e.preventDefault();
      choose(TABS[to[e.key]], true);
    });
  });
  // The skip link goes to the headline without touching the address bar, which holds the tab.
  document.querySelector(".skip")?.addEventListener("click", (e) => {
    const target = document.querySelector<HTMLElement>(".headline") ?? document.querySelector<HTMLElement>("#retry");
    if (!target) return;
    e.preventDefault();
    target.focus();
  });
  window.addEventListener("hashchange", () => {
    const k = keys();
    if (!k || !page) return;
    const { tab, target } = parseHash(location.hash, k);
    if (tab && tab !== state.tab) {
      state = { ...state, tab };
      render(page, state, toggle, { scrollTo: target });
    }
  });

  // Live, the server works the demo out on the first visit: the list shows each query meanwhile,
  // then folds into one line under the explanation. A demo already worked out sends no queries.
  const liveRoot = document.getElementById("demoLive");
  const live = liveRoot && !STATIC_DEMO ? liveQueries(liveRoot, { stream: "/api/events?for=demo", foldWhenDone: true }) : null;

  const start = async (fromRetry: boolean): Promise<void> => {
    setTabsReady(false);
    $("page").setAttribute("aria-busy", "true");
    $("panel").innerHTML = skeleton();
    if (liveRoot) $("page").prepend(liveRoot);
    live?.start();
    try {
      const res = await fetch(STATIC_DEMO ? `${BASE}demo.json` : "/api/demo");
      const body = (await res.json().catch(() => null)) as DemoPayload | { error: string } | null;
      if (body === null || !res.ok || "error" in body) throw new Error(`The demo service answered ${res.status}.`);
      page = pageView(body);
      const k = keys();
      const wanted = k ? parseHash(pendingHash, k) : { tab: null, target: null };
      pendingHash = "";
      if (wanted.tab) state = { ...state, tab: wanted.tab };
      render(page, state, toggle, { scrollTo: wanted.target });
      if (!wanted.target) writeHash();
      if (fromRetry) document.querySelector<HTMLElement>(".headline")?.focus();
    } catch (error: unknown) {
      // The page never shows the raw message; it stays in the console for whoever runs the demo.
      console.error("Why So High could not load the demo:", error);
      $("page").setAttribute("aria-busy", "false");
      $("household").textContent = "Could not load the household";
      $("panel").innerHTML = failure(friendlyError(error));
      const retry = $("retry");
      retry.addEventListener("click", () => void start(true));
      retry.focus();
    } finally {
      live?.stop();
      if (liveRoot && page) $("page").append(liveRoot);
    }
  };
  await start(false);
}

/** The switch between the two sample households; the online copy only has Linda's recorded runs. */
function wireHouseholds(marcus: boolean): void {
  if (STATIC_DEMO) return;
  $("households").hidden = false;
  $(marcus ? "hh-marcus" : "hh-linda").setAttribute("aria-current", "page");
}

const marcus = new URLSearchParams(location.search).get("household") === "marcus";
wirePhoto();
wireHouseholds(marcus);
void (marcus ? loadHeld() : load());
