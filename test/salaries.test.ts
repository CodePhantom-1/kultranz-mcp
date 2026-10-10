// /salaries route tests — the one REST endpoint that reads the salary_data
// table (previously skipped in index.test.ts). Covers the happy path,
// parameter binding, the 404/400 short-circuits, and the D1-failure path,
// which must answer the JSON 503 envelope — never a plain-text 500.
// The in-memory D1 stub follows the memoryD1 pattern in submissions.test.ts.
import { describe, it, expect } from "vitest";
import app from "../src/index";

type Stmt = { sql: string; args: unknown[] };

/** Routes the exact SELECT /salaries issues; can be told to fail outright. */
function memoryD1(opts: { fail?: boolean; rows?: Record<string, unknown>[] } = {}) {
  const rows = opts.rows ?? [];
  const stmts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      const terminal = (args: unknown[]) => ({
        all: async () => {
          stmts.push({ sql, args });
          if (opts.fail) throw new Error("D1 unavailable");
          return { results: rows };
        },
        first: async () => null,
        run: async () => ({ success: true }),
      });
      return { bind: (...args: unknown[]) => terminal(args), ...terminal([]) };
    },
  } as unknown as D1Database;
  return { db, stmts };
}

// Real seed.sql row (Chicago, IL — Registered Nurse, 29-1141).
const NURSE_ROW: Record<string, unknown> = {
  job_title: "Registered Nurse",
  job_code: "29-1141",
  city: "Chicago",
  state: "IL",
  avg_salary: 90810,
  salary_10th: 67560,
  salary_25th: 79590,
  salary_median: 85160,
  salary_75th: 102440,
  salary_90th: 107980,
  national_avg: 94480,
  employment: 102330,
  rpp_all_items: 103.595,
  median_rent: 1380,
  median_home_value: 315200,
  city_median_income: 75134,
  city_population: 2707648,
};

async function get(path: string, env: Record<string, unknown>) {
  const res = await app.request(path, undefined, env as never);
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}

describe("GET /salaries", () => {
  it("happy path: 200 envelope with count + records + provenance meta", async () => {
    const mem = memoryD1({ rows: [NURSE_ROW] });
    const r = await get("/salaries?job=nurse&city=Chicago&state=IL", { DB: mem.db });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(1);
    expect(r.body.data.records[0]).toEqual(NURSE_ROW);
    expect(r.body.meta.source).toContain("BLS");
    expect(r.body.meta.year).toBe(2026);
  });

  it("binds job/city/state as parameters — LIKE patterns never concatenated", async () => {
    const mem = memoryD1({ rows: [] });
    await get("/salaries?job=O'Brien&city=Chicago&state=il", { DB: mem.db });
    const s = mem.stmts[0];
    expect(s.sql).toContain("data_quality_score >= 6"); // quality gate always present
    expect(s.sql).toContain("job_title LIKE ?");
    expect(s.sql).toContain("city LIKE ?");
    expect(s.sql).toContain("state = ?");
    expect(s.sql).toMatch(/ORDER BY avg_salary DESC LIMIT 100$/);
    expect(s.args).toEqual(["%O'Brien%", "%Chicago%", "IL"]); // state uppercased, values bound
    expect(s.sql).not.toContain("O'Brien"); // no literal interpolation
  });

  it("404 when no rows match", async () => {
    const r = await get("/salaries?job=zzz", { DB: memoryD1({ rows: [] }).db });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });

  it("400 when neither job nor city is provided", async () => {
    const r = await get("/salaries?state=IL", { DB: memoryD1().db });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("missing");
  });

  it("D1 failure → 503 JSON envelope, not a plain-text 500", async () => {
    const r = await get("/salaries?job=nurse", { DB: memoryD1({ fail: true }).db });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("db_error");
    expect(r.body.error.message).toContain("Try again");
    expect(r.body.error.message).not.toMatch(/Internal Server Error/i);
  });

  it("carries open CORS headers on success and on the 503 envelope", async () => {
    const ok = await get("/salaries?job=nurse", { DB: memoryD1({ rows: [NURSE_ROW] }).db });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const bad = await get("/salaries?job=nurse", { DB: memoryD1({ fail: true }).db });
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(bad.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("still serves data through the RapidAPI tier when billing is armed", async () => {
    const mem = memoryD1({ rows: [NURSE_ROW] });
    const res = await app.request("/salaries?job=nurse", {
      headers: { "X-RapidAPI-Proxy-Secret": "rs" },
    }, {
      DB: mem.db,
      POLAR_ACCESS_TOKEN: "t",
      POLAR_PRODUCT_ID: "p",
      RAPIDAPI_PROXY_SECRET: "rs",
    } as never);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.count).toBe(1);
  });
});
