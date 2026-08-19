# Hey Harper multi-store Shopify MCP server

A tiny remote MCP server that holds **all five Hey Harper stores'** permanent Shopify Admin API tokens and pulls unfulfilled / needs-attention candidate orders across every store in **one connection** — no `switch-shop`, no per-store OAuth re-auth. This is what makes the daily "orders requiring attention" report runnable unattended.

## Why this exists

The official Shopify connector holds one store at a time and forces an OAuth re-authorization on every store switch — impossible to automate for a scheduled job. This server sidesteps that entirely by using **custom-app Admin API tokens** (permanent, no OAuth) and querying all stores directly.

## Tools it exposes

| Tool | What it does |
|------|--------------|
| `heyharper_list_stores` | Lists the stores currently configured (domain + token both set). |
| `heyharper_pull_store_orders` | Pulls unfulfilled orders for one store (`store`, `since_days`). |
| `heyharper_pull_all_stores` | **The main one.** Pulls unfulfilled orders across ALL stores in a single call, with per-store error isolation. |

It returns each order **normalized and enriched** (parsed `released_hold_at`, Everstox tag flags, per-line `oos`) but deliberately does **not** decide "needs attention" — the business-day lateness threshold, the OOS rule (EU/UK/BR/MX only), and the Everstox exclusions stay in your Cowork task so you can tweak thresholds and add holiday calendars without redeploying.

---

## Setup — step by step

### 1. Create a custom app + token in EACH store

In every Hey Harper store admin (US, EU, UK, BR, MX):

1. **Settings → Apps and sales channels → Develop apps** → **Create an app** (name it e.g. `cowork-unfulfilled-reader`).
2. **Configure Admin API scopes** and enable (read-only is enough):
   - `read_orders`
   - `read_all_orders` *(lets you query orders older than 60 days)*
   - `read_products`
   - `read_inventory`
   - `read_fulfillments`
   - `read_merchant_managed_fulfillment_orders`
3. **Install app**, then under **API credentials** reveal the **Admin API access token** (`shpat_…`). Copy it.
4. Note the store's **myshopify domain** (e.g. `hey-harper-shop-uk.myshopify.com`).

You'll end up with five `(domain, token)` pairs. **Never commit these or paste them into a chat** — they go straight into the host's secret store in step 3.

### 2. Deploy the server

The repo ships a `Dockerfile`, so any container host works (Render, Railway, Fly.io, a VPS). It must have normal internet access and a **public HTTPS URL**.

**Render (example, simplest):**
- New → **Web Service** → connect this repo (or "Deploy from a Dockerfile").
- Render auto-detects the Dockerfile. No build/start command needed.
- It provides HTTPS + a public URL automatically.

**Fly.io / Railway:** point them at the Dockerfile the same way.

**Local test:**
```bash
npm install
npm run build
MCP_AUTH_TOKEN=$(openssl rand -hex 32) HH_UK_DOMAIN=hey-harper-shop-uk.myshopify.com HH_UK_TOKEN=shpat_xxx npm start
# health check:
curl localhost:3000/health
```

### 3. Set environment secrets on the host

Copy `.env.example` for reference and set these in your host's env/secrets UI:

- `MCP_AUTH_TOKEN` — a long random string (`openssl rand -hex 32`). **Set this** — it's the bearer token protecting your endpoint.
- `HH_US_DOMAIN` / `HH_US_TOKEN`, `HH_EU_*`, `HH_UK_*`, `HH_BR_*`, `HH_MX_*` — the pairs from step 1.

A store only goes live when **both** its domain and token are set, so you can start with UK and add the rest as you generate tokens.

### 4. Add it to Claude as a custom connector

In **claude.ai → Settings → Connectors → Add custom connector**:

- **URL:** `https://<your-host>/mcp`
- **Auth:** provide the bearer token (`MCP_AUTH_TOKEN`) so requests send `Authorization: Bearer <token>`.

> If the connector UI can't attach a static header in your plan, an alternative is to set `MCP_PATH` to an unguessable path (e.g. `/mcp/9f3c…`) and use that as the URL — the secret path then acts as the credential. Bearer token is preferred where supported.

Once connected, `heyharper_list_stores`, `heyharper_pull_store_orders`, and `heyharper_pull_all_stores` appear as tools.

### 5. Wire up the daily report

Point your daily 9am Cowork task at `heyharper_pull_all_stores`, then apply the classification logic (kept in the task, per the handoff spec):

```
clock    = releasedHoldAt if hasReleasedHold else processedAt
late     = business_days_since(clock) >= 2      (weekends excluded, warehouse TZ)
shop_oos = anyLineOos                            (only where storeAppliesOos)
excluded = hasOosEverstox OR (hasHoldEverstox AND NOT hasReleasedHold)
           OR (hasSetOnHold AND NOT hasReleasedHold)
needs_attention = (late OR shop_oos) AND NOT excluded
```

Post the roll-up to `#daily-unfulfilled`.

---

## Security notes

- Tokens live only in the host's env/secrets — never in the repo (`.env` is gitignored).
- Always set `MCP_AUTH_TOKEN` before exposing the URL publicly; the server logs a warning if it's missing.
- All tools are read-only (`read_*` scopes only) — the server cannot modify your stores.

## Environment variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `MCP_AUTH_TOKEN` | recommended | — | Bearer token for the endpoint. If unset, endpoint is open. |
| `MCP_PATH` | no | `/mcp` | Endpoint path. |
| `PORT` | no | `3000` | Usually set by the host. |
| `SHOPIFY_API_VERSION` | no | `2024-10` | Admin API version. |
| `HH_<KEY>_DOMAIN` | per store | — | KEY ∈ US, EU, UK, BR, MX. |
| `HH_<KEY>_TOKEN` | per store | — | `shpat_…` Admin API access token. |
