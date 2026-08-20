/**
 * Store registry, built from environment variables.
 *
 * For each store you want live, set BOTH:
 *   HH_<KEY>_DOMAIN   e.g. HH_UK_DOMAIN=hey-harper-shop-uk.myshopify.com
 *   HH_<KEY>_TOKEN    e.g. HH_UK_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Only stores that have BOTH a domain and a token are enabled — so you can
 * roll out one store at a time without breaking the others.
 *
 * `oos: true` means the out-of-stock check is meaningful for this store.
 * Per the Hey Harper spec, US is single-warehouse-redirected and multi-location,
 * so OOS is NOT applied there (oos: false). This flag is surfaced to the caller;
 * the server does not itself decide "needs attention".
 */

export interface StoreConfig {
  key: string;        // short id, e.g. "uk"
  label: string;      // human label, e.g. "Hey Harper UK"
  domain: string;     // myshopify domain
  token: string;      // Admin API access token (shpat_...)
  warehouse: string;  // fulfilment warehouse (for reference / TZ decisions)
  timezone: string;   // IANA tz of the warehouse, for business-day math downstream
  oos: boolean;       // whether the OOS check applies to this store
}

interface StoreSeed {
  key: string;
  label: string;
  defaultDomain?: string;
  warehouse: string;
  timezone: string;
  oos: boolean;
}

// Static per-store facts from the Hey Harper spec. Domains/tokens come from env.
const SEEDS: StoreSeed[] = [
  { key: "us", label: "Hey Harper Shop US", warehouse: "United States",        timezone: "America/New_York",  oos: false },
  { key: "eu", label: "Hey Harper EU",      warehouse: "Germany",              timezone: "Europe/Berlin",     oos: true  },
  { key: "uk", label: "Hey Harper UK",      warehouse: "England",              timezone: "Europe/London",     oos: true, defaultDomain: "hey-harper-shop-uk.myshopify.com" },
  { key: "br", label: "Hey Harper BR",      warehouse: "Sao Paulo, Brazil",    timezone: "America/Sao_Paulo", oos: true  },
  { key: "mx", label: "Hey Harper MX",      warehouse: "Mexico City, Mexico",  timezone: "America/Mexico_City", oos: true },
];

export function loadStores(): StoreConfig[] {
  const stores: StoreConfig[] = [];
  for (const seed of SEEDS) {
    const envKey = seed.key.toUpperCase();
    const domain = process.env[`HH_${envKey}_DOMAIN`] || seed.defaultDomain || "";
    const token = process.env[`HH_${envKey}_TOKEN`] || "";
    if (domain && token) {
      stores.push({
        key: seed.key,
        label: seed.label,
        domain,
        token,
        warehouse: seed.warehouse,
        timezone: seed.timezone,
        oos: seed.oos,
      });
    }
  }
  return stores;
}

export const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
export const CHARACTER_LIMIT = 100000; // orders payloads can be large; generous cap

// Business-day lateness threshold (JD prefers 2). Override with LATE_BUSINESS_DAYS.
export const LATE_BUSINESS_DAYS = parseInt(process.env.LATE_BUSINESS_DAYS || "2", 10);

// Static per-store lookups (derived from SEEDS) for classification/report building.
export const STORE_TZ: Record<string, string> = Object.fromEntries(
  SEEDS.map((s) => [s.key, s.timezone]),
);
export const STORE_LABEL_SHORT: Record<string, string> = {
  us: "US",
  eu: "EU",
  uk: "UK",
  br: "BR",
  mx: "MX",
};

// ---- Everstox (fulfilment backend) ----
// Used to recover tracking codes for orders shipped in Everstox but not yet
// synced back to Shopify. Two auth modes (matching the Python client):
//   A) shop API token  -> header "everstox-shop-api-token"
//   B) JWT dashboard login (email + password) -> Bearer token, auto-refresh
// Needs baseUrl + shopId + (shopApiToken OR (email AND password)); otherwise
// the cross-check is skipped gracefully.
export interface EverstoxConfig {
  baseUrl: string;
  shopId: string;
  shopApiToken?: string;
  email?: string;
  password?: string;
}
export function loadEverstox(): EverstoxConfig | null {
  const baseUrl = (process.env.EVERSTOX_BASE_URL || "").replace(/\/$/, "");
  const shopId = process.env.EVERSTOX_SHOP_ID || "";
  const shopApiToken = process.env.EVERSTOX_SHOP_API_TOKEN || "";
  const email = process.env.EVERSTOX_EMAIL || "";
  const password = process.env.EVERSTOX_PASSWORD || "";
  if (!baseUrl || !shopId) return null;
  if (shopApiToken) return { baseUrl, shopId, shopApiToken };
  if (email && password) return { baseUrl, shopId, email, password };
  return null;
}
