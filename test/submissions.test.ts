// Community submission tests — POST /salaries/submit validation, spam
// defenses (honeypot + URL reject), the 5/day per-hashed-IP rate limit, and
// GET /salaries/recent (approved-only, parameterized, limit clamping).
// D1 is an in-memory stub following the memoryD1 pattern in billing.test.ts,
// extended with the two lazily created submission tables. No Polar env is
// needed: with the secrets unset the auth middleware stays open, which is
// also the community endpoints' designed exemption (tested explicitly below).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import app from "../src/index";
import { validateSubmission } from "../src/submissions";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// In-memory D1 stub — routes the exact statements submissions.ts issues.
// ---------------------------------------------------------------------------
type Stmt = { sql: string; args: unknown[] };
type Row = {
  id: number;
  job_title: string;
  city: string;
  state: string;
  salary: number;
  years_experience: number | null;
  title: string | null;
  ip_hash: string;
  status: string;
  created_at: number;
};

function memoryD1(failInsert = false) {
  const submissions: Row[] = [];
  const usage = new Map<string, number>(); // `${ip_hash}|${day}` -> count
  const stmts: Stmt[] = [];
  const creates: string[] = [];
  let nextId = 1;

  const route = (sql: string, args: unknown[], kind: "first" | "run" | "all"): unknown => {
    stmts.push({ sql, args });
    if (sql.startsWith("CREATE TABLE")) { creates.push(sql); return { success: true }; }
    if (sql.startsWith("INSERT INTO submission_usage")) {
      const k = `${args[0]}|${args[1]}`;
      const n = (usage.get(k) ?? 0) + 1;
      usage.set(k, n);
      return { count: n };
    }
    if (sql.startsWith("INSERT INTO salary_submissions")) {
      if (failInsert) throw new Error("D1 unavailable");
      const row: Row = {
        id: nextId++,
        job_title: String(args[0]),
        city: String(args[1]),
        state: String(args[2]),
        salary: Number(args[3]),
        years_experience: args[4] === null ? null : Number(args[4]),
        title: args[5] === null ? null : String(args[5]),
        ip_hash: String(args[6]),
        status: String(args[7]),
        created_at: Number(args[8]),
      };
      submissions.push(row);
      return { success: true, meta: { last_row_id: row.id } };
    }
    if (sql.startsWith("SELECT job_title, city, state, salary")) {
      // Mirrors: WHERE status = ? [AND job_title = ? COLLATE NOCASE]
      //          [AND city = ? COLLATE NOCASE] ... LIMIT ?
      let i = 0;
      const status = String(args[i++]);
      const job = sql.includes("AND job_title") ? String(args[i++]) : null;
      const city = sql.includes("AND city") ? String(args[i++]) : null;
      const limit = Number(args[i] ?? 10);
      let rows = submissions.filter((r) => r.status === status);
      if (job !== null) rows = rows.filter((r) => r.job_title.toLowerCase() === job.toLowerCase());
      if (city !== null) rows = rows.filter((r) => r.city.toLowerCase() === city.toLowerCase());
      rows = [...rows].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
      return { results: rows.slice(0, limit) };
    }
    return kind === "all" ? { results: [] } : kind === "first" ? null : { success: true };
  };

  const db = {
    prepare(sql: string) {
      const terminal = (args: unknown[]) => ({
        first: async () => route(sql, args, "first"),
        run: async () => route(sql, args, "run"),
        all: async () => route(sql, args, "all"),
      });
      return { bind: (...args: unknown[]) => terminal(args), ...terminal([]) };
    },
  } as unknown as D1Database;

  return { db, submissions, usage, stmts, creates };
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------
type PostOpts = { env?: Record<string, unknown>; ip?: string };

async function submit(body: unknown, opts: PostOpts = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await app.request("/salaries/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": opts.ip ?? "203.0.113.7" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, opts.env as never);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

async function recent(query: string, env?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await app.request(`/salaries/recent${query}`, undefined, env as never);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const GOOD = {
  job_title: "Software Engineer",
  city: "Austin",
  state: "TX",
  salary: 145_000,
};

// ---------------------------------------------------------------------------
// validateSubmission (pure) — sanitization specifics
// ---------------------------------------------------------------------------
describe("validateSubmission", () => {
  it("strips HTML tags and stray angle brackets from free text", () => {
    const v = validateSubmission({ ...GOOD, job_title: "<b>Software</b> <i>Engineer</i>", title: "Senior <svg onload=alert(1)>" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.job_title).toBe("Software Engineer");
      expect(v.value.title).toBe("Senior"); // the whole tag (attrs included) is removed
    }
  });

  it("accepts $ and comma formatted salary strings and rounds to integer", () => {
    const v = validateSubmission({ ...GOOD, salary: "$145,000.60" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.salary).toBe(145001);
  });

  it("uppercases the state code and accepts optional fields", () => {
    const v = validateSubmission({ ...GOOD, state: "tx", years_experience: "5" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.state).toBe("TX");
      expect(v.value.years_experience).toBe(5);
      expect(v.value.title).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /salaries/submit — validation + spam defenses
// ---------------------------------------------------------------------------
describe("POST /salaries/submit — validation", () => {
  it("accepts a good submission: 201, stored pending, IP stored hashed only", async () => {
    const mem = memoryD1();
    const r = await submit({ ...GOOD, years_experience: 7, title: "Senior" }, { env: { DB: mem.db } });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ id: 1, status: "pending" });

    const row = mem.submissions[0];
    expect(row).toMatchObject({ job_title: "Software Engineer", city: "Austin", state: "TX", salary: 145000, years_experience: 7, title: "Senior", status: "pending" });
    // IP hashed, never raw — and never echoed in the response.
    expect(row.ip_hash).toBe(sha("203.0.113.7"));
    expect(JSON.stringify(r.body)).not.toContain("ip_hash");
    expect(JSON.stringify(r.body)).not.toContain("203.0.113.7");
    // Both tables created lazily, exactly once per binding.
    expect(mem.creates).toHaveLength(2);
    await submit(GOOD, { env: { DB: mem.db } });
    expect(mem.creates).toHaveLength(2);
  });

  it("rejects out-of-band salaries (both ends) with invalid_salary", async () => {
    const mem = memoryD1();
    for (const salary of [500, 0, -1, 5_000_001, 10_000_000, "free", null]) {
      const r = await submit({ ...GOOD, salary }, { env: { DB: mem.db } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_salary");
    }
    expect(mem.submissions).toHaveLength(0);
  });

  it("rejects malformed state, job_title and city lengths", async () => {
    const mem = memoryD1();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...GOOD, state: "California" }, "invalid_state"],
      [{ ...GOOD, state: "T" }, "invalid_state"],
      [{ ...GOOD, state: "TXX" }, "invalid_state"],
      [{ ...GOOD, job_title: "A" }, "invalid_job_title"],
      [{ ...GOOD, job_title: "x".repeat(81) }, "invalid_job_title"],
      [{ ...GOOD, job_title: "" }, "invalid_job_title"],
      [{ ...GOOD, city: "X" }, "invalid_city"],
      [{ ...GOOD, years_experience: 200 }, "invalid_years"],
      [{ ...GOOD, years_experience: -1 }, "invalid_years"],
      [{ ...GOOD, title: "y".repeat(81) }, "invalid_title"],
      [{ ...GOOD, source: "admin" }, "invalid_source"],
    ];
    for (const [body, code] of cases) {
      const r = await submit(body, { env: { DB: mem.db } });
      expect(r.status, `${code} for ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(r.body.error.code).toBe(code);
    }
    expect(mem.submissions).toHaveLength(0);
  });

  it("rejects a non-object / unparseable body with invalid_body", async () => {
    const mem = memoryD1();
    const bad = await submit("this is not json{{", { env: { DB: mem.db } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_body");
    const arr = await submit([GOOD], { env: { DB: mem.db } });
    expect(arr.status).toBe(400);
    expect(arr.body.error.code).toBe("invalid_body");
  });
});

describe("POST /salaries/submit — spam defenses", () => {
  it("rejects any URL in job_title / city / title as spam", async () => {
    const mem = memoryD1();
    for (const body of [
      { ...GOOD, job_title: "Engineer see https://spam.example" },
      { ...GOOD, city: "http://x.example" },
      { ...GOOD, title: "Senior www.pills.example" },
    ]) {
      const r = await submit(body, { env: { DB: mem.db } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("spam");
    }
    expect(mem.submissions).toHaveLength(0);
  });

  it("rejects a filled honeypot (both field names: website and honeypot)", async () => {
    const mem = memoryD1();
    const a = await submit({ ...GOOD, website: "http://bot.example" }, { env: { DB: mem.db } });
    const b = await submit({ ...GOOD, honeypot: "bot" }, { env: { DB: mem.db } });
    expect(a.status).toBe(400);
    expect(a.body.error.code).toBe("spam");
    expect(b.status).toBe(400);
    // ...while empty-string values are exactly what the real form sends.
    const ok = await submit({ ...GOOD, website: "", honeypot: "" }, { env: { DB: mem.db } });
    expect(ok.status).toBe(201);
    expect(mem.submissions).toHaveLength(1);
  });
});

describe("POST /salaries/submit — rate limit (5/day per hashed IP)", () => {
  it("submissions 1-5 pass, 6th gets 429; another IP is unaffected", async () => {
    const mem = memoryD1();
    const env = { DB: mem.db };
    for (let i = 0; i < 5; i++) {
      const r = await submit({ ...GOOD, salary: 100_000 + i }, { env });
      expect(r.status).toBe(201);
    }
    const over = await submit(GOOD, { env });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("rate_limited");
    // 5 stored, and the counter keeps counting past the cap.
    expect(mem.submissions).toHaveLength(5);
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(mem.usage.get(`${sha("203.0.113.7")}|${dayKey}`)).toBe(6);
    // A different IP has its own bucket.
    const other = await submit(GOOD, { env, ip: "198.51.100.99" });
    expect(other.status).toBe(201);
    expect(mem.usage.get(`${sha("198.51.100.99")}|${dayKey}`)).toBe(1);
  });

  it("validation failures do not consume the daily budget", async () => {
    const mem = memoryD1();
    const env = { DB: mem.db };
    for (let i = 0; i < 8; i++) await submit({ ...GOOD, salary: 1 }, { env }); // invalid
    const ok = await submit(GOOD, { env });
    expect(ok.status).toBe(201);
    expect([...mem.usage.values()][0]).toBe(1);
  });

  it("storage failure after metering → 503 (writes fail closed)", async () => {
    const r = await submit(GOOD, { env: { DB: memoryD1(true).db } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("db_error");
  });

  it("no D1 binding → 503 db_unavailable", async () => {
    const r = await submit(GOOD, { env: {} });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("db_unavailable");
  });
});

describe("POST /salaries/submit — gates + CORS", () => {
  it("is exempt from the billing/RapidAPI gates (anonymous browser traffic by design)", async () => {
    // With billing configured the free tier is GET-only (anonymous POST on any
    // other route → 405); with the legacy RapidAPI gate armed it is 401. The
    // community endpoints must still accept the site's form POST.
    const mem = memoryD1();
    const r = await submit(GOOD, {
      env: {
        DB: mem.db,
        POLAR_ACCESS_TOKEN: "t",
        POLAR_PRODUCT_ID: "p",
        RAPIDAPI_PROXY_SECRET: "rs",
      },
    });
    expect(r.status).toBe(201);
  });

  it("carries open CORS + POST method on responses and preflights 204", async () => {
    const mem = memoryD1();
    const r = await submit(GOOD, { env: { DB: mem.db } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    const pre = await app.request("/salaries/submit", { method: "OPTIONS" }, { DB: mem.db } as never);
    expect(pre.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// GET /salaries/recent
// ---------------------------------------------------------------------------
function seedRecent(mem: ReturnType<typeof memoryD1>) {
  const base = Date.now();
  const rows: [string, string, string, number, string][] = [
    // job, city, state, salary, status
    ["Software Engineer", "Austin", "TX", 150_000, "approved"],
    ["software engineer", "Austin", "TX", 120_000, "approved"],   // case variance
    ["Software Engineer", "Denver", "CO", 140_000, "pending"],    // must not leak
    ["Software Engineer", "Boston", "MA", 160_000, "rejected"],   // must not leak
    ["Accountant", "Austin", "TX", 70_000, "approved"],
    ["Software Engineer", "Seattle", "WA", 180_000, "approved"],
  ];
  rows.forEach(([job_title, city, state, salary, status], i) => {
    mem.submissions.push({
      id: i + 1, job_title, city, state, salary,
      years_experience: i, title: null, ip_hash: sha(`ip-${i}`),
      status, created_at: base - i * 1000,
    });
  });
  return base;
}

describe("GET /salaries/recent", () => {
  it("returns APPROVED submissions only, newest first, no ip_hash/id leak", async () => {
    const mem = memoryD1();
    seedRecent(mem);
    const r = await recent("?job=Software%20Engineer", { DB: mem.db });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(3);
    const titles = r.body.data.submissions.map((s: any) => s.city);
    expect(titles).toEqual(["Austin", "Austin", "Seattle"]); // created_at DESC
    expect(JSON.stringify(r.body)).not.toContain("ip_hash");
    expect(JSON.stringify(r.body)).not.toContain("pending");
    // posted_at is a readable ISO timestamp
    expect(() => new Date(r.body.data.submissions[0].posted_at).toISOString()).not.toThrow();
  });

  it("filters by job AND city, case-insensitively", async () => {
    const mem = memoryD1();
    seedRecent(mem);
    const both = await recent("?job=software+engineer&city=austin", { DB: mem.db });
    expect(both.body.data.count).toBe(2);
    const cityOnly = await recent("?city=Austin", { DB: mem.db });
    expect(cityOnly.body.data.count).toBe(3); // 2 SWE + 1 Accountant rows
  });

  it("clamps limit to 50 and defaults to 10 — never unbounded", async () => {
    const mem = memoryD1();
    const base = Date.now();
    for (let i = 0; i < 60; i++) {
      mem.submissions.push({
        id: i + 1, job_title: "Nurse", city: "Phoenix", state: "AZ", salary: 90_000,
        years_experience: null, title: null, ip_hash: `h${i}`, status: "approved",
        created_at: base - i,
      });
    }
    const capped = await recent("?job=Nurse&limit=500", { DB: mem.db });
    expect(capped.body.data.count).toBe(50);
    const def = await recent("?job=Nurse", { DB: mem.db });
    expect(def.body.data.count).toBe(10);
    const junk = await recent("?job=Nurse&limit=abc", { DB: mem.db });
    expect(junk.body.data.count).toBe(10);
  });

  it("binds user input as parameters — never concatenated into SQL", async () => {
    const mem = memoryD1();
    seedRecent(mem);
    const r = await recent("?job=O'Brien%20Engineer&city=Austin", { DB: mem.db });
    expect(r.status).toBe(200);
    const select = mem.stmts.filter((s) => s.sql.startsWith("SELECT job_title")).pop()!;
    expect(select.sql).not.toContain("O'Brien");          // no literal interpolation
    expect(select.args).toContain("O'Brien Engineer");     // value went through bind()
    expect(select.sql).not.toContain("Austin");
    expect(select.args).toContain("Austin");
    expect(select.sql).toMatch(/LIMIT \?$/);               // limit is bound too
  });

  it("requires job or city; empty result is 200 with count 0 (graceful)", async () => {
    const mem = memoryD1();
    seedRecent(mem);
    const missing = await recent("", { DB: mem.db });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("missing");
    const empty = await recent("?job=Cryptographer", { DB: mem.db });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ count: 0, submissions: [] });
  });

  it("is exempt from the billing gate and fails open without D1", async () => {
    const mem = memoryD1();
    seedRecent(mem);
    const gated = await recent("?job=Software%20Engineer", {
      DB: mem.db, POLAR_ACCESS_TOKEN: "t", POLAR_PRODUCT_ID: "p", RAPIDAPI_PROXY_SECRET: "rs",
    });
    expect(gated.status).toBe(200); // not 401/405: community route
    const noDb = await recent("?job=Software%20Engineer");
    expect(noDb.status).toBe(200);
    expect(noDb.body.data.count).toBe(0); // section hides gracefully on the site
  });
});
