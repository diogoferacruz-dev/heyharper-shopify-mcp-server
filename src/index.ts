#!/usr/bin/env node
/**
 * Hey Harper multi-store Shopify MCP server.
 *
 * Holds every store's permanent Admin API token and exposes tools to pull
 * unfulfilled / needs-attention candidate orders across ALL stores in a single
 * connection — no switch-shop, no per-store OAuth re-auth. Built for the daily
 * "orders requiring attention" report.
 *
 * Transport: Streamable HTTP (stateless JSON) so it can be added to claude.ai
 * as a remote custom connector.
 */

import "dotenv/config"; // load a local .env file if present (no-op in hosts that inject env vars)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { loadStores, StoreConfig, CHARACTER_LIMIT, loadEverstox } from "./config.js";
import { pullStoreOrders, ShopifyError, NormalizedOrder } from "./shopify.js";
import { getTracking } from "./everstox.js";
import { classifyStore, applyTracking, buildMarkdown, FlaggedOrder } from "./report.js";
import { buildMatrixifyWorkbook, matrixifyFilename } from "./matrixify.js";

const STORES: StoreConfig[] = loadStores();

// ---- shared helpers -------------------------------------------------------

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

function storeByKey(key: string): StoreConfig | undefined {
  return STORES.find((s) => s.key === key.toLowerCase());
}

interface StorePullResult {
  store: string;
  storeLabel: string;
  ok: boolean;
  count: number;
  error?: string;
  orders: NormalizedOrder[];
}

async function pullOne(store: StoreConfig, sinceDays: number): Promise<StorePullResult> {
  try {
    const orders = await pullStoreOrders(store, sinceDays);
    return { store: store.key, storeLabel: store.label, ok: true, count: orders.length, orders };
  } catch (err) {
    const message = err instanceof ShopifyError ? err.message : err instanceof Error ? err.message : String(err);
    return { store: store.key, storeLabel: store.label, ok: false, count: 0, error: message, orders: [] };
  }
}

function ordersToMarkdown(results: StorePullResult[]): string {
  const lines: string[] = ["# Unfulfilled order pull", ""];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`## ${r.storeLabel} (${r.store}) — ERROR`);
      lines.push(`- ${r.error}`);
      lines.push("");
      continue;
    }
    lines.push(`## ${r.storeLabel} (${r.store}) — ${r.count} order(s)`);
    for (const o of r.orders) {
      const oos = o.anyLineOos ? " [OOS]" : "";
      const rel = o.releasedHoldAt ? ` released_hold_at=${o.releasedHoldAt}` : "";
      lines.push(`- ${o.name} | processed=${o.processedAt ?? o.createdAt} | ${o.countryCode ?? "?"}${oos}${rel} | tags: ${o.tags.join(", ") || "—"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildStructured(results: StorePullResult[], sinceDays: number) {
  return {
    sinceDays,
    generatedFields: {
      note: "Server returns normalized orders + helper flags. It does NOT decide needs_attention — apply business-day lateness / OOS / Everstox exclusion logic in the caller.",
    },
    stores: results.map((r) => ({
      store: r.store,
      storeLabel: r.storeLabel,
      ok: r.ok,
      count: r.count,
      error: r.error,
      orders: r.orders,
    })),
    totals: {
      storesOk: results.filter((r) => r.ok).length,
      storesFailed: results.filter((r) => !r.ok).length,
      totalOrders: results.reduce((n, r) => n + r.count, 0),
    },
  };
}

function packageResponse(results: StorePullResult[], sinceDays: number, format: ResponseFormat) {
  const structured = buildStructured(results, sinceDays);
  let text: string;
  if (format === ResponseFormat.MARKDOWN) {
    text = ordersToMarkdown(results);
  } else {
    text = JSON.stringify(structured, null, 2);
  }
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n... [truncated at ${CHARACTER_LIMIT} chars — request a single store or use response_format='json' with a downstream consumer that streams].`;
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

interface PipelineResult {
  generatedAt: string;
  flagged: FlaggedOrder[];
  storeErrors: { store: string; error: string }[];
  everstoxUsed: boolean;
}

// Shared "needs attention" pipeline: pull all stores -> classify -> fold in
// Everstox tracking. Used by both the daily report and the Matrixify export so
// the two can never diverge.
async function runNeedsAttentionPipeline(sinceDays: number): Promise<PipelineResult> {
  const generatedAt = new Date().toISOString();
  const results = await Promise.all(STORES.map((s) => pullOne(s, sinceDays)));

  const storeErrors: { store: string; error: string }[] = [];
  let flagged: FlaggedOrder[] = [];
  for (const r of results) {
    if (!r.ok) {
      storeErrors.push({ store: r.store, error: r.error || "unknown error" });
      continue;
    }
    flagged = flagged.concat(classifyStore(r.orders, r.store, generatedAt));
  }

  const ev = loadEverstox();
  let everstoxUsed = false;
  if (ev && flagged.length) {
    const tracking = await getTracking(ev, flagged.map((f) => f.name));
    applyTracking(flagged, tracking);
    everstoxUsed = true;
  }

  return { generatedAt, flagged, storeErrors, everstoxUsed };
}

// ---- server + tools -------------------------------------------------------

const server = new McpServer({
  name: "heyharper-shopify-mcp-server",
  version: "1.0.0",
});

const ListStoresSchema = z.object({}).strict();

server.registerTool(
  "heyharper_list_stores",
  {
    title: "List configured Hey Harper stores",
    description: `List every Hey Harper Shopify store this server is configured for (i.e. has both a domain and an Admin API token set in the environment).

Args: none.

Returns JSON:
{
  "stores": [
    { "key": "uk", "label": "Hey Harper UK", "domain": "hey-harper-shop-uk.myshopify.com",
      "warehouse": "England", "timezone": "Europe/London", "oosApplies": true }
  ],
  "count": number
}

Use this first to confirm which stores are live before pulling orders. "oosApplies" is false for US (out-of-stock check is not meaningful there).`,
    inputSchema: ListStoresSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const output = {
      stores: STORES.map((s) => ({
        key: s.key,
        label: s.label,
        domain: s.domain,
        warehouse: s.warehouse,
        timezone: s.timezone,
        oosApplies: s.oos,
      })),
      count: STORES.length,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

const PullStoreSchema = z
  .object({
    store: z.string().min(2).max(4).describe("Store key from heyharper_list_stores, e.g. 'uk', 'eu', 'us', 'br', 'mx'."),
    since_days: z.number().int().min(1).max(365).default(45).describe("How many days back to pull by created_at (default 45; the report widens beyond 30 so recently-released holds are caught)."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.JSON).describe("'json' for full structured data (default) or 'markdown' for a human-readable summary."),
  })
  .strict();

server.registerTool(
  "heyharper_pull_store_orders",
  {
    title: "Pull unfulfilled orders for one Hey Harper store",
    description: `Pull all PAID, NOT-cancelled, FULLY-unfulfilled orders (partials excluded) for a single Hey Harper store, created within the last since_days. Follows Shopify cursor pagination to completion.

Each order is normalized and enriched with helper fields so the caller can classify:
- releasedHoldAt: ISO timestamp parsed from a released_hold_at_<ISO> tag (else null)
- hasReleasedHold / hasOosEverstox / hasHoldEverstox / hasSetOnHold: tag flags
- lineItems[].oos and anyLineOos: inventoryQuantity < quantity (only meaningful where storeAppliesOos is true)

This tool does NOT decide "needs attention" — apply the business-day lateness threshold, OOS rule, and Everstox exclusions downstream.

Args:
  - store (string): store key, e.g. 'uk'
  - since_days (number): days back by created_at (default 45)
  - response_format ('json' | 'markdown'): default 'json'

Returns (json): { sinceDays, stores: [{ store, storeLabel, ok, count, error, orders: [...] }], totals }

Errors: returns ok=false with an error message for that store (auth/scope/rate-limit/timeout) rather than throwing.`,
    inputSchema: PullStoreSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const store = storeByKey(params.store);
    if (!store) {
      const known = STORES.map((s) => s.key).join(", ") || "(none configured)";
      return {
        isError: true,
        content: [{ type: "text", text: `Error: unknown store '${params.store}'. Configured stores: ${known}. Set HH_<KEY>_DOMAIN and HH_<KEY>_TOKEN to enable a store.` }],
      };
    }
    const result = await pullOne(store, params.since_days);
    return packageResponse([result], params.since_days, params.response_format);
  },
);

const PullAllSchema = z
  .object({
    since_days: z.number().int().min(1).max(365).default(45).describe("How many days back to pull by created_at (default 45)."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.JSON).describe("'json' for full structured data (default) or 'markdown' for a human-readable summary."),
  })
  .strict();

server.registerTool(
  "heyharper_pull_all_stores",
  {
    title: "Pull unfulfilled orders across ALL Hey Harper stores",
    description: `The main tool for the daily report. Pulls PAID, NOT-cancelled, FULLY-unfulfilled orders (partials excluded) for EVERY configured store in one call, concurrently, with per-store error isolation. No store switching, no re-auth.

Same normalization and helper fields as heyharper_pull_store_orders. Does NOT decide "needs attention" — classify downstream (business-day lateness >= threshold, OOS on EU/UK/BR/MX only, exclude OOS_EVERSTOX and HOLD_EVERSTOX-without-released_hold).

Args:
  - since_days (number): days back by created_at (default 45)
  - response_format ('json' | 'markdown'): default 'json'

Returns (json): { sinceDays, stores: [ per-store { store, storeLabel, ok, count, error, orders } ], totals: { storesOk, storesFailed, totalOrders } }

A store that fails to authorize or times out is reported with ok=false and an error, NOT silently skipped.`,
    inputSchema: PullAllSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    if (STORES.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: no stores configured. Set HH_<KEY>_DOMAIN and HH_<KEY>_TOKEN env vars (KEY in US/EU/UK/BR/MX)." }],
      };
    }
    const results = await Promise.all(STORES.map((s) => pullOne(s, params.since_days)));
    return packageResponse(results, params.since_days, params.response_format);
  },
);

const GetTrackingSchema = z
  .object({
    order_numbers: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe("Order numbers (e.g. '284513_3', '533862_2') to look up in Everstox."),
  })
  .strict();

server.registerTool(
  "heyharper_get_tracking",
  {
    title: "Look up Everstox tracking for a list of orders",
    description: `Cross-check a list of order numbers against Everstox and return tracking for any that have already SHIPPED there. A shipment only exists once an order actually ships, so its presence means the order shipped even if Shopify still shows it unfulfilled (the tracking-not-synced case).

Args:
  - order_numbers (string[]): order numbers to check.

Returns (json): { everstoxConfigured, tracking: { "<order_number>": { shipped, codes[], carrier, shipmentDate, url, error? } } }

Requires EVERSTOX_BASE_URL, EVERSTOX_SHOP_API_TOKEN, EVERSTOX_SHOP_ID env vars; if unset, everstoxConfigured=false and no lookups run.`,
    inputSchema: GetTrackingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const ev = loadEverstox();
    if (!ev) {
      const out = { everstoxConfigured: false, tracking: {} };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
    const tracking = await getTracking(ev, params.order_numbers);
    const out = { everstoxConfigured: true, tracking };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
  },
);

const DailyReportSchema = z
  .object({
    since_days: z.number().int().min(1).max(365).default(45).describe("Days back to pull by created_at (default 45)."),
    test: z.boolean().default(false).describe("Mark the report as a test run (adds a test label to the markdown)."),
  })
  .strict();

server.registerTool(
  "heyharper_daily_report",
  {
    title: "Build the finalized daily 'Orders Requiring Attention' report",
    description: `The one-call daily report. Pulls PAID, NOT-cancelled, FULLY-unfulfilled orders across ALL stores, applies the finalized needs-attention rules, re-routes US-store orders shipping outside US/CA into the EU tab (they fulfil from Germany), and folds in Everstox tracking so already-shipped orders (tracking not synced to Shopify) are separated from genuinely-unshipped ones.

Rules: clock = released_hold_at if present else processed_at; late = business days since clock >= LATE_BUSINESS_DAYS (default 2, weekends excluded, warehouse TZ); oos = any line under stock on OOS-applicable stores; excluded = OOS_EVERSTOX, or HOLD_EVERSTOX/set_on_hold without released_hold.

Args:
  - since_days (number, default 45)
  - test (boolean, default false)

Returns: content[0].text is Slack-ready markdown (post it as-is to #daily-unfulfilled). structuredContent has { generatedAt, everstoxUsed, totals, storeErrors, flagged[] } for programmatic use.`,
    inputSchema: DailyReportSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    if (STORES.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: no stores configured. Set HH_<KEY>_DOMAIN and HH_<KEY>_TOKEN env vars." }],
      };
    }
    const { generatedAt: nowIso, flagged, storeErrors, everstoxUsed } =
      await runNeedsAttentionPipeline(params.since_days);

    const markdown = buildMarkdown(flagged, nowIso, { test: params.test });
    const structured = {
      generatedAt: nowIso,
      everstoxUsed,
      totals: {
        needsAction: flagged.length,
        shipped: flagged.filter((f) => f.shipped).length,
        unshipped: flagged.filter((f) => !f.shipped).length,
      },
      storeErrors,
      flagged,
    };
    let text = markdown;
    if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n... [truncated]";
    return { content: [{ type: "text", text }], structuredContent: structured };
  },
);

const MatrixifyExportSchema = z
  .object({
    since_days: z.number().int().min(1).max(365).default(45).describe("Days back to pull by created_at (default 45)."),
    notify_customer: z
      .boolean()
      .default(false)
      .describe("Value for the 'Fulfillment: Send Notification' column. false (default) = no shipping email is sent on import; true = Shopify emails the customer the tracking on import."),
  })
  .strict();

server.registerTool(
  "heyharper_matrixify_export",
  {
    title: "Export a Matrixify tracking-import workbook (base64 .xlsx)",
    description: `Runs the same needs-attention pipeline as heyharper_daily_report, then builds a Matrixify "Orders" tracking-import workbook containing ONLY the orders already shipped in Everstox (tracking code present) — the ones whose tracking needs pushing into Shopify. One sheet per store, named "Orders US" / "Orders EU" / "Orders UK", so Matrixify recognizes each as an Orders import.

Columns: Name, Fulfillment: Status (=success), Fulfillment: Tracking Number, Fulfillment: Tracking Company, Fulfillment: Tracking URL, Fulfillment: Send Notification.

Grouping is by the order's ORIGINATING store, not the display tab — US orders re-routed to the EU tab still export under "Orders US" because tracking is imported into the store the order lives in. US / EU / UK are separate Shopify stores: import each sheet into its own store (select just that sheet in the Matrixify preview).

Args:
  - since_days (number, default 45)
  - notify_customer (boolean, default false)

Returns: content[0].text is a short human summary. structuredContent = { generatedAt, filename, mimeType, base64, counts: { us, eu, uk }, total, notifyCustomer, storeErrors }. base64 is the .xlsx file — attach it directly (e.g. email it via a Gmail 'attachments' field).`,
    inputSchema: MatrixifyExportSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    if (STORES.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: no stores configured. Set HH_<KEY>_DOMAIN and HH_<KEY>_TOKEN env vars." }],
      };
    }
    const { generatedAt, flagged, storeErrors } = await runNeedsAttentionPipeline(params.since_days);
    const { buffer, counts, total } = buildMatrixifyWorkbook(flagged, { notify: params.notify_customer });
    const filename = matrixifyFilename(generatedAt);

    const structured = {
      generatedAt,
      filename,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buffer.toString("base64"),
      counts: { us: counts.us ?? 0, eu: counts.eu ?? 0, uk: counts.uk ?? 0 },
      total,
      notifyCustomer: params.notify_customer,
      storeErrors,
    };
    const summary =
      `Matrixify tracking workbook ${filename}: ${total} shipped order(s) ` +
      `(US ${structured.counts.us} · EU ${structured.counts.eu} · UK ${structured.counts.uk}), ` +
      `Send Notification=${params.notify_customer ? "TRUE" : "FALSE"}. ` +
      `base64 .xlsx is in structuredContent.base64.` +
      (storeErrors.length ? ` Store errors: ${storeErrors.map((e) => e.store).join(", ")}.` : "");
    return { content: [{ type: "text", text: summary }], structuredContent: structured };
  },
);

// ---- transport ------------------------------------------------------------

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const required = process.env.MCP_AUTH_TOKEN;
  if (!required) return next(); // auth disabled if no token configured
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${required}`;
  if (header !== expected) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

async function main() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health check for hosting platforms.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", stores: STORES.map((s) => s.key), storeCount: STORES.length });
  });

  // Browser-friendly self-test: hits each store's Shopify API and reports live
  // order counts. Enabled ONLY when ENABLE_SELFTEST=1 (leave it OFF in production).
  if (process.env.ENABLE_SELFTEST === "1") {
    app.get("/selftest", async (_req, res) => {
      const results = await Promise.all(
        STORES.map(async (s) => {
          try {
            const orders = await pullStoreOrders(s, 45);
            return { store: s.key, label: s.label, ok: true, unfulfilledOrders: orders.length, firstOrder: orders[0]?.name ?? null };
          } catch (e) {
            return { store: s.key, label: s.label, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      res.json({ selftest: true, note: "Live pull of paid+unfulfilled orders (last 45 days) per store.", stores: results });
    });
  }

  const mcpPath = process.env.MCP_PATH || "/mcp";
  app.post(mcpPath, authMiddleware, async (req, res) => {
    // Stateless: a fresh transport per request avoids request-id collisions.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`heyharper-shopify-mcp-server listening on :${port}${mcpPath}`);
    console.error(`Configured stores: ${STORES.map((s) => s.key).join(", ") || "(none — set HH_<KEY>_DOMAIN/TOKEN)"}`);
    if (!process.env.MCP_AUTH_TOKEN) {
      console.error("WARNING: MCP_AUTH_TOKEN not set — endpoint is unauthenticated. Set it before exposing publicly.");
    }
  });
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
