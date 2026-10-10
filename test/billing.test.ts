// Billing tier tests — Polar checkout (/billing/buy), license-key auth, the
// free tier, RapidAPI-gate precedence, and graceful degradation when the
// Polar secrets are unset. fetch is stubbed with vi.stubGlobal; D1 is an
// in-memory stub (mirrors the fakeD1 pattern in mcp.test.ts, extended with
// first()/run() and state for the two lazily created tables).
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import app from "../src/index";

const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: "polar-token",
  POLAR_PRODUCT_ID: "5c66c3b2-8151-4b8c-81e0-8591c819e25e",
};

const CHECKOUT_URL = "https://checkout.polar.sh/c/sess_123";
const LICENSE_KEY = "pol_1a2b3c_lifetime";
// Cross-checked with node:crypto against the Worker's crypto.subtle path.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Polar fetch mock
// ---------------------------------------------------------------------------
type PolarOpts = {
  checkoutStatus?: number;
  checkoutBody?: unknown;      // defaults to { url: CHECKOUT_URL }
  licenseStatus?: number;      // defaults to 200
  licenseBody?: unknown;       // defaults to { status: "granted" }
  reject?: boolean;            // simulate a network fault
};

function polarFetch(opts: PolarOpts = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (opts.reject) throw new TypeError("network down");
    const u = String(url);
    if (u.includes("/v1/checkouts")) {
      const body = opts.checkoutBody !== undefined ? opts.checkoutBody : { url: CHECKOUT_URL };
      return new Response(JSON.stringify(body), { status: opts.checkoutStatus ?? 200 });
    }
    if (u.includes("/v1/license-keys/validate")) {
      const body = opts.licenseBody !== undefined ? opts.licenseBody : { status: "granted", id: "lk_1" };
      return new Response(JSON.stringify(body), { status: opts.licenseStatus ?? 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

/** fetch mock that fails the test if the Worker calls Polar at all. */
function noPolarFetch() {
  return vi.fn(async () => { throw new Error("Polar must not be called in this test"); });
}

// ---------------------------------------------------------------------------
// In-memory D1 stub
// ---------------------------------------------------------------------------
type Stmt = { sql: string; args: unknown[] };

function memoryD1(failUsageWrite = false) {
  const licenses = new Map<string, { status: string; validated_at: number }>();
  const usage = new Map<string, number>(); // `${ip_hash}|${day}` -> count
  const fails = new Map<string, number>(); // validation_fails: `${ip_hash}|${day}` -> count
  const stmts: Stmt[] = [];
  const creates: string[] = [];

  const route = (sql: string, args: unknown[], kind: "first" | "run"): unknown => {
    stmts.push({ sql, args });
    if (sql.startsWith("CREATE TABLE")) { creates.push(sql); return { success: true }; }
    if (sql.startsWith("SELECT status, validated_at FROM licenses")) {
      return licenses.get(String(args[0])) ?? null;
    }
    if (sql.startsWith("INSERT INTO licenses")) {
      licenses.set(String(args[0]), { status: String(args[1]), validated_at: Number(args[2]) });
      return { success: true };
    }
    if (sql.startsWith("INSERT INTO api_usage")) {
      if (failUsageWrite && kind === "first") throw new Error("D1 unavailable");
      const k = `${args[0]}|${args[1]}`;
      const n = (usage.get(k) ?? 0) + 1;
      usage.set(k, n);
      return { count: n };
    }
    if (sql.startsWith("SELECT count FROM validation_fails")) {
      const n = fails.get(`${args[0]}|${args[1]}`);
      return n === undefined ? null : { count: n };
    }
    if (sql.startsWith("INSERT INTO validation_fails")) {
      const k = `${args[0]}|${args[1]}`;
      fails.set(k, (fails.get(k) ?? 0) + 1);
      return { success: true };
    }
    return kind === "first" ? null : { success: true };
  };

  const db = {
    prepare(sql: string) {
      const terminal = (args: unknown[]) => ({
        first: async () => route(sql, args, "first"),
        run: async () => route(sql, args, "run"),
        all: async () => ({ results: [] }),
      });
      return { bind: (...args: unknown[]) => terminal(args), ...terminal([]) };
    },
  } as unknown as D1Database;

  return { db, licenses, usage, fails, stmts, creates };
}

// ---------------------------------------------------------------------------
// request helper
// ---------------------------------------------------------------------------
type HitOpts = { env?: Record<string, unknown>; headers?: Record<string, string>; method?: string };

async function hit(path: string, opts: HitOpts = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await app.request(path, { method: opts.method ?? "GET", headers: opts.headers }, opts.env as never);
  let body: any = null;
  try { body = await res.json(); } catch { /* 302 redirect has no JSON body */ }
  return { status: res.status, headers: res.headers, body };
}

const IP = { "CF-Connecting-IP": "203.0.113.7" };
const OTHER_IP = { "CF-Connecting-IP": "198.51.100.99" };
const RATE_LIMITED_BODY = {
  error: {
    code: "rate_limited",
    message: "Free tier is 25 requests/day. Get a $5 lifetime key: https://api.kultranz.com/billing/buy",
  },
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// GET /billing/buy
// ---------------------------------------------------------------------------
describe("/billing/buy", () => {
  it("302-redirects to a freshly minted Polar checkout (no-store)", async () => {
    const fetchMock = polarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/billing/buy", { env: { ...POLAR_ENV } });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(CHECKOUT_URL);
    expect(r.headers.get("Cache-Control")).toBe("no-store");

    // Exact Polar payload: evergreen product checkout, minted on demand.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.polar.sh/v1/checkouts/");
    const init = call[1]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer polar-token");
    expect(JSON.parse(init.body as string)).toEqual({
      product_id: "5c66c3b2-8151-4b8c-81e0-8591c819e25e",
      success_url: "https://kultranz.com/pages/api-docs/?welcome=lifetime",
    });
  });

  it("502 when Polar errors (non-2xx)", async () => {
    vi.stubGlobal("fetch", polarFetch({ checkoutStatus: 500 }));
    const r = await hit("/billing/buy", { env: { ...POLAR_ENV } });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("polar_error");
  });

  it("502 when Polar answers 200 without a checkout url", async () => {
    vi.stubGlobal("fetch", polarFetch({ checkoutBody: { id: "co_1" } }));
    const r = await hit("/billing/buy", { env: { ...POLAR_ENV } });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("polar_error");
  });

  it("502 when the Polar call throws (network fault)", async () => {
    vi.stubGlobal("fetch", polarFetch({ reject: true }));
    const r = await hit("/billing/buy", { env: { ...POLAR_ENV } });
    expect(r.status).toBe(502);
  });

  it("503 when the Polar secrets are unset — and Polar is never called", async () => {
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/billing/buy", { env: {} });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("billing_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays reachable with no credentials even when the RapidAPI gate is armed", async () => {
    // The 429 body links here; an anonymous over-quota user must reach it.
    vi.stubGlobal("fetch", polarFetch());
    const r = await hit("/billing/buy", { env: { ...POLAR_ENV, RAPIDAPI_PROXY_SECRET: "rs" } });
    expect(r.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// license-key auth
// ---------------------------------------------------------------------------
describe("license auth", () => {
  it("valid Bearer key → unlimited access; verdict cached hashed, never raw", async () => {
    const mem = memoryD1();
    const fetchMock = polarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}`, ...IP },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.net).toBeGreaterThan(0);

    // Polar called once with the raw key over TLS...
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.polar.sh/v1/license-keys/validate");
    expect(JSON.parse(call[1]!.body as string)).toEqual({ key: LICENSE_KEY });

    // ...and only the SHA-256 hash landed in D1.
    const cached = mem.licenses.get(sha(LICENSE_KEY));
    expect(cached).toBeDefined();
    expect(cached?.status).toBe("valid");
    expect(Math.abs(cached!.validated_at - Date.now())).toBeLessThan(60_000);
    expect([...mem.licenses.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    expect([...mem.usage.keys()]).toHaveLength(0); // licensed ≠ metered
  });
  it("sends organization_id in the validate body when POLAR_ORG_ID is set (Polar 2026-10 API)", async () => {
    const mem = memoryD1();
    const fetchMock = polarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { ...POLAR_ENV, DB: mem.db, POLAR_ORG_ID: "org-uuid-test" },
      headers: { Authorization: `Bearer ${LICENSE_KEY}`, ...IP },
    });
    expect(r.status).toBe(200);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.polar.sh/v1/license-keys/validate");
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      key: LICENSE_KEY,
      organization_id: "org-uuid-test",
    });
  });

  it("valid key via X-Api-Key header → unlimited access", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch());
    const r = await hit("/tax-brackets?state=NY", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { "X-Api-Key": LICENSE_KEY, ...IP },
    });
    expect(r.status).toBe(200);
    expect(mem.usage.size).toBe(0);
  });

  it("invalid key (Polar 404) → 401, invalid verdict cached", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ licenseStatus: 404, licenseBody: { error: "not_found" } }));
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: "Bearer pol_bogus" },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_license");
    expect(mem.licenses.get(sha("pol_bogus"))?.status).toBe("invalid");
  });

  it("cached valid verdict (fresh) → no Polar call", async () => {
    const mem = memoryD1();
    mem.licenses.set(sha(LICENSE_KEY), { status: "valid", validated_at: Date.now() });
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}` },
    });
    expect(r.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cached invalid verdict (fresh) → 401 without calling Polar", async () => {
    const mem = memoryD1();
    mem.licenses.set(sha(LICENSE_KEY), { status: "invalid", validated_at: Date.now() });
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}` },
    });
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stale cache (older than 24h) is revalidated against Polar", async () => {
    const mem = memoryD1();
    mem.licenses.set(sha(LICENSE_KEY), { status: "invalid", validated_at: Date.now() - 25 * 3600 * 1000 });
    const fetchMock = polarFetch(); // Polar now says granted
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}` },
    });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mem.licenses.get(sha(LICENSE_KEY))?.status).toBe("valid"); // re-cached
  });

  it("Polar 200 with {valid: false} → 401 (defensive shape handling)", async () => {
    vi.stubGlobal("fetch", polarFetch({ licenseBody: { valid: false } }));
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: memoryD1().db },
      headers: { Authorization: "Bearer pol_revoked" },
    });
    expect(r.status).toBe(401);
  });

  it("Polar unreachable → fail closed, nothing cached", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ reject: true }));
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}` },
    });
    expect(r.status).toBe(401);
    expect(mem.licenses.size).toBe(0);
  });

  it("a Bearer key equal to the RapidAPI secret is RapidAPI traffic, not a license", async () => {
    const mem = memoryD1();
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, RAPIDAPI_PROXY_SECRET: "rs", DB: mem.db },
      headers: { Authorization: "Bearer rs", ...IP },
    });
    expect(r.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.usage.size).toBe(0);
  });

  it("a valid license skips the rate limit the same IP is already out of", async () => {
    const mem = memoryD1();
    // Exhaust the anonymous quota for this IP first.
    for (let i = 0; i < 25; i++) {
      const r = await hit("/col-index", { env: { ...POLAR_ENV, DB: mem.db }, headers: { ...IP } });
      expect(r.status).toBe(200);
    }
    const blocked = await hit("/col-index", { env: { ...POLAR_ENV, DB: mem.db }, headers: { ...IP } });
    expect(blocked.status).toBe(429);
    // The same IP with a valid key sails through, unmetered.
    vi.stubGlobal("fetch", polarFetch());
    const licensed = await hit("/col-index", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: `Bearer ${LICENSE_KEY}`, ...IP },
    });
    expect(licensed.status).toBe(200);
    expect(mem.usage.get(`${sha("203.0.113.7")}|${new Date().toISOString().slice(0, 10)}`)).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// anti-probe meter: definitive Polar validation misses per hashed IP (20/day)
// ---------------------------------------------------------------------------
describe("anti-probe meter", () => {
  it("ambiguous Polar 200 (no valid/status field) fails closed and caches nothing", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ licenseBody: { id: "lk_1", key: "pol_x" } }));
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { Authorization: "Bearer pol_ambiguous" },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_license");
    expect(mem.licenses.size).toBe(0); // nothing cached
    expect(mem.fails.size).toBe(0);    // ambiguous ≠ definitive miss — not counted
  });

  it("20 definitive misses: 401 each + negative-cache row each; 21st → 401 with NO Polar call and NO new row", async () => {
    const mem = memoryD1();
    const probing = polarFetch({ licenseStatus: 404, licenseBody: { error: "not_found" } });
    vi.stubGlobal("fetch", probing);
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 20; i++) {
      const r = await hit("/paycheck?salary=100000&state=TX", {
        env,
        headers: { Authorization: `Bearer pol_guess_${i}`, ...IP },
      });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("invalid_license");
    }
    expect(probing).toHaveBeenCalledTimes(20);       // one Polar call per guess…
    expect(mem.licenses.size).toBe(20);             // …and one negative-cache row each — now capped
    expect([...mem.fails.values()][0]).toBe(20);

    // 21st attempt from the same IP: 401 served locally, Polar untouched.
    const after = polarFetch({ licenseStatus: 200, licenseBody: { status: "granted" } });
    vi.stubGlobal("fetch", after);
    const r21 = await hit("/paycheck?salary=100000&state=TX", {
      env,
      headers: { Authorization: "Bearer pol_guess_20", ...IP },
    });
    expect(r21.status).toBe(401);
    expect(r21.body.error.code).toBe("invalid_license");
    expect(after).not.toHaveBeenCalled();
    expect(mem.licenses.size).toBe(20); // no new negative-cache row either
  });

  it("the block is scoped to validation attempts, not the whole request path", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ licenseStatus: 404 }));
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 20; i++) {
      await hit("/paycheck?salary=100000&state=TX", {
        env,
        headers: { Authorization: `Bearer pol_guess_${i}`, ...IP },
      });
    }
    // Anonymous free-tier traffic from the SAME IP still works and meters
    // normally — the prober's block is not everyone's on that IP.
    const anon = await hit("/col-index", { env, headers: { ...IP } });
    expect(anon.status).toBe(200);
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(mem.usage.get(`${sha("203.0.113.7")}|${dayKey}`)).toBe(1);
  });

  it("a verdict cached before the block is still honoured", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ licenseStatus: 404 }));
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 20; i++) {
      await hit("/paycheck?salary=100000&state=TX", {
        env,
        headers: { Authorization: `Bearer pol_guess_${i}`, ...IP },
      });
    }
    // A key validated VALID before the block keeps working from that IP.
    mem.licenses.set(sha("pol_paying"), { status: "valid", validated_at: Date.now() });
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env,
      headers: { Authorization: "Bearer pol_paying", ...IP },
    });
    expect(r.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("another IP is unaffected by the block", async () => {
    const mem = memoryD1();
    vi.stubGlobal("fetch", polarFetch({ licenseStatus: 404 }));
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 20; i++) {
      await hit("/paycheck?salary=100000&state=TX", {
        env,
        headers: { Authorization: `Bearer pol_guess_${i}`, ...IP },
      });
    }
    const fetchMock = polarFetch({ licenseStatus: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const other = await hit("/paycheck?salary=100000&state=TX", {
      env,
      headers: { Authorization: "Bearer pol_other_ip", ...OTHER_IP },
    });
    expect(other.status).toBe(401); // Polar still consulted for the other IP
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// free tier
// ---------------------------------------------------------------------------
describe("free tier", () => {
  it("anonymous GET passes and is metered once, keyed by hashed IP", async () => {
    const mem = memoryD1();
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { ...IP },
    });
    expect(r.status).toBe(200);
    expect(mem.usage.size).toBe(1);
    const [key, count] = [...mem.usage.entries()][0];
    expect(key).toBe(`${sha("203.0.113.7")}|${new Date().toISOString().slice(0, 10)}`);
    expect(key).not.toContain("203.0.113.7"); // stored hashed, never raw
    expect(count).toBe(1);
    // The three billing tables (licenses, api_usage, validation_fails)
    // are created lazily on first metered use.
    expect(mem.creates).toHaveLength(3);
  });

  it("requests 1-25 pass, 26 gets the 429 upsell body", async () => {
    const mem = memoryD1();
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 25; i++) {
      const r = await hit("/col-index", { env, headers: { ...IP } });
      expect(r.status).toBe(200);
    }
    const over = await hit("/col-index", { env, headers: { ...IP } });
    expect(over.status).toBe(429);
    expect(over.body).toEqual(RATE_LIMITED_BODY);
    // Denials still carry open CORS — a browser can read the envelope.
    expect(over.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Counter keeps counting past the cap (increment on every request).
    expect([...mem.usage.values()][0]).toBe(26);
  });

  it("each IP has its own bucket", async () => {
    const mem = memoryD1();
    const env = { ...POLAR_ENV, DB: mem.db };
    await hit("/col-index", { env, headers: { ...IP } });
    await hit("/col-index", { env, headers: { ...IP } });
    const other = await hit("/col-index", { env, headers: { ...OTHER_IP } });
    expect(other.status).toBe(200);
    expect(mem.usage.size).toBe(2);
    expect([...mem.usage.values()].sort()).toEqual([1, 2]);
  });

  it("free tier is GET-only: anonymous POST is 405 and unmetered", async () => {
    const mem = memoryD1();
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { ...IP },
      method: "POST",
    });
    expect(r.status).toBe(405);
    expect(r.body.error.code).toBe("method_not_allowed");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.body.error.message).toContain("https://api.kultranz.com/billing/buy");
    expect(mem.usage.size).toBe(0);
  });

  it("OPTIONS preflight is never blocked or metered (CORS must keep working)", async () => {
    const mem = memoryD1();
    const r = await hit("/paycheck?salary=100000&state=TX", {
      env: { ...POLAR_ENV, DB: mem.db },
      headers: { ...IP },
      method: "OPTIONS",
    });
    expect(r.status).toBe(204);
    expect(mem.usage.size).toBe(0);
  });

  it("no CF-Connecting-IP header (off-Cloudflare caller) → unmetered pass", async () => {
    const mem = memoryD1();
    const r = await hit("/col-index", { env: { ...POLAR_ENV, DB: mem.db } });
    expect(r.status).toBe(200);
    expect(mem.usage.size).toBe(0);
  });

  it("metering infrastructure failure → fail open (the API stays up)", async () => {
    const mem = memoryD1(true); // usage write throws
    const r = await hit("/col-index", { env: { ...POLAR_ENV, DB: mem.db }, headers: { ...IP } });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// precedence: RapidAPI secret vs license key vs free tier
// ---------------------------------------------------------------------------
describe("gate precedence", () => {
  it("RapidAPI secret still works with billing configured — no Polar, no metering", async () => {
    const mem = memoryD1();
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { ...POLAR_ENV, RAPIDAPI_PROXY_SECRET: "rs", DB: mem.db },
      headers: { "X-RapidAPI-Proxy-Secret": "rs", ...IP },
    });
    expect(r.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.usage.size).toBe(0);
  });

  it("wrong RapidAPI secret value + no key → falls to the free tier, not 401", async () => {
    const mem = memoryD1();
    const r = await hit("/col-index", {
      env: { ...POLAR_ENV, RAPIDAPI_PROXY_SECRET: "rs", DB: mem.db },
      headers: { "X-RapidAPI-Proxy-Secret": "not-the-secret", ...IP },
    });
    expect(r.status).toBe(200);
    expect(mem.usage.size).toBe(1);
  });

  it("billing off + RapidAPI secret set + anonymous → legacy 401 (exactly as today)", async () => {
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { RAPIDAPI_PROXY_SECRET: "rs", DB: memoryD1().db },
      headers: { ...IP },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect(r.body.error.message).toBe("Requests must go through RapidAPI.");
  });

  it("billing off + Bearer key → still the legacy 401 (license auth gracefully skipped)", async () => {
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { RAPIDAPI_PROXY_SECRET: "rs" },
      headers: { Authorization: `Bearer ${LICENSE_KEY}` },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("billing off + no secrets at all → fully open (local dev / free demo)", async () => {
    const r = await hit("/paycheck?salary=100000&state=TX", { env: {} });
    expect(r.status).toBe(200);
  });

  it("billing on + secret set + no credentials → free tier, not the legacy 401", async () => {
    const mem = memoryD1();
    const r = await hit("/col-index", {
      env: { ...POLAR_ENV, RAPIDAPI_PROXY_SECRET: "rs", DB: mem.db },
      headers: { ...IP },
    });
    expect(r.status).toBe(200);
    expect(mem.usage.size).toBe(1);
  });

  it("/mcp keeps its own gate: a license key does not open it", async () => {
    const fetchMock = noPolarFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...POLAR_ENV, MCP_API_KEY: "mcp-key" };

    // A Polar license key in Bearer is neither MCP_API_KEY nor the (unset)
    // RapidAPI secret → /mcp rejects it; billing never kicks in on /mcp.
    const withLicense = await hit("/mcp", {
      env,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LICENSE_KEY}`,
      },
    });
    expect(withLicense.status).toBe(401);
    expect(withLicense.body.error.code).toBe(-32001);

    // The real MCP key still works — untouched by the billing launch.
    const withMcpKey = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }, env as never);
    expect(withMcpKey.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/billing/buy is reachable after the free-tier quota is exhausted", async () => {
    const mem = memoryD1();
    const env = { ...POLAR_ENV, DB: mem.db };
    for (let i = 0; i < 26; i++) await hit("/col-index", { env, headers: { ...IP } });
    vi.stubGlobal("fetch", polarFetch());
    const r = await hit("/billing/buy", { env, headers: { ...IP } });
    expect(r.status).toBe(302);
  });

  it("CORS allows the X-Api-Key header (browser license holders)", async () => {
    const res = await app.request("/col-index", undefined, { ...POLAR_ENV } as never);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Api-Key");
  });

  it("the legacy RapidAPI 401 (billing off) carries open CORS", async () => {
    const r = await hit("/paycheck?salary=100000&state=CA", {
      env: { RAPIDAPI_PROXY_SECRET: "rs" },
      headers: { ...IP },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
