/**
 * Shopify Admin GraphQL client + order pull/normalization.
 *
 * Uses the validated query from the Hey Harper handoff:
 *   paid AND unfulfilled AND NOT partial AND NOT cancelled, created within a window.
 * Paginates on pageInfo.endCursor. Returns normalized orders with helper fields
 * pre-computed (released_hold_at, Everstox tag flags, per-line OOS) so the
 * classification logic (business-day lateness, thresholds, holidays) can live
 * in the caller and stay easy to tweak.
 */

import { API_VERSION, StoreConfig } from "./config.js";

export interface NormalizedLineItem {
  quantity: number;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  oos: boolean; // inventoryQuantity < quantity (null inventory => false)
}

export interface NormalizedOrder {
  store: string;          // store key, e.g. "uk"
  storeLabel: string;
  name: string;           // order name, e.g. "#1001" / "263844_1"
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  tags: string[];
  countryCode: string | null;
  // helper flags derived from tags:
  releasedHoldAt: string | null;   // ISO timestamp parsed from a released_hold_at_<ISO> tag
  hasReleasedHold: boolean;        // any tag beginning with "released_hold"
  hasOosEverstox: boolean;         // OOS_EVERSTOX present (intentional do-not-transmit; NOT inventory)
  hasHoldEverstox: boolean;        // HOLD_EVERSTOX present
  hasSetOnHold: boolean;           // any tag beginning with "set_on_hold"
  // inventory:
  storeAppliesOos: boolean;        // whether the OOS signal is meaningful for this store
  anyLineOos: boolean;             // any line item inventoryQuantity < quantity
  lineItems: NormalizedLineItem[];
}

const ORDERS_QUERY = `
query FlaggedOrders($after: String, $q: String!) {
  orders(first: 40, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      name
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      tags
      shippingAddress { countryCodeV2 }
      lineItems(first: 50) {
        edges { node { quantity title sku variant { inventoryQuantity } } }
      }
    } }
  }
}`;

interface RawOrderNode {
  name: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  tags: string[];
  shippingAddress: { countryCodeV2: string | null } | null;
  lineItems: {
    edges: { node: { quantity: number; title: string; sku: string | null; variant: { inventoryQuantity: number | null } | null } }[];
  };
}

export class ShopifyError extends Error {
  constructor(public store: string, message: string) {
    super(message);
    this.name = "ShopifyError";
  }
}

/** Parse released_hold_at_<ISO> style tags into an ISO timestamp, if present. */
function parseReleasedHoldAt(tags: string[]): string | null {
  for (const t of tags) {
    const lower = t.toLowerCase();
    if (lower.startsWith("released_hold_at")) {
      // strip the prefix and any leading separator, keep the rest as the timestamp
      const rest = t.replace(/^released_hold_at[_:\-\s]*/i, "").trim();
      const d = new Date(rest);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

function hasTagPrefix(tags: string[], prefix: string): boolean {
  const p = prefix.toLowerCase();
  return tags.some((t) => t.toLowerCase().startsWith(p));
}

function hasTagExact(tags: string[], value: string): boolean {
  const v = value.toLowerCase();
  return tags.some((t) => t.toLowerCase() === v);
}

function normalizeOrder(store: StoreConfig, node: RawOrderNode): NormalizedOrder {
  const tags = node.tags || [];
  const lineItems: NormalizedLineItem[] = (node.lineItems?.edges || []).map((e) => {
    const inv = e.node.variant?.inventoryQuantity ?? null;
    const oos = inv !== null && inv < e.node.quantity;
    return {
      quantity: e.node.quantity,
      title: e.node.title,
      sku: e.node.sku ?? null,
      inventoryQuantity: inv,
      oos,
    };
  });
  return {
    store: store.key,
    storeLabel: store.label,
    name: node.name,
    createdAt: node.createdAt,
    processedAt: node.processedAt ?? null,
    cancelledAt: node.cancelledAt ?? null,
    displayFinancialStatus: node.displayFinancialStatus ?? null,
    displayFulfillmentStatus: node.displayFulfillmentStatus ?? null,
    tags,
    countryCode: node.shippingAddress?.countryCodeV2 ?? null,
    releasedHoldAt: parseReleasedHoldAt(tags),
    hasReleasedHold: hasTagPrefix(tags, "released_hold"),
    hasOosEverstox: hasTagExact(tags, "OOS_EVERSTOX"),
    hasHoldEverstox: hasTagExact(tags, "HOLD_EVERSTOX"),
    hasSetOnHold: hasTagPrefix(tags, "set_on_hold"),
    storeAppliesOos: store.oos,
    anyLineOos: store.oos && lineItems.some((li) => li.oos),
    lineItems,
  };
}

/** Build the Shopify search query string for a given created_at lower bound (YYYY-MM-DD). */
function buildSearchQuery(sinceDate: string): string {
  return [
    "financial_status:paid",
    "AND fulfillment_status:unfulfilled",
    "AND -fulfillment_status:partial",
    "AND -status:cancelled",
    `AND created_at:>=${sinceDate}`,
  ].join(" ");
}

async function graphql<T>(store: StoreConfig, variables: Record<string, unknown>): Promise<T> {
  const url = `https://${store.domain}/admin/api/${API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": store.token,
        Accept: "application/json",
      },
      body: JSON.stringify({ query: ORDERS_QUERY, variables }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError(store.key, `auth failed (HTTP ${res.status}) — check the Admin API token and its scopes (needs read_orders, read_products, read_inventory).`);
    }
    if (res.status === 429) {
      throw new ShopifyError(store.key, "rate limited (HTTP 429) — try again shortly.");
    }
    if (!res.ok) {
      throw new ShopifyError(store.key, `Shopify API returned HTTP ${res.status}.`);
    }
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) {
      throw new ShopifyError(store.key, `GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    if (!json.data) {
      throw new ShopifyError(store.key, "empty response from Shopify.");
    }
    return json.data;
  } catch (err) {
    if (err instanceof ShopifyError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ShopifyError(store.key, "request timed out after 30s.");
    }
    throw new ShopifyError(store.key, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}

interface OrdersData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: RawOrderNode }[];
  };
}

/**
 * Pull all matching orders for one store, following cursor pagination to the end.
 * `sinceDays` sets the created_at lower bound (default 45).
 */
export async function pullStoreOrders(store: StoreConfig, sinceDays: number): Promise<NormalizedOrder[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString().slice(0, 10); // YYYY-MM-DD
  const q = buildSearchQuery(sinceDate);

  const out: NormalizedOrder[] = [];
  let after: string | null = null;
  // hard page cap as a runaway guard (40 * 50 = 2000 orders)
  for (let page = 0; page < 50; page++) {
    const data: OrdersData = await graphql<OrdersData>(store, { after, q });
    for (const edge of data.orders.edges) {
      out.push(normalizeOrder(store, edge.node));
    }
    if (data.orders.pageInfo.hasNextPage && data.orders.pageInfo.endCursor) {
      after = data.orders.pageInfo.endCursor;
    } else {
      break;
    }
  }
  return out;
}
