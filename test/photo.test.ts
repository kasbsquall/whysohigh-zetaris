import { describe, expect, it } from "vitest";
import { photoResult } from "../web/src/photo.ts";

const GAP_REASON = "Published tariff gives 163.57 USD but the bill says 183.20 USD: 19.63 USD (10.7%) more than the 2% allowed.";
const WHY = "Your bill is 19.63 USD above what AEP Ohio's published tariff gives for the same use. Ask AEP Ohio to explain the difference first; it may be a charge the published tariff does not list.";

/** The read of eval-29's photo on 28 Oct: a sample bill billed above the tariff on purpose. */
const overcharged = (complaint: boolean) =>
  ({
    status: "success",
    output: {
      bill: { periodStart: "05/11/2026", periodEnd: "06/11/2026", days: 31, kwh: 863, totalUsd: 183.2, previous: { kwh: 756, days: 31, totalUsd: 145.62 } },
      rate: { verdicts: [{ check: "bill_recompute", accepted: false, reason: GAP_REASON }], possibleBillingErrorUsd: 19.63 },
      change: { verdicts: [], skipped: "This bill does not match the published tariff, so its change cannot be split until that gap is resolved.", decomposition: null },
      words: null,
      actions: { actions: complaint ? [{ id: "puco_complaint", why: WHY, status: "recommended" }] : [] },
    },
  }) as const;

describe("a bill above the published tariff", () => {
  it("sets what the bill says against what the tariff gives, with the gap as the headline", () => {
    const html = photoResult(overcharged(true));
    expect(html).toContain("This bill is <span class=\"num\">$19.63</span> above AEP Ohio's published tariff");
    expect(html).toMatch(/The bill says<\/dt><dd class="num">\$183\.20</);
    expect(html).toMatch(/AEP Ohio's published tariff, same 863 kWh<\/dt><dd class="num">\$163\.57</);
  });

  it("says what to do, keeping the caveat that the tariff may miss a charge", () => {
    const html = photoResult(overcharged(true));
    expect(html).toContain("Your bill is $19.63 above what AEP Ohio&#39;s published tariff gives");
    expect(html).toContain("it may be a charge the published tariff does not list");
    expect(html).toContain("Call AEP Ohio first at 800-672-2231");
    expect(html).toContain("File a complaint online");
    expect(html).toContain("Published tariff gives $163.57 but the bill says $183.20: $19.63 (10.7%) more than the 2% allowed.");
    expect(html).toContain('href="tel:+18006867826"');
  });

  it("still asks the household to check with AEP Ohio when no complaint was proposed", () => {
    const html = photoResult(overcharged(false));
    expect(html).toContain("It is worth asking AEP Ohio about it.");
    expect(html).not.toContain("PUCO");
  });
});
