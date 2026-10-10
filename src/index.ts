import { Hono, type Context } from "hono";
import { secretMatches } from "./lib/secure-compare";
import { computeTakeHome, type FilingStatus, type TaxData } from "./lib/tax";
function round2(n: number): number { return Math.round(n * 100) / 100; }
import { compareCities, type CityRppMap } from "./lib/col";
import { compoundInterest, netWorth, debtPayoff, budget, budgetFull } from "./lib/finance";
import taxDataJson from "./data/tax_2026.json";
import cityRppJson from "./data/city_rpp.json";
import { handleMcp } from "./mcp";
import { authorizeRest, billingConfigured, handleBuy } from "./billing";
import { handleSubmit, handleRecent, handleAdmin } from "./submissions";

const TAX_DATA = taxDataJson as unknown as TaxData;
const CITIES = cityRppJson.cities as unknown as CityRppMap;
const META = {
  source: "BLS OEWS + BEA RPP + U.S. Census ACS + IRS (via kultranz.com)",
  vintage: "2026",
  year: 2026,
};

interface Env {
  DB: D1Database;
  RAPIDAPI_PROXY_SECRET?: string;
  MCP_API_KEY?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_ID?: string;
  ADMIN_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS open: RapidAPI proxies, and the kultranz.com demo page hits this directly.
app.use("*", async (c, next) => {
  // CORS headers go on BEFORE the auth gates below: a 401/405/429 denial is
  // still an API response a browser must be able to read — without ACAO the
  // page sees an opaque network error instead of the JSON envelope. (Asserted
  // again after next() at the bottom for responses built downstream.)
  c.header("Access-Control-Allow-Origin", "*");
  // POST/DELETE + the MCP headers: browser-based MCP clients (Streamable HTTP)
  // preflight against /mcp with these; harmless for the REST routes. X-Api-Key
  // is the browser-friendly carrier for Polar license keys.
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  c.header("Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, " +
    "X-RapidAPI-Proxy-Secret, X-RapidAPI-Subscription-Secret, X-Api-Key");
  // If RapidAPI proxy secret is configured, reject direct hits that bypass RapidAPI.
  // Only active when the env var is set — local dev and the free demo stay open.
  // /mcp is exempt from this RapidAPI gate: MCP is the free distribution
  // channel for what the site's public calculators already expose, and RapidAPI's
  // header injection does not reach native MCP clients. It carries its own
  // opt-in key instead — MCP_API_KEY, checked in mcp.ts — plus a per-hashed-IP
  // tool-call meter there, so "open" does not mean "unmetered". /billing/buy is
  // exempt too: it is the checkout entry point quoted in 429 responses and must
  // stay reachable with no credentials at all. The community endpoints
  // /salaries/submit and /salaries/recent are exempt as well: they are the
  // kultranz.com salary pages' own flywheel (submissions.ts) — anonymous
  // browser traffic by design, carrying their own rate limit, spam defenses
  // and moderation queue instead of the API-key tiers.
  const path = c.req.path;
  // Exact match: startsWith("/mcp") would also exempt /mcp<anything> from
  // every gate below, even though only /mcp itself is an MCP route.
  if (path !== "/mcp" && path !== "/billing/buy" &&
      path !== "/salaries/submit" && path !== "/salaries/recent" &&
      path !== "/admin/submissions") { // self-authenticated (ADMIN_KEY)
    if (billingConfigured(c.env)) {
      // Billing tier live (POLAR_* secrets set): RapidAPI secret or a valid
      // Polar license key → unlimited; anything else → free tier (25 GET
      // requests/day per hashed IP). Classification lives in billing.ts.
      const denied = await authorizeRest(c, c.env);
      if (denied) return denied;
    } else if (c.env?.RAPIDAPI_PROXY_SECRET) {
      // Legacy gate — also the complete behavior while the Polar secrets are
      // unset, so a no-billing deploy degrades to exactly the pre-launch API.
      const key = c.env.RAPIDAPI_PROXY_SECRET;
      // Value comparison, not mere header presence (2026-10-03 review), and
      // timing-safe via the shared secretMatches helper: a plain === on a
      // secret leaks length/prefix timing, and the old presence-only check
      // let anyone who knew the header NAME through with any value. RapidAPI
      // injects the real secret, so legitimate traffic still passes.
      const ok =
        (await secretMatches(c.req.header("X-RapidAPI-Proxy-Secret") || "", key)) ||
        (await secretMatches(c.req.header("X-RapidAPI-Subscription-Secret") || "", key));
      if (!ok) {
        return c.json({ error: { code: "unauthorized", message: "Requests must go through RapidAPI." } }, 401);
      }
    }
  }
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  // POST/DELETE + the MCP headers: browser-based MCP clients (Streamable HTTP)
  // preflight against /mcp with these; harmless for the REST routes. X-Api-Key
  // is the browser-friendly carrier for Polar license keys.
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  c.header("Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, " +
    "X-RapidAPI-Proxy-Secret, X-RapidAPI-Subscription-Secret, X-Api-Key");
});
app.options("*", (c) => c.body(null, 204));

// Remote MCP endpoint (Streamable HTTP, stateless). Registered before the REST
// routes so the method-agnostic handler owns the whole path.
app.all("/mcp", handleMcp);

app.get("/", (c) =>
  c.json({
    name: "kultranz-api",
    version: "0.1.0",
    endpoints: [
      "/paycheck", "/cost-of-living", "/tax-brackets", "/col-index",
      "/compound-interest", "/net-worth", "/debt-payoff", "/budget", "/salaries",
      "/salaries/submit (POST, community)", "/salaries/recent (community)",
      "/mcp (MCP server, POST)",
    ],
    docs: "https://kultranz.com/api-docs/",
  }),
);

// ---------------------------------------------------------------------------
// 0. /billing/buy — 302 to a freshly minted Polar checkout for the
// "Kultranz Data Pass — $5 lifetime" (license key benefit). Exempt from the
// auth middleware above so an over-quota free-tier user can still buy.
// ---------------------------------------------------------------------------
app.get("/billing/buy", (c) => handleBuy(c, c.env));

// ---------------------------------------------------------------------------
// 1. /paycheck — take-home pay by state
// ---------------------------------------------------------------------------
app.get("/paycheck", (c) => {
  const salary = num(c, "salary", 0);
  const state = (c.req.query("state") || "").toUpperCase();
  const filingStatus = (c.req.query("filingStatus") || "single") as FilingStatus;
  const pretax401k = num(c, "pretax401k", 0);
  if (salary <= 0) return err(c, 400, "invalid_salary", "salary must be > 0");
  if (pretax401k < 0) return err(c, 400, "invalid_pretax", "pretax401k must be >= 0");
  if (!TAX_DATA.states[state]) return err(c, 400, "invalid_state", `Unknown state: ${state}`);
  if (filingStatus !== "single" && filingStatus !== "mfj") return err(c, 400, "invalid_filing", "filingStatus must be single or mfj");
  const data = computeTakeHome(salary, state, filingStatus, pretax401k, TAX_DATA);
  return ok(c, data);
});

// ---------------------------------------------------------------------------
// 2. /cost-of-living — compare two US metros
// ---------------------------------------------------------------------------
app.get("/cost-of-living", (c) => {
  const fromCity = c.req.query("fromCity");
  const toCity = c.req.query("toCity");
  const salary = num(c, "salary", 100000);
  const rich = c.req.query("rich") === "1";
  if (!fromCity || !toCity) return err(c, 400, "missing", "fromCity and toCity are required");
  if (salary <= 0) return err(c, 400, "invalid_salary", "salary must be > 0");
  const result = compareCities(fromCity, toCity, salary, CITIES, rich);
  if (!result) return err(c, 404, "not_found", "Unknown city. GET /col-index for the list.");
  return ok(c, result);
});

// ---------------------------------------------------------------------------
// 3. /tax-brackets — federal + state brackets as JSON
// ---------------------------------------------------------------------------
app.get("/tax-brackets", (c) => {
  const state = (c.req.query("state") || "").toUpperCase();
  const filingStatus = (c.req.query("filingStatus") || "single") as FilingStatus;
  if (filingStatus !== "single" && filingStatus !== "mfj") return err(c, 400, "invalid_filing", "filingStatus must be single or mfj");
  const fed = TAX_DATA.federal;
  if (state && !TAX_DATA.states[state]) return err(c, 400, "invalid_state", `Unknown state: ${state}`);
  const data: Record<string, unknown> = {
    federal: {
      standard_deduction: fed.standard_deduction[filingStatus],
      brackets: fed.brackets[filingStatus],
    },
  };
  if (state) data.state = { code: state, ...TAX_DATA.states[state] };
  return ok(c, data);
});

// ---------------------------------------------------------------------------
// 4. /col-index — raw RPP index for all/one city
// ---------------------------------------------------------------------------
app.get("/col-index", (c) => {
  const city = c.req.query("city");
  if (city) {
    const row = CITIES[city];
    if (!row) return err(c, 404, "not_found", "Unknown city");
    return ok(c, { city, ...row });
  }
  return ok(c, CITIES);
});

// ---------------------------------------------------------------------------
// 5. /compound-interest — future value
// ---------------------------------------------------------------------------
app.get("/compound-interest", (c) => {
  const principal = num(c, "principal", 0);
  const monthly = num(c, "monthly", 0);
  const rate = num(c, "rate", 0);
  const years = Math.floor(num(c, "years", 0));
  if (years <= 0) return err(c, 400, "invalid_years", "years must be > 0");
  if (years > 60) return err(c, 400, "invalid_years", "years must be <= 60 (matches website cap)");
  if (rate < 0 || rate > 50) return err(c, 400, "invalid_rate", "rate must be 0..50 (annual %)");
  if (principal < 0) return err(c, 400, "invalid_principal", "principal must be >= 0");
  if (monthly < 0) return err(c, 400, "invalid_monthly", "monthly must be >= 0");
  return ok(c, compoundInterest(principal, monthly, rate, years));
});

// ---------------------------------------------------------------------------
// 6. /net-worth
// ---------------------------------------------------------------------------
app.get("/net-worth", (c) => {
  const inputs = {
    cash: num(c, "cash", 0),
    investments: num(c, "investments", 0),
    property: num(c, "property", 0),
    mortgage: num(c, "mortgage", 0),
    car: num(c, "car", 0),
    credit: num(c, "credit", 0),
    otherAssets: num(c, "otherAssets", 0),
    otherDebt: num(c, "otherDebt", 0),
  };
  for (const [k, v] of Object.entries(inputs)) {
    if (v < 0) return err(c, 400, "invalid_input", `${k} must be >= 0`);
  }
  return ok(c, netWorth(inputs));
});

// ---------------------------------------------------------------------------
// 7. /debt-payoff
// ---------------------------------------------------------------------------
app.get("/debt-payoff", (c) => {
  const debtsParam = c.req.query("debts");
  if (!debtsParam) return err(c, 400, "missing", "debts is required");
  let parsed: { name: string; balance: number; rate: number; min: number }[];
  try {
    const raw = JSON.parse(debtsParam);
    if (!Array.isArray(raw) || !raw.length) throw 0;
    parsed = raw.map((x, i) => ({
      name: String(x?.name ?? `Debt ${i + 1}`),
      balance: Number(x?.balance),
      rate: Number(x?.rate),
      min: Number(x?.min),
    }));
    for (const x of parsed) {
      if (!Number.isFinite(x.balance) || x.balance <= 0) throw 1;
      if (!Number.isFinite(x.rate) || x.rate < 0) throw 1;
      if (!Number.isFinite(x.min) || x.min < 0) throw 1;
    }
  } catch {
    return err(c, 400, "invalid_debts", "debts must be a JSON array: [{name,balance,rate,min}] with positive numbers");
  }
  const extra = num(c, "extra", 0);
  if (extra < 0) return err(c, 400, "invalid_extra", "extra must be >= 0");
  const mode = c.req.query("mode") || "avalanche";
  if (!["avalanche", "snowball", "both"].includes(mode)) return err(c, 400, "invalid_mode", "mode must be avalanche, snowball, or both");
  if (mode === "both") {
    const avalanche = debtPayoff(parsed, extra, "avalanche");
    const snowball = debtPayoff(parsed, extra, "snowball");
    return ok(c, { avalanche, snowball, avalanche_savings: round2(snowball.total_interest - avalanche.total_interest) });
  }
  return ok(c, debtPayoff(parsed, extra, mode as "avalanche" | "snowball"));
});

// ---------------------------------------------------------------------------
// 8. /budget — simple 50/30/20 OR full custom-category (matches website)
// ---------------------------------------------------------------------------
app.get("/budget", (c) => {
  const income = num(c, "income", 0);
  if (income < 0) return err(c, 400, "invalid_income", "income must be >= 0");

  // Full custom-category budget when any category param is present
  const hasCategories = ["housing", "food", "transport", "utilities", "insurance", "debt", "savings", "other"]
    .some((k) => c.req.query(k) !== undefined);

  if (hasCategories) {
    if (income <= 0) return err(c, 400, "invalid_income", "income must be > 0 for category budget");
    return ok(c, budgetFull({
      income,
      housing: num(c, "housing", 0),
      food: num(c, "food", 0),
      transport: num(c, "transport", 0),
      utilities: num(c, "utilities", 0),
      insurance: num(c, "insurance", 0),
      debt: num(c, "debt", 0),
      savings: num(c, "savings", 0),
      other: num(c, "other", 0),
    }));
  }

  // Simple 50/30/20 split
  const savingsPct = c.req.query("savingsPct") ? num(c, "savingsPct", 20) / 100 : undefined;
  // 50/30/20 frame: savings above half of income would drive wants negative.
  if (savingsPct !== undefined && (savingsPct < 0 || savingsPct > 0.5))
    return err(c, 400, "invalid_savings_pct", "savingsPct must be between 0 and 50 (above 50% of income there is nothing left for wants)");
  return ok(c, budget(income, savingsPct));
});

// ---------------------------------------------------------------------------
// 9. /salaries — job × city from D1
// ---------------------------------------------------------------------------
app.get("/salaries", async (c) => {
  const job = c.req.query("job");
  const city = c.req.query("city");
  const state = c.req.query("state");
  if (!job && !city) return err(c, 400, "missing", "Provide job and/or city (optionally state)");

  let sql = "SELECT job_title, job_code, city, state, avg_salary, salary_10th, salary_25th, salary_median, salary_75th, salary_90th, national_avg, employment, rpp_all_items, median_rent, median_home_value, city_median_income, city_population FROM salary_data WHERE data_quality_score >= 6";
  const args: (string | number)[] = [];
  const clauses: string[] = [];
  // %, _ and backslash in user input are literals, not wildcards: escape them
  // and declare the escape char, so job=reg% cannot match every reg... title.
  const likeLiteral = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  if (job) { clauses.push("job_title LIKE ? ESCAPE '\\'"); args.push(likeLiteral(job)); }
  if (city) { clauses.push("city LIKE ? ESCAPE '\\'"); args.push(likeLiteral(city)); }
  if (state) { clauses.push("state = ?"); args.push(state.toUpperCase()); }
  if (clauses.length) sql += " AND " + clauses.join(" AND ");
  sql += " ORDER BY avg_salary DESC LIMIT 100";

  let results: Record<string, unknown>[];
  try {
    ({ results } = await c.env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>());
  } catch {
    // A D1 fault gets the JSON error envelope (503), never a plain-text 500
    // page — mirrors the storage-failure shape in submissions.ts.
    return err(c, 503, "db_error", "Could not read salary data. Try again shortly.");
  }
  if (!results.length) return err(c, 404, "not_found", "No matching salary records");
  return ok(c, { count: results.length, records: results });
});

// ---------------------------------------------------------------------------
// 10. /salaries/submit + /salaries/recent — community-reported salaries
// (the user flywheel; see src/submissions.ts. Both are exempt from the auth
// middleware above: anonymous browser traffic from kultranz.com by design.)
// ---------------------------------------------------------------------------
app.post("/salaries/submit", (c) => handleSubmit(c, c.env));
app.get("/salaries/recent", (c) => handleRecent(c, c.env));
app.post("/admin/submissions", (c) => handleAdmin(c, c.env));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function num(c: Context, key: string, fallback: number): number {
  const v = c.req.query(key);
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ok(c: Context, data: unknown) {
  return c.json({ data, meta: META });
}
function err(c: Context, status: 400 | 404 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export default app;