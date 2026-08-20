/**
 * Everstox (fulfilment backend) cross-check.
 *
 * Recovers tracking codes for orders that Everstox has already shipped but whose
 * tracking never synced back to Shopify (the order still shows unfulfilled there).
 *
 * We query the shipments endpoint filtered by order_number — a shipment only
 * exists once an order has actually shipped, so its presence IS the "shipped"
 * signal.
 *
 * Two auth modes (see loadEverstox):
 *   A) shop API token  -> header "everstox-shop-api-token"
 *   B) JWT dashboard login (email + password) -> Bearer token, re-login on 401
 */

import { EverstoxConfig } from "./config.js";

export interface Tracking {
  orderNumber: string;
  shipped: boolean;
  codes: string[];
  carrier: string | null;
  shipmentDate: string | null; // ISO
  url: string | null;
  error?: string;
}

interface RawShipment {
  carrier?: { name?: string } | null;
  shipment_date?: string | null;
  tracking_codes?: string[] | null;
  tracking_urls?: string[] | null;
}

function empty(orderNumber: string, error?: string): Tracking {
  return { orderNumber, shipped: false, codes: [], carrier: null, shipmentDate: null, url: null, ...(error ? { error } : {}) };
}

/** Small auth helper: holds the current auth header and can re-login (JWT mode). */
class Auth {
  private token: string | null = null;
  constructor(private cfg: EverstoxConfig) {}

  private async login(): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
    });
    if (!res.ok) throw new Error(`Everstox auth failed HTTP ${res.status}`);
    const data = (await res.json()) as { auth_token?: string };
    if (!data.auth_token) throw new Error("Everstox auth: no auth_token in response");
    this.token = data.auth_token;
  }

  /** Ensure we have credentials ready; returns the header object to send. */
  async headers(): Promise<Record<string, string>> {
    if (this.cfg.shopApiToken) return { "everstox-shop-api-token": this.cfg.shopApiToken };
    if (!this.token) await this.login();
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Force a fresh token (JWT mode); no-op for shop-token mode. */
  async relogin(): Promise<void> {
    if (this.cfg.shopApiToken) return;
    await this.login();
  }

  get usesJwt(): boolean {
    return !this.cfg.shopApiToken;
  }
}

async function fetchOne(cfg: EverstoxConfig, auth: Auth, orderNumber: string): Promise<Tracking> {
  const url = `${cfg.baseUrl}/shops/${cfg.shopId}/shipments?order_number=${encodeURIComponent(orderNumber)}&limit=10`;

  async function attempt(): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = { ...(await auth.headers()), Accept: "application/json" };
      return await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    let res = await attempt();
    if (res.status === 401 && auth.usesJwt) {
      await auth.relogin();
      res = await attempt();
    }
    if (!res.ok) return empty(orderNumber, `Everstox HTTP ${res.status}`);
    const json = (await res.json()) as { items?: RawShipment[] };
    const items = json.items || [];
    const codes: string[] = [];
    let carrier: string | null = null;
    let shipmentDate: string | null = null;
    let trackingUrl: string | null = null;
    for (const s of items) {
      for (const c of s.tracking_codes || []) if (c) codes.push(c);
      carrier = carrier || s.carrier?.name || null;
      shipmentDate = shipmentDate || s.shipment_date || null;
      trackingUrl = trackingUrl || (s.tracking_urls && s.tracking_urls[0]) || null;
    }
    return { orderNumber, shipped: codes.length > 0, codes, carrier, shipmentDate, url: trackingUrl };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : err instanceof Error ? err.message : String(err);
    return empty(orderNumber, msg);
  }
}

/**
 * Look up tracking for a list of order numbers, with bounded concurrency.
 * Returns a map keyed by order number. Never throws — per-order errors are
 * captured on the Tracking record. If the initial login fails (JWT mode),
 * every order is returned with that error rather than throwing.
 */
export async function getTracking(cfg: EverstoxConfig, orderNumbers: string[]): Promise<Record<string, Tracking>> {
  const out: Record<string, Tracking> = {};
  const unique = [...new Set(orderNumbers)];
  if (unique.length === 0) return out;

  const auth = new Auth(cfg);
  // Prime auth once so concurrent workers don't all try to log in.
  try {
    await auth.headers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const on of unique) out[on] = empty(on, msg);
    return out;
  }

  const CONCURRENCY = 6;
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const on = unique[i++];
      out[on] = await fetchOne(cfg, auth, on);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return out;
}
