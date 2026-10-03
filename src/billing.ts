/**
 * Billing tier — Polar "Kultranz Data Pass — $5 lifetime".
 *
 * Three access classes on the REST routes, checked in this order:
 *
 *   1. RapidAPI  — X-RapidAPI-Proxy-Secret / X-RapidAPI-Subscription-Secret
 *                  (or a Bearer / X-Api-Key credential) equal to
 *                  RAPIDAPI_PROXY_SECRET: unlimited, unmetered — RapidAPI
 *                  meters keys and billing at its proxy.
 *   2. Licensed  — a Polar license key in `Authorization: Bearer <key>` or
 *                  `X-Api-Key: <key>`, validated against Polar with a 24h
 *                  D1-cached verdict: unlimited.
 *   3. Free tier — anything else: 25 GET requests/day per hashed IP, metered
 *                  in D1. Over quota → 429 pointing at /billing/buy.
 *
 * All of this activates only when both POLAR_ACCESS_TOKEN and POLAR_PRODUCT_ID
 * are set. Without them index.ts runs the legacy RapidAPI-only gate and none
 * of this code executes — the Worker behaves exactly as before the billing
 * launch (graceful degradation).
 *
 * /mcp is deliberately untouched: it keeps its own opt-in MCP_API_KEY gate in
 * mcp.ts, and a Polar license key is NOT accepted there.
 *
 * D1 tables, created lazily on first use (launch-grade; no migration needed).
 * Keys and IPs are always SHA-256 hashed before touching D1 — never stored raw:
 *
 *   licenses(key_hash TEXT PRIMARY KEY, status TEXT, validated_at INTEGER)
 *   api_usage(ip_hash TEXT, day TEXT, count INTEGER, PRIMARY KEY(ip_hash, day))
 */
import type { Context } from "hono";

export interface BillingEnv {
  DB?: D1Database;
  RAPIDAPI_PROXY_SECRET?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_ID?: string;
}

/** BillingEnv with the Polar secrets narrowed to required strings. */
export type PolarEnv = BillingEnv & { POLAR_ACCESS_TOKEN: string; POLAR_PRODUCT_ID: string };

const POLAR_API = "https://api.polar.sh/v1";
const SUCCESS_URL = "https://kultranz.com/pages/api-docs/?welcome=lifetime";
const BUY_URL = "https://api.kultranz.com/billing/buy";
const FREE_TIER_LIMIT = 25;
const LICENSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** True only when the deployment can talk to Polar (both secrets set). */
export function billingConfigured(env: BillingEnv | undefined): env is PolarEnv {
  return typeof env?.POLAR_ACCESS_TOKEN === "string" && env.POLAR_ACCESS_TOKEN.length > 0 &&
    typeof env?.POLAR_PRODUCT_ID === "string" && env.POLAR_PRODUCT_ID.length > 0;
}

// ---------------------------------------------------------------------------
// hashing — keys and IPs are never stored raw
// ---------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// D1: lazy table creation
// ---------------------------------------------------------------------------
// Ensured once per D1 binding object per isolate. CREATE IF NOT EXISTS is
// idempotent, so a fresh binding object just pays one extra round-trip.
const ensuredTables = new WeakSet<object>();

async function ensureTables(db: D1Database): Promise<void> {
  if (ensuredTables.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS licenses (key_hash TEXT PRIMARY KEY, status TEXT, validated_at INTEGER)",
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS api_usage (ip_hash TEXT, day TEXT, count INTEGER, PRIMARY KEY (ip_hash, day))",
  ).run();
  ensuredTables.add(db);
}

// ---------------------------------------------------------------------------
// GET /billing/buy — mint a Polar checkout session on demand and redirect
// ---------------------------------------------------------------------------
export async function handleBuy(c: Context, env: BillingEnv | undefined): Promise<Response> {
  if (!billingConfigured(env)) {
    return c.json({
      error: { code: "billing_disabled", message: "Billing is not configured on this deployment." },
    }, 503);
  }
  // Sessions expire after 24h, so mint on demand — never cache, never reuse.
  let url: string | undefined;
  try {
    const res = await fetch(`${POLAR_API}/checkouts/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}` },
      body: JSON.stringify({ product_id: env.POLAR_PRODUCT_ID, success_url: SUCCESS_URL }),
    });
    if (!res.ok) throw new Error(`Polar answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    url = body?.url;
    if (!url) throw new Error("Polar response had no checkout url");
  } catch {
    return c.json({
      error: { code: "polar_error", message: "Could not create a Polar checkout session. Try again shortly." },
    }, 502);
  }
  c.header("Cache-Control", "no-store");
  return c.redirect(url, 302);
}

// ---------------------------------------------------------------------------
// license validation
// ---------------------------------------------------------------------------
// Polar's validate answers 200 with the license-key object (status "granted")
// for a usable key and 404 for anything else. Be defensive about the shape:
// honour an explicit `valid` boolean if present, else `status === "granted"`,
// else trust the 200 itself. Returns null when the body gives no verdict.
function interpretValidation(body: unknown): "valid" | "invalid" | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.valid === "boolean") return b.valid ? "valid" : "invalid";
  if (typeof b.status === "string") return b.status === "granted" ? "valid" : "invalid";
  return "valid";
}

async function checkLicense(env: PolarEnv, key: string): Promise<"valid" | "invalid"> {
  const hash = await sha256Hex(key);

  // 24h cached verdict first (key is stored hashed, never raw).
  if (env.DB) {
    try {
      await ensureTables(env.DB);
      const row = await env.DB
        .prepare("SELECT status, validated_at FROM licenses WHERE key_hash = ?")
        .bind(hash)
        .first<{ status: string; validated_at: number }>();
      if (row && Date.now() - row.validated_at < LICENSE_CACHE_TTL_MS) {
        return row.status === "valid" ? "valid" : "invalid";
      }
    } catch { /* cache read failed → fall through and ask Polar */ }
  }

  let verdict: "valid" | "invalid" | null = null;
  try {
    const res = await fetch(`${POLAR_API}/license-keys/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}` },
      body: JSON.stringify({ key }),
    });
    if (res.status === 404) {
      verdict = "invalid";
    } else if (res.ok) {
      verdict = interpretValidation(await res.json().catch(() => null));
    }
    // Any other outcome (401 bad token, 422 malformed, 5xx, network fault) is
    // a non-verdict: fail closed for this request but cache nothing — a blip
    // on Polar's side must not lock a paying key out for 24h.
  } catch { /* network fault → non-verdict */ }
  if (!verdict) return "invalid";

  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO licenses (key_hash, status, validated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key_hash) DO UPDATE SET status = excluded.status, validated_at = excluded.validated_at",
      ).bind(hash, verdict, Date.now()).run();
    } catch { /* cache write failed → the verdict still stands */ }
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// the gate — runs in index.ts's middleware when billingConfigured(env)
// ---------------------------------------------------------------------------
// Returns a short-circuit Response (401 / 405 / 429) or null to let the
// request through. RapidAPI first (cheapest, no I/O), then license, then the
// free tier.
export async function authorizeRest(c: Context, env: PolarEnv): Promise<Response | null> {
  // 1. RapidAPI tier.
  const secret = env.RAPIDAPI_PROXY_SECRET;
  const bearer = bearerOf(c);
  const apiKey = (c.req.header("X-Api-Key") || "").trim();
  if (secret && (
    c.req.header("X-RapidAPI-Proxy-Secret") === secret ||
    c.req.header("X-RapidAPI-Subscription-Secret") === secret ||
    bearer === secret ||
    apiKey === secret
  )) {
    return null;
  }

  // 2. License tier: a credential that is not the RapidAPI secret can only be
  //    a Polar license key — validate it, fail closed on anything uncertain.
  const key = bearer || apiKey;
  if (key) {
    const status = await checkLicense(env, key);
    if (status === "valid") return null;
    return c.json({
      error: {
        code: "invalid_license",
        message: `Invalid or expired license key. Get one for $5 (lifetime): ${BUY_URL}`,
      },
    }, 401);
  }

  // 3. Free tier.
  return freeTier(c, env);
}

function bearerOf(c: Context): string {
  const auth = c.req.header("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

async function freeTier(c: Context, env: PolarEnv): Promise<Response | null> {
  const method = c.req.method;
  // CORS preflights carry no credentials and return no data — never blocked,
  // never metered.
  if (method === "OPTIONS") return null;
  if (method !== "GET" && method !== "HEAD") {
    return c.json({
      error: {
        code: "method_not_allowed",
        message: `Free tier is GET-only. Get a $5 lifetime key: ${BUY_URL}`,
      },
    }, 405);
  }
  const ip = c.req.header("CF-Connecting-IP");
  // CF-Connecting-IP is always present on Cloudflare; absent means a non-CF
  // caller (local vitest) — nothing to meter, allow through.
  if (!ip || !env.DB) return null;

  try {
    await ensureTables(env.DB);
    const day = new Date().toISOString().slice(0, 10); // UTC day key
    const ipHash = await sha256Hex(ip);
    // Atomic increment-and-read: concurrent requests cannot undercount.
    const row = await env.DB.prepare(
      "INSERT INTO api_usage (ip_hash, day, count) VALUES (?, ?, 1) " +
      "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 RETURNING count",
    ).bind(ipHash, day).first<{ count: number }>();
    const count = row?.count ?? 1;
    if (count > FREE_TIER_LIMIT) {
      return c.json({
        error: {
          code: "rate_limited",
          message: `Free tier is ${FREE_TIER_LIMIT} requests/day. Get a $5 lifetime key: ${BUY_URL}`,
        },
      }, 429);
    }
  } catch { /* metering unavailable → fail open, the API stays up */ }
  return null;
}
