/**
 * Remote MCP server — Streamable HTTP, stateless.
 *
 * Why hand-rolled rather than McpAgent: every tool here is a pure function over
 * bundled government data, so there is no session state to keep. McpAgent would
 * add a Durable Object, a SQLite migration and the `agents` dependency to a
 * Worker that needs none of them. The spec explicitly permits a stateless
 * server — POST returns one JSON object, Mcp-Session-Id is optional, and GET may
 * answer 405 — so this is compliant, not a shortcut.
 *
 * Why only five tools when the REST API has nine: the four generic calculators
 * (compound interest, net worth, debt payoff, budget) are arithmetic any model
 * can already do. Exposing them would pad the tool list with things that make
 * the server look useful without being useful, and Glama scores tool-definition
 * quality per tool. These five are the ones a model genuinely cannot compute:
 * they need the 50-state tax engine, BEA parities, or BLS wage percentiles.
 *
 * Access: opt-in, mirroring how the REST endpoints gate themselves. Unset the
 * secret and /mcp is open — it exposes exactly what kultranz.com's public
 * calculators already give away, so it cannot cannibalise the metered API,
 * which sells volume and programmatic access rather than these answers. Set
 * the MCP_API_KEY secret (`npx wrangler secret put MCP_API_KEY`) to require a
 * key on every call, presented either as `Authorization: Bearer <key>` (what
 * MCP clients send) or as `X-RapidAPI-Proxy-Secret` / `X-RapidAPI-Subscription-Secret`
 * (what a RapidAPI front door injects), so one key works through either door.
 * It is deliberately a separate secret from RAPIDAPI_PROXY_SECRET: that one
 * gates the metered REST surface, while MCP is the free distribution channel.
 *
 * Open is not unmetered: tool calls are real work (get_salary_percentiles
 * reads D1), so tools/call carries a per-hashed-IP daily meter (MCP_FREE_TIER,
 * lazily created mcp_usage table — see meterToolCalls). Handshake methods
 * (initialize, ping, tools/list) stay free so any client can connect and
 * discover the tools. JSON-RPC batches are capped at MCP_BATCH_LIMIT entries.
 */
import type { Context } from "hono";
import { normalizeRateIp } from "./lib/rate-ip";
import { anySecretMatches } from "./lib/secure-compare";
import { computeTakeHome, type FilingStatus, type TaxData } from "./lib/tax";
import { compareCities, type CityRppMap } from "./lib/col";
import taxDataJson from "./data/tax_2026.json";
import cityRppJson from "./data/city_rpp.json";

const TAX_DATA = taxDataJson as unknown as TaxData;
const CITIES = cityRppJson.cities as unknown as CityRppMap;

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = "2025-06-18";
const SERVER_INFO = { name: "kultranz", title: "Kultranz US Salary & Cost of Living", version: "1.0.0" };

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };

// Free tier for tool calls: per hashed IP per UTC day. Handshake methods are
// never metered. Generous by design — a real session interleaves chat
// between calls; this exists to price the D1-reading tool, not to nickel-and-
// dime normal use.
const MCP_FREE_TIER = 200;
// JSON-RPC batch cap: a batch is a single HTTP request the server processes
// serially, so an uncapped array buys an unbounded amount of work per call.
const MCP_BATCH_LIMIT = 16;

type ToolDef = {
  name: string; title: string; description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>, env: any) => Promise<unknown> | unknown;
};

const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });

export const TOOLS: ToolDef[] = [
  {
    name: "get_take_home_pay",
    title: "US take-home pay",
    description:
      "Calculate net (take-home) pay from a gross US salary for 2026: federal income tax, " +
      "Social Security to the annual wage base, Medicare including the additional Medicare " +
      "surcharge, and state income tax for any of the 50 states or DC. Use this instead of " +
      "estimating — state rules differ substantially and nine states levy no income tax. " +
      "Free, no quota, no side effects.",
    inputSchema: {
      type: "object",
      properties: {
        salary: num("Gross annual salary in USD, e.g. 120000"),
        state: str("Two-letter US state code, e.g. CA, NY, TX, DC"),
        filingStatus: { type: "string", enum: ["single", "mfj"], description: "single, or mfj for married filing jointly. Defaults to single." },
        pretax401k: num("Optional annual pre-tax 401(k) contribution in USD"),
      },
      required: ["salary", "state"],
    },
    run: (a, env) => {
      const state = String(a.state || "").toUpperCase();
      if (!env.TAX_DATA.states[state]) throw new Error(`Unknown state: ${state}. Use a two-letter code such as CA or NY.`);
      const fs = (a.filingStatus === "mfj" ? "mfj" : "single") as FilingStatus;
      if (!(a.salary > 0)) throw new Error("salary must be greater than 0");
      return computeTakeHome(Number(a.salary), state, fs, Number(a.pretax401k || 0), env.TAX_DATA);
    },
  },
  {
    name: "compare_cost_of_living",
    title: "Compare two US metros",
    description:
      "Compare the cost of living between two US metro areas and return the equivalent salary " +
      "— the income needed in the second city to hold the same purchasing power. Uses BEA " +
      "Regional Price Parities where the US average is 100. Answers 'is X more expensive than Y' " +
      "and 'what salary do I need in Y to match X'. Call list_metros first if unsure of a city name.",
    inputSchema: {
      type: "object",
      properties: {
        fromCity: str('Origin metro exactly as listed, e.g. "Austin, TX"'),
        toCity: str('Destination metro exactly as listed, e.g. "San Francisco, CA"'),
        salary: num("Salary in USD to convert. Defaults to 100000."),
      },
      required: ["fromCity", "toCity"],
    },
    run: (a, env) => {
      const r = compareCities(String(a.fromCity), String(a.toCity), Number(a.salary || 100000), env.CITIES, true);
      if (!r) throw new Error("Unknown city. Call list_metros for the exact names of all 50 supported metros.");
      return r;
    },
  },
  {
    name: "get_tax_brackets",
    title: "2026 federal and state tax brackets",
    description:
      "Return the 2026 IRS federal income tax brackets and standard deduction, and optionally " +
      "one state's income tax rules (none, flat, or progressive with its own brackets). " +
      "Use when asked what bracket someone is in or how a state taxes income.",
    inputSchema: {
      type: "object",
      properties: {
        state: str("Optional two-letter state code to include alongside the federal brackets"),
        filingStatus: { type: "string", enum: ["single", "mfj"], description: "single, or mfj for married filing jointly. Defaults to single." },
      },
    },
    run: (a, env) => {
      const fs = (a.filingStatus === "mfj" ? "mfj" : "single") as FilingStatus;
      const fed = env.TAX_DATA.federal;
      const out: Record<string, unknown> = {
        federal: { standard_deduction: fed.standard_deduction[fs], brackets: fed.brackets[fs] },
      };
      if (a.state) {
        const s = String(a.state).toUpperCase();
        if (!env.TAX_DATA.states[s]) throw new Error(`Unknown state: ${s}`);
        out.state = { code: s, ...env.TAX_DATA.states[s] };
      }
      return out;
    },
  },
  {
    name: "list_metros",
    title: "Supported metros and their cost indices",
    description:
      "List all 50 supported US metro areas with their BEA Regional Price Parity index " +
      "(US average = 100), median rent, median home value and median household income. " +
      "Pass a city to return just that one. Use this to resolve exact city names before " +
      "calling compare_cost_of_living.",
    inputSchema: {
      type: "object",
      properties: { city: str('Optional single metro, e.g. "Albuquerque, NM"') },
    },
    run: (a, env) => {
      if (a.city) {
        const row = env.CITIES[String(a.city)];
        if (!row) throw new Error(`Unknown city: ${a.city}. Call this tool with no arguments for the full list.`);
        return { city: a.city, ...row };
      }
      return env.CITIES;
    },
  },
  {
    name: "get_salary_percentiles",
    title: "BLS wage percentiles by job and city",
    description:
      "Return real BLS Occupational Employment and Wage Statistics annual wages — 10th, 25th, " +
      "median, 75th and 90th percentile — for an occupation, optionally narrowed to a metro or " +
      "state, alongside the metro's cost-of-living index. Use this to answer 'what does a nurse " +
      "earn in Chicago' or 'am I underpaid' with sourced figures rather than an estimate.",
    inputSchema: {
      type: "object",
      properties: {
        job: str('Occupation, partial match, e.g. "nurse", "software developer"'),
        city: str('Optional metro, partial match, e.g. "Chicago"'),
        state: str("Optional two-letter state code"),
      },
    },
    run: async (a, env) => {
      if (!a.job && !a.city) throw new Error("Provide job and/or city.");
      let sql =
        "SELECT job_title, city, state, avg_salary, salary_10th, salary_25th, salary_median, " +
        "salary_75th, salary_90th, national_avg, employment, rpp_all_items, median_rent, " +
        "median_home_value, city_median_income FROM salary_data WHERE data_quality_score >= 6";
      const args: string[] = [];
      if (a.job) { sql += " AND job_title LIKE ?"; args.push(`%${a.job}%`); }
      if (a.city) { sql += " AND city LIKE ?"; args.push(`%${a.city}%`); }
      if (a.state) { sql += " AND state = ?"; args.push(String(a.state).toUpperCase()); }
      sql += " ORDER BY avg_salary DESC LIMIT 25";
      const { results } = await env.DB.prepare(sql).bind(...args).all();
      if (!results.length) throw new Error("No matching salary records. Try a broader job title.");
      return { count: results.length, records: results };
    },
  },
];

const META = {
  source: "BLS OEWS + BEA RPP + U.S. Census ACS + IRS (via kultranz.com)",
  vintage: "2026",
  docs: "https://kultranz.com/pages/api-docs/",
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Opt-in API key (see header comment). Unset = open. Compared by value —
// timing-safe via the shared anySecretMatches helper — so a leaked header
// *name* is not enough and a plain === cannot leak prefix timing.
async function authorized(c: Context): Promise<boolean> {
  const key = c.env?.MCP_API_KEY;
  if (!key) return true;
  const auth = c.req.header("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return anySecretMatches([
    c.req.header("X-RapidAPI-Proxy-Secret") || "",
    c.req.header("X-RapidAPI-Subscription-Secret") || "",
    bearer,
  ], key);
}

// ---------------------------------------------------------------------------
// Free-tier meter (fix: /mcp was open AND unmetered while its salary tool
// hits D1). Same atomic increment-and-read pattern as billing.ts api_usage,
// but a sibling mcp_usage table: sharing api_usage would need its PRIMARY KEY
// widened to (ip_hash, day, endpoint), which no lazy CREATE can do on an
// existing production table — a separate table needs no migration and can
// never consume the REST free tier's counter. IPs only ever stored hashed.
// ---------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ensuredTables = new WeakSet<object>();

async function ensureTables(db: D1Database): Promise<void> {
  if (ensuredTables.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mcp_usage (ip_hash TEXT, day TEXT, count INTEGER, PRIMARY KEY (ip_hash, day))",
  ).run();
  ensuredTables.add(db);
}

/** Count `calls` tool calls against the caller's IP; over MCP_FREE_TIER
 * returns a 429 JSON-RPC error Response, else null to proceed. Fails open
 * when metering is unavailable — an open server must not go down over its
 * own quota bookkeeping. */
function secondsUntilUtcMidnight(): string {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return String(Math.max(1, Math.round((next - now.getTime()) / 1000)));
}

async function meterToolCalls(c: Context, calls: number): Promise<Response | null> {
  if (calls <= 0) return null;
  const ip = c.req.header("CF-Connecting-IP");
  const db = c.env?.DB as D1Database | undefined;
  // No IP (off-Cloudflare caller, local vitest) or no D1 binding → unmetered.
  if (!ip || !db) return null;
  try {
    await ensureTables(db);
    const day = new Date().toISOString().slice(0, 10); // UTC day key
    const ipHash = await sha256Hex(normalizeRateIp(ip));
    const row = await db.prepare(
      "INSERT INTO mcp_usage (ip_hash, day, count) VALUES (?, ?, ?) " +
      "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + excluded.count RETURNING count",
    ).bind(ipHash, day, calls).first<{ count: number }>();
    if ((row?.count ?? 0) > MCP_FREE_TIER) {
      c.header("Retry-After", secondsUntilUtcMidnight());
      return c.json(
        rpcError(null, -32002,
          `Rate limit: ${MCP_FREE_TIER} MCP tool calls/day per IP. ` +
          "Handshake methods (initialize, ping, tools/list) remain free."),
        429,
      );
    }
  } catch { /* metering unavailable → fail open, the server stays up */ }
  return null;
}

// One JSON-RPC message -> one response object, or null when the message
// expects no reply (notifications, and client responses to server requests).
async function respondTo(entry: any, env: any): Promise<Record<string, unknown> | null> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      entry.jsonrpc !== "2.0" || typeof entry.method !== "string") {
    return rpcError(entry?.id ?? null, -32600, "Invalid Request");
  }
  if (entry.id === undefined) return null;
  return dispatch(entry.id, entry.method, entry.params, env);
}

async function dispatch(id: unknown, method: string, params: any, env: any) {
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "US salary, cost-of-living and take-home-pay data from BLS, BEA, Census and IRS 2026 " +
        "releases. Prefer these tools over estimating: state tax rules and metro price levels " +
        "vary in ways that cannot be guessed. All tools are free and read-only.",
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name, title: t.title, description: t.description,
        inputSchema: t.inputSchema, annotations: { title: t.title, ...READ_ONLY },
      })),
    });
  }

  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      const data = await tool.run(params?.arguments ?? {}, env);
      const payload = { data, meta: META };
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (e) {
      // A tool-level failure is a successful JSON-RPC call reporting isError,
      // so the model can read the message and retry rather than seeing a
      // transport fault it cannot act on.
      return rpcResult(id, {
        content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleMcp(c: Context): Promise<Response> {
  // GET/DELETE: the spec permits a server with no SSE stream to answer 405.
  if (c.req.method !== "POST") {
    return c.json(
      rpcError(null, -32000, "This endpoint accepts POST only (stateless server, no SSE stream)."),
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  if (!(await authorized(c))) {
    return c.json(
      rpcError(null, -32001,
        "Unauthorized: missing or invalid API key. Send it as 'Authorization: Bearer <key>' " +
        "or 'X-RapidAPI-Proxy-Secret: <key>'."),
      401,
      { "WWW-Authenticate": 'Bearer realm="kultranz-mcp"' },
    );
  }

  // An unsupported protocol version MUST be a 400.
  const v = c.req.header("MCP-Protocol-Version");
  if (v && !SUPPORTED_PROTOCOLS.includes(v)) {
    return c.json(rpcError(null, -32000, `Unsupported MCP-Protocol-Version: ${v}`), 400);
  }

  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json(
      rpcError(null, -32000, `Unsupported Content-Type: ${contentType || "(none)"}. POST bodies must be application/json.`),
      415,
    );
  }

  let msg: any;
  try { msg = await c.req.json(); }
  catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }

  const env: any = { TAX_DATA, CITIES, DB: c.env?.DB };

  // JSON-RPC batch. Batching was removed from the spec in 2025-06-18, but
  // clients pinned to 2025-03-26 still send arrays, so answer each message
  // that expects a reply; 202 with an empty body if none does. The batch is
  // capped (MCP_BATCH_LIMIT): one HTTP request processed serially must not
  // buy unbounded work.
  if (Array.isArray(msg)) {
    if (!msg.length) return c.json(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
    if (msg.length > MCP_BATCH_LIMIT) {
      return c.json(rpcError(null, -32600,
        `Invalid Request: batch exceeds ${MCP_BATCH_LIMIT} entries`), 400);
    }
    // Meter tool calls only (initialize/ping/tools/list stay free).
    const toolCalls = msg.filter((e: any) => e?.method === "tools/call").length;
    const denied = await meterToolCalls(c, toolCalls);
    if (denied) return denied;
    const out: unknown[] = [];
    for (const entry of msg) {
      const r = await respondTo(entry, env);
      if (r) out.push(r);
    }
    return out.length ? c.json(out) : c.body(null, 202);
  }

  // Notifications and client responses (id, no method, result/error) get 202
  // with no body — the server never sends requests, but tolerate the ack.
  if (msg && msg.method !== undefined && msg.id === undefined) return c.body(null, 202);
  if (msg && msg.method === undefined && msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)) return c.body(null, 202);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return c.json(rpcError(msg?.id ?? null, -32600, "Invalid Request"), 400);
  }

  // Meter tool calls only — placed after the 202/400 short-circuits so
  // notifications and malformed messages are never charged.
  if (msg.method === "tools/call") {
    const denied = await meterToolCalls(c, 1);
    if (denied) return denied;
  }
  return c.json(await dispatch(msg.id, msg.method, msg.params, env));
}
