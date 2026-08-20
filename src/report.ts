/**
 * "Orders Requiring Attention" report builder.
 *
 * Turns the normalized cross-store order pull into the finalized daily report:
 *   1. classify each order (late / OOS / excluded) per the Hey Harper spec
 *   2. re-route US-store orders shipping outside US/CA into the EU tab
 *      (they fulfil from the German warehouse)
 *   3. fold in Everstox tracking so "shipped but tracking not synced to Shopify"
 *      is separated from "genuinely not shipped yet"
 *
 * Classification rules (JD, finalized):
 *   clock    = releasedHoldAt if a released_hold tag exists, else processedAt
 *   late     = business days since clock >= LATE_BUSINESS_DAYS (weekends excluded, warehouse TZ)
 *   oos      = anyLineOos (server already restricts this to OOS-applicable stores)
 *   excluded = OOS_EVERSTOX, or HOLD_EVERSTOX without released_hold,
 *              or set_on_hold without released_hold
 *   needs_attention = (late OR oos) AND NOT excluded
 */

import { NormalizedOrder } from "./shopify.js";
import { STORE_TZ, STORE_LABEL_SHORT, LATE_BUSINESS_DAYS } from "./config.js";
import { Tracking } from "./everstox.js";

export interface FlaggedOrder {
  store: string; // originating store key
  tab: string; // display tab after re-routing (us/eu/uk/br/mx)
  name: string;
  country: string | null;
  businessDaysLate: number;
  late: boolean;
  oos: boolean;
  reason: string;
  rerouted: boolean; // moved from US to EU tab
  // tracking (filled after Everstox cross-check):
  shipped: boolean;
  trackingCodes: string[];
  carrier: string | null;
  shipmentDate: string | null;
  trackingUrl: string | null;
}

/** Calendar date (YYYY-MM-DD) of an instant in a given IANA timezone. */
function localDateStr(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Business days strictly after `clock`'s local date, up to & including today (weekends excluded). */
function businessDaysSince(clockIso: string, tz: string, nowIso: string): number {
  const start = new Date(localDateStr(clockIso, tz) + "T00:00:00Z");
  const today = new Date(localDateStr(nowIso, tz) + "T00:00:00Z");
  let n = 0;
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d <= today) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/** Classify one store's orders into the needs-attention set. `nowIso` injected for testability. */
export function classifyStore(orders: NormalizedOrder[], storeKey: string, nowIso: string): FlaggedOrder[] {
  const tz = STORE_TZ[storeKey] || "UTC";
  const out: FlaggedOrder[] = [];
  for (const o of orders) {
    const excluded =
      o.hasOosEverstox ||
      (o.hasHoldEverstox && !o.hasReleasedHold) ||
      (o.hasSetOnHold && !o.hasReleasedHold);
    if (excluded) continue;
    const clock = o.hasReleasedHold && o.releasedHoldAt ? o.releasedHoldAt : o.processedAt || o.createdAt;
    const bd = businessDaysSince(clock, tz, nowIso);
    const late = bd >= LATE_BUSINESS_DAYS;
    const oos = o.anyLineOos;
    if (!(late || oos)) continue;

    // Re-route: US-store orders NOT shipping to US/CA fulfil from Germany -> EU tab.
    // Unknown destination (null) stays under US and is flagged downstream.
    const rerouted = storeKey === "us" && !!o.countryCode && !["US", "CA"].includes(o.countryCode);
    const tab = rerouted ? "eu" : storeKey;

    const reasons: string[] = [];
    if (late) reasons.push(`${bd}bd late`);
    if (oos) reasons.push("OOS");

    out.push({
      store: storeKey,
      tab,
      name: o.name,
      country: o.countryCode,
      businessDaysLate: bd,
      late,
      oos,
      reason: reasons.join(", "),
      rerouted,
      shipped: false,
      trackingCodes: [],
      carrier: null,
      shipmentDate: null,
      trackingUrl: null,
    });
  }
  return out;
}

/** Merge Everstox tracking into flagged orders (mutates and returns them). */
export function applyTracking(flagged: FlaggedOrder[], tracking: Record<string, Tracking>): FlaggedOrder[] {
  for (const f of flagged) {
    const t = tracking[f.name];
    if (t && t.shipped) {
      f.shipped = true;
      f.trackingCodes = t.codes;
      f.carrier = t.carrier;
      f.shipmentDate = t.shipmentDate;
      f.trackingUrl = t.url;
    }
  }
  return flagged;
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Build the Slack-ready markdown report. */
export function buildMarkdown(flagged: FlaggedOrder[], nowIso: string, opts?: { test?: boolean }): string {
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(nowIso));

  const tabs = ["us", "eu", "uk", "br", "mx"].filter((t) => flagged.some((f) => f.tab === t));
  const total = flagged.length;
  const shippedTotal = flagged.filter((f) => f.shipped).length;

  const L: string[] = [];
  L.push(`:package: **Orders Requiring Attention** — ${today}`);
  L.push(`_Scope: paid, not cancelled, fully unfulfilled | Everstox holds excluded | US→EU re-routed by destination_`);
  L.push(
    `**${total} orders need action** across ${tabs.length} tab(s) · **${shippedTotal} already shipped in Everstox** (recover tracking) · **${total - shippedTotal} genuinely unshipped**` +
      (opts?.test ? "  :test_tube: _(test run)_" : ""),
  );
  L.push("");

  for (const tab of tabs) {
    const rows = flagged.filter((f) => f.tab === tab);
    const shipped = rows.filter((f) => f.shipped);
    const unshipped = rows.filter((f) => !f.shipped);
    L.push(`**${STORE_LABEL_SHORT[tab]} — ${rows.length} need action** _(${shipped.length} shipped · ${unshipped.length} unshipped)_`);

    if (shipped.length) {
      L.push(`  :white_check_mark: _Shipped in Everstox — push tracking to Shopify:_`);
      shipped
        .sort((a, b) => b.businessDaysLate - a.businessDaysLate)
        .forEach((f) => {
          const from = f.rerouted ? " [from US]" : "";
          L.push(`   • \`${f.name}\`${from} — ${f.carrier ?? "?"} \`${f.trackingCodes.join(", ")}\` (shipped ${shortDate(f.shipmentDate)})`);
        });
    }
    if (unshipped.length) {
      L.push(`  :hourglass_flowing_sand: _Not shipped yet — chase fulfilment:_`);
      unshipped
        .sort((a, b) => b.businessDaysLate - a.businessDaysLate)
        .forEach((f) => {
          const from = f.rerouted ? " [from US]" : "";
          const c = f.country ?? "?";
          L.push(`   • \`${f.name}\` — ${f.reason} · ${c}${from}`);
        });
    }
    L.push("");
  }
  return L.join("\n").trimEnd();
}
