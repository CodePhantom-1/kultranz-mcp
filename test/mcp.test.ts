// MCP server tests — Streamable HTTP transport over POST /mcp.
//
// Covers the initialize → tools/list → tools/call round trip, transport error
// handling (405/415/400/401), JSON-RPC batch/notification semantics, the
// opt-in MCP_API_KEY gate, and parity between tool results and the REST
// endpoints (same engine, same data, so the numbers must match exactly).
import { describe, it, expect } from "vitest";
import app from "../src/index";
import { TOOLS } from "../src/mcp";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
let seq = 0;
function rpc(method: string, params?: unknown) {
  return { jsonrpc: "2.0" as const, id: ++seq, method, ...(params !== undefined ? { params } : {}) };
}
function callTool(name: string, args: Record<string, unknown>) {
  return rpc("tools/call", { name, arguments: args });
}

type EnvObj = Record<string, unknown>;

async function mcpPost(
  body: unknown,
  opts: { env?: EnvObj; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Response> {
  const { env, headers = {}, rawBody } = opts;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: rawBody ?? JSON.stringify(body),
  };
  return app.request("/mcp", init, env as never);
}

/** POST a JSON-RPC message and parse the response as JSON. */
async function mcp(body: unknown, opts: { env?: EnvObj; headers?: Record<string, string> } = {}) {
  const res = await mcpPost(body, opts);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

/** Fetch a REST endpoint and return its `data` payload (for parity checks). */
async function restData(path: string): Promise<any> {
  const res = await app.request(path);
  const json = (await res.json()) as any;
  expect(res.status).toBe(200);
  return json.data;
}

/** Minimal in-memory D1 stub: records the SQL + bound args, returns rows. */
function fakeD1(rows: Record<string, unknown>[], captured: { sql?: string; args?: unknown[] } = {}) {
  return {
    prepare(sql: string) {
      captured.sql = sql;
      return {
        bind(...args: unknown[]) {
          captured.args = args;
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  } as unknown as D1Database;
}

const EXPECTED_TOOLS = [
  "get_take_home_pay",
  "compare_cost_of_living",
  "get_tax_brackets",
  "list_metros",
  "get_salary_percentiles",
];

// ---------------------------------------------------------------------------
// initialize → tools/list → tools/call round trip (the sequence every MCP
// client runs on connect)
// ---------------------------------------------------------------------------
describe("MCP client round trip", () => {
  it("initialize → tools/list → tools/call with real data", async () => {
    // 1. initialize
    const init = await mcp(rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    }));
    expect(init.status).toBe(200);
    expect(init.body.jsonrpc).toBe("2.0");
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toEqual({ listChanged: false });
    expect(init.body.result.serverInfo.name).toBe("kultranz");
    expect(typeof init.body.result.instructions).toBe("string");

    // 2. tools/list (clients send the negotiated version header afterwards)
    const list = await mcp(rpc("tools/list"), { headers: { "MCP-Protocol-Version": "2025-06-18" } });
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(EXPECTED_TOOLS);

    // 3. tools/call — real 2026 tax data (TX levies no income tax)
    const call = await mcp(callTool("get_take_home_pay", { salary: 120000, state: "TX" }), {
      headers: { "MCP-Protocol-Version": "2025-06-18" },
    });
    expect(call.status).toBe(200);
    expect(call.body.result.isError).toBe(false);
    const data = call.body.result.structuredContent.data;
    expect(data.gross).toBe(120000);
    expect(data.state_tax).toBe(0);
    expect(data.net).toBeGreaterThan(0);
    expect(data.net).toBeLessThan(120000);
  });
});

// ---------------------------------------------------------------------------
// transport behaviour
// ---------------------------------------------------------------------------
describe("MCP transport", () => {
  it("GET /mcp is 405 with an Allow header (stateless server, no SSE)", async () => {
    const res = await app.request("/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32000);
  });

  it("DELETE /mcp is 405", async () => {
    const res = await app.request("/mcp", { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("unparseable body is 400 with JSON-RPC parse error -32700", async () => {
    const r = await mcpPost(null, { rawBody: "{not json" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe(-32700);
  });

  it("non-JSON Content-Type is 415", async () => {
    const r = await mcpPost(null, { rawBody: "{}", headers: { "Content-Type": "text/plain" } });
    expect(r.status).toBe(415);
    const body = (await r.json()) as any;
    expect(body.error.message).toContain("application/json");
  });

  it("missing Content-Type is 415 (every spec-compliant client sends it)", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream" },
      body: JSON.stringify(rpc("ping")),
    });
    expect(res.status).toBe(415);
  });

  it("unsupported MCP-Protocol-Version header is 400", async () => {
    const r = await mcp(rpc("ping"), { headers: { "MCP-Protocol-Version": "1999-01-01" } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("1999-01-01");
  });

  it("notification gets 202 with an empty body", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("client response message (id, no method) gets 202", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 7, result: {} });
    expect(res.status).toBe(202);
  });

  it("non-JSON-RPC object is 400 with -32600", async () => {
    const r = await mcp({ foo: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32600);
  });

  it("wrong jsonrpc version string is 400", async () => {
    const r = await mcp({ jsonrpc: "1.0", id: 1, method: "ping" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32600);
  });

  it("unknown method is 200 with JSON-RPC error -32601", async () => {
    const r = await mcp(rpc("resources/list"));
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32601);
  });

  it("batch: replies to requests, skips notifications (legacy 2025-03-26 clients)", async () => {
    const r = await mcp([
      rpc("ping"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].result).toEqual({});
  });

  it("batch of only notifications gets 202", async () => {
    const res = await mcpPost([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(res.status).toBe(202);
  });

  it("empty batch is 400", async () => {
    const r = await mcp([]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32600);
  });

  it("batch entry that is garbage yields an embedded -32600 error object", async () => {
    const r = await mcp([rpc("ping"), { nope: true }]);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[1].error.code).toBe(-32600);
  });

  it("responses carry open CORS headers (browser-based MCP clients)", async () => {
    const res = await mcpPost(rpc("ping"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("OPTIONS preflight on /mcp is 204", async () => {
    const res = await app.request("/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// initialize negotiation + ping
// ---------------------------------------------------------------------------
describe("MCP initialize", () => {
  it("echoes a supported older protocol version", async () => {
    const r = await mcp(rpc("initialize", { protocolVersion: "2024-11-05" }));
    expect(r.body.result.protocolVersion).toBe("2024-11-05");
  });

  it("falls back to the latest version when asked for an unknown one", async () => {
    const r = await mcp(rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
  });

  it("ping returns an empty result", async () => {
    const r = await mcp(rpc("ping"));
    expect(r.body.result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------
describe("MCP tools/list", () => {
  it("exposes exactly the five designed tools", async () => {
    const r = await mcp(rpc("tools/list"));
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(TOOLS).toHaveLength(5);
  });

  it("every tool has a description, object inputSchema and read-only annotation", async () => {
    const r = await mcp(rpc("tools/list"));
    for (const t of r.body.result.tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it("get_take_home_pay marks salary and state required", async () => {
    const r = await mcp(rpc("tools/list"));
    const t = r.body.result.tools.find((x: any) => x.name === "get_take_home_pay");
    expect(t.inputSchema.required).toEqual(["salary", "state"]);
    expect(t.inputSchema.properties.filingStatus.enum).toEqual(["single", "mfj"]);
  });
});

// ---------------------------------------------------------------------------
// tools/call — real data, parity with the REST endpoints
// ---------------------------------------------------------------------------
describe("MCP tools/call", () => {
  it("get_take_home_pay matches GET /paycheck exactly (CA, single)", async () => {
    const r = await mcp(callTool("get_take_home_pay", { salary: 120000, state: "CA", filingStatus: "single" }));
    expect(r.body.result.isError).toBe(false);
    const mcpData = r.body.result.structuredContent.data;
    const rest = await restData("/paycheck?salary=120000&state=CA&filingStatus=single");
    expect(mcpData).toEqual(rest);
    expect(mcpData.state_tax).toBeGreaterThan(0);
  });

  it("get_take_home_pay matches GET /paycheck exactly (TX, mfj, 401k)", async () => {
    const r = await mcp(callTool("get_take_home_pay", {
      salary: 95000, state: "TX", filingStatus: "mfj", pretax401k: 10000,
    }));
    const mcpData = r.body.result.structuredContent.data;
    const rest = await restData("/paycheck?salary=95000&state=TX&filingStatus=mfj&pretax401k=10000");
    expect(mcpData).toEqual(rest);
    expect(mcpData.state_tax).toBe(0);
  });

  it("get_take_home_pay: pre-tax 401(k) lowers federal tax but not FICA", async () => {
    const with401k = await mcp(callTool("get_take_home_pay", { salary: 120000, state: "WA", pretax401k: 20000 }));
    const without = await mcp(callTool("get_take_home_pay", { salary: 120000, state: "WA" }));
    const a = with401k.body.result.structuredContent.data;
    const b = without.body.result.structuredContent.data;
    expect(a.federal_tax).toBeLessThan(b.federal_tax);
    expect(a.social_security).toBe(b.social_security);
    expect(a.medicare).toBe(b.medicare);
  });

  it("get_take_home_pay with an unknown state reports isError, not a transport fault", async () => {
    const r = await mcp(callTool("get_take_home_pay", { salary: 100000, state: "ZZ" }));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("Unknown state");
  });

  it("get_take_home_pay rejects salary <= 0 as a tool error", async () => {
    const r = await mcp(callTool("get_take_home_pay", { salary: 0, state: "CA" }));
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("salary");
  });

  it("compare_cost_of_living matches GET /cost-of-living rich=1 (Austin → SF)", async () => {
    const r = await mcp(callTool("compare_cost_of_living", {
      fromCity: "Austin, TX", toCity: "San Francisco, CA", salary: 100000,
    }));
    expect(r.body.result.isError).toBe(false);
    const mcpData = r.body.result.structuredContent.data;
    const rest = await restData("/cost-of-living?fromCity=Austin,%20TX&toCity=San%20Francisco,%20CA&salary=100000&rich=1");
    expect(mcpData).toEqual(rest);
    // Real BEA parities: Austin 98.1 → SF 115.6 (the figure in the public docs)
    expect(mcpData.equivalent_salary).toBe(117838.94);
    expect(mcpData.gap_pct).toBeCloseTo(17.84, 1);
    expect(mcpData.to_breakdown.housing).toBeGreaterThan(mcpData.from_breakdown.housing);
  });

  it("compare_cost_of_living with an unknown city points at list_metros", async () => {
    const r = await mcp(callTool("compare_cost_of_living", { fromCity: "Nowhere, XX", toCity: "Austin, TX" }));
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("list_metros");
  });

  it("get_tax_brackets matches GET /tax-brackets (NY, mfj)", async () => {
    const r = await mcp(callTool("get_tax_brackets", { state: "NY", filingStatus: "mfj" }));
    expect(r.body.result.isError).toBe(false);
    const mcpData = r.body.result.structuredContent.data;
    const rest = await restData("/tax-brackets?state=NY&filingStatus=mfj");
    expect(mcpData).toEqual(rest);
    expect(mcpData.state.code).toBe("NY");
    expect(Array.isArray(mcpData.federal.brackets)).toBe(true);
  });

  it("get_tax_brackets without state returns federal only", async () => {
    const r = await mcp(callTool("get_tax_brackets", {}));
    const mcpData = r.body.result.structuredContent.data;
    expect(mcpData.federal).toBeDefined();
    expect(mcpData.state).toBeUndefined();
  });

  it("list_metros returns all 50 metros", async () => {
    const r = await mcp(callTool("list_metros", {}));
    const data = r.body.result.structuredContent.data;
    expect(Object.keys(data).length).toBe(50);
  });

  it("list_metros with a city returns that metro's real RPP row", async () => {
    const r = await mcp(callTool("list_metros", { city: "Albuquerque, NM" }));
    const data = r.body.result.structuredContent.data;
    expect(data.city).toBe("Albuquerque, NM");
    expect(data.rpp).toBe(95.5);
  });

  it("list_metros unknown city reports isError", async () => {
    const r = await mcp(callTool("list_metros", { city: "Atlantis, XX" }));
    expect(r.body.result.isError).toBe(true);
  });

  it("get_salary_percentiles queries D1 and returns records", async () => {
    const captured: { sql?: string; args?: unknown[] } = {};
    const row = {
      job_title: "Registered Nurses", city: "Chicago, IL", state: "IL",
      avg_salary: 85000, salary_10th: 60000, salary_25th: 68000, salary_median: 82000,
      salary_75th: 98000, salary_90th: 115000, national_avg: 94000, employment: 78000,
      rpp_all_items: 102.3, median_rent: 1400, median_home_value: 320000, city_median_income: 71000,
    };
    const r = await mcp(callTool("get_salary_percentiles", { job: "nurse", city: "Chicago" }), {
      env: { DB: fakeD1([row], captured) },
    });
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.data).toEqual({ count: 1, records: [row] });
    // SQL plumbing: quality filter + both LIKE filters + bound params
    expect(captured.sql).toContain("data_quality_score >= 6");
    expect(captured.sql).toContain("job_title LIKE ?");
    expect(captured.sql).toContain("city LIKE ?");
    expect(captured.args).toEqual(["%nurse%", "%Chicago%"]);
  });

  it("get_salary_percentiles without job or city reports isError", async () => {
    const r = await mcp(callTool("get_salary_percentiles", {}), { env: { DB: fakeD1([]) } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("job and/or city");
  });

  it("unknown tool is a JSON-RPC -32602 error", async () => {
    const r = await mcp(callTool("does_not_exist", {}));
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32602);
  });

  it("tool result text is JSON with the meta provenance envelope", async () => {
    const r = await mcp(callTool("get_tax_brackets", {}));
    const parsed = JSON.parse(r.body.result.content[0].text);
    expect(parsed.meta.source).toContain("BLS");
    expect(parsed.meta.vintage).toBe("2026");
  });
});

// ---------------------------------------------------------------------------
// opt-in API key (MCP_API_KEY)
// ---------------------------------------------------------------------------
describe("MCP auth", () => {
  const env = { MCP_API_KEY: "test-key-123" };

  it("no key configured -> endpoint is open", async () => {
    const r = await mcp(rpc("ping"));
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({});
  });

  it("key configured, no credentials -> 401 with WWW-Authenticate", async () => {
    const r = await mcp(rpc("initialize", { protocolVersion: "2025-06-18" }), { env });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe(-32001);
    expect(r.body.error.message).toContain("Bearer");
    expect(r.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("wrong Bearer token -> 401", async () => {
    const r = await mcp(rpc("ping"), { env, headers: { Authorization: "Bearer wrong" } });
    expect(r.status).toBe(401);
  });

  it("correct Bearer token -> 200", async () => {
    const r = await mcp(rpc("ping"), { env, headers: { Authorization: "Bearer test-key-123" } });
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({});
  });

  it("X-RapidAPI-Proxy-Secret with the key -> 200 (RapidAPI front door)", async () => {
    const r = await mcp(rpc("ping"), { env, headers: { "X-RapidAPI-Proxy-Secret": "test-key-123" } });
    expect(r.status).toBe(200);
  });

  it("X-RapidAPI-Subscription-Secret with the key -> 200", async () => {
    const r = await mcp(rpc("ping"), { env, headers: { "X-RapidAPI-Subscription-Secret": "test-key-123" } });
    expect(r.status).toBe(200);
  });

  it("header present but wrong value -> 401 (value compare, not presence)", async () => {
    const r = await mcp(rpc("ping"), { env, headers: { "X-RapidAPI-Proxy-Secret": "not-the-key" } });
    expect(r.status).toBe(401);
  });

  it("REST RapidAPI gate stays independent of the MCP key", async () => {
    // RapidAPI secret set: REST is gated, /mcp (no MCP key) stays open.
    const restEnv = { RAPIDAPI_PROXY_SECRET: "rapid-secret" };
    const blocked = await app.request("/paycheck?salary=100000&state=CA", undefined, restEnv as never);
    expect(blocked.status).toBe(401);
    const viaRapid = await app.request("/paycheck?salary=100000&state=CA", {
      headers: { "X-RapidAPI-Proxy-Secret": "rapid-secret" },
    }, restEnv as never);
    expect(viaRapid.status).toBe(200);

    const mcpOpen = await mcp(rpc("ping"), { env: restEnv });
    expect(mcpOpen.status).toBe(200);
  });
});
