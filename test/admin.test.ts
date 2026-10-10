// /admin/submissions tests — the ADMIN_KEY-gated moderation surface
// (501 when unset, 401 wrong key, list / approve / reject happy paths) plus
// the opportunistic D1 pruning piggybacked on the list action. The in-memory
// D1 stub follows the memoryD1 pattern in submissions.test.ts, extended with
// the admin SELECT/UPDATE statements and the pruning DELETEs.
import { describe, it, expect } from "vitest";
import app from "../src/index";

type Stmt = { sql: string; args: unknown[] };
type Row = {
  id: number; job_title: string; city: string; state: string; salary: number;
  years_experience: number | null; title: string | null; ip_hash: string;
  status: string; created_at: number;
};

function memoryD1(opts: { failDeletes?: boolean } = {}) {
  const submissions: Row[] = [];
  // Generic usage-counter store shared by every `*_usage` table:
  // `${table}|${ip_hash}|${day}` -> count (also used by the pruning tests).
  const usage = new Map<string, number>();
  const licenses = new Map<string, { status: string; validated_at: number }>();
  const stmts: Stmt[] = [];
  const creates: string[] = [];
  const prunes: Stmt[] = [];

  const route = (sql: string, args: unknown[], kind: "first" | "run" | "all"): unknown => {
    stmts.push({ sql, args });
    if (sql.startsWith("CREATE TABLE")) { creates.push(sql); return { success: true }; }
    if (sql.startsWith("DELETE FROM")) {
      if (opts.failDeletes) throw new Error("no such table");
      prunes.push({ sql, args });
      const cutoff = String(args[0]);
      if (sql.startsWith("DELETE FROM licenses")) {
        for (const [k, v] of [...licenses.entries()]) {
          if (String(v.validated_at) < cutoff) licenses.delete(k);
        }
      } else {
        const table = sql.split(" ")[2];
        for (const k of [...usage.keys()]) {
          const [t, , day] = k.split("|");
          if (t === table && day < cutoff) usage.delete(k);
        }
      }
      return { success: true };
    }
    if (sql.startsWith("SELECT id, job_title")) {
      const rows = [...submissions].sort((a, b) => b.created_at - a.created_at).slice(0, 200);
      return { results: rows };
    }
    if (sql.startsWith("UPDATE salary_submissions")) {
      const row = submissions.find((r) => r.id === Number(args[1]));
      if (!row) return { success: true, meta: { changes: 0 } };
      row.status = String(args[0]);
      return { success: true, meta: { changes: 1 } };
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

  return { db, submissions, usage, licenses, stmts, creates, prunes };
}

type AdminOpts = {
  env?: Record<string, unknown>;
  auth?: "bearer" | "header" | "bad-bearer" | "bad-header" | "none";
  rawBody?: string;
};

async function admin(body: unknown, opts: AdminOpts = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const auth = opts.auth ?? "bearer";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "bearer") headers.Authorization = "Bearer admin-secret";
  if (auth === "bad-bearer") headers.Authorization = "Bearer wrong";
  if (auth === "header") headers["X-Admin-Key"] = "admin-secret";
  if (auth === "bad-header") headers["X-Admin-Key"] = "wrong";
  const res = await app.request("/admin/submissions", {
    method: "POST",
    headers,
    body: opts.rawBody ?? (typeof body === "string" ? body : JSON.stringify(body)),
  }, (opts.env ?? { DB: memoryD1().db, ADMIN_KEY: "admin-secret" }) as never);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

function seededEnv() {
  const mem = memoryD1();
  mem.submissions.push(
    { id: 1, job_title: "Software Engineer", city: "Austin", state: "TX", salary: 145000, years_experience: 5, title: "Senior", ip_hash: "h1", status: "pending", created_at: 2000 },
    { id: 2, job_title: "Registered Nurse", city: "Phoenix", state: "AZ", salary: 90000, years_experience: null, title: null, ip_hash: "h2", status: "pending", created_at: 1000 },
  );
  return { mem, env: { DB: mem.db, ADMIN_KEY: "admin-secret" } };
}

describe("POST /admin/submissions — auth", () => {
  it("501 when ADMIN_KEY is unset (feature off, no D1 touched)", async () => {
    const mem = memoryD1();
    const r = await admin({ action: "list" }, { env: { DB: mem.db } });
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe("admin_disabled");
  });

  it("401 with a wrong Bearer key — and the denial carries open CORS", async () => {
    const mem = memoryD1();
    const r = await admin({ action: "list" }, { env: { DB: mem.db, ADMIN_KEY: "admin-secret" }, auth: "bad-bearer" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("401 with a wrong X-Admin-Key header", async () => {
    const mem = memoryD1();
    const r = await admin({ action: "list" }, { env: { DB: mem.db, ADMIN_KEY: "admin-secret" }, auth: "bad-header" });
    expect(r.status).toBe(401);
  });

  it("400 when the body is not JSON", async () => {
    const { mem, env } = seededEnv();
    const r = await admin("this is not json{{", { env, rawBody: "this is not json{{" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_body");
    expect(mem.prunes).toHaveLength(0); // rejected before any D1 work
    void mem;
  });
});

describe("POST /admin/submissions — moderation", () => {
  it("list returns all submissions newest-first with a count", async () => {
    const { mem, env } = seededEnv();
    void mem;
    const r = await admin({ action: "list" }, { env });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(2);
    expect(r.body.data.submissions.map((s: any) => s.id)).toEqual([1, 2]); // created_at DESC
  });

  it("approve flips the row to approved and echoes it", async () => {
    const { mem, env } = seededEnv();
    const r = await admin({ action: "approve", id: 2 }, { env });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: 2, status: "approved" });
    expect(mem.submissions.find((s) => s.id === 2)?.status).toBe("approved");
  });

  it("reject flips the row to rejected and echoes it", async () => {
    const { mem, env } = seededEnv();
    const r = await admin({ action: "reject", id: 1 }, { env });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: 1, status: "rejected" });
    expect(mem.submissions.find((s) => s.id === 1)?.status).toBe("rejected");
  });

  it("X-Admin-Key header also authenticates", async () => {
    const { env } = seededEnv();
    const r = await admin({ action: "list" }, { env, auth: "header" });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(2);
  });

  it("404 for an unknown id; 400 for an invalid id or action", async () => {
    const { env } = seededEnv();
    expect((await admin({ action: "approve", id: 99 }, { env })).status).toBe(404);
    expect((await admin({ action: "approve", id: 0 }, { env })).status).toBe(400);
    expect((await admin({ action: "approve", id: -1 }, { env })).status).toBe(400);
    expect((await admin({ action: "destroy", id: 1 }, { env })).status).toBe(400);
  });
});

describe("opportunistic pruning (rides on the admin list action)", () => {
  const day = (offsetDays: number) =>
    new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it("list deletes usage rows and license cache rows older than 30 days — and only those", async () => {
    const { mem, env } = seededEnv();
    const fresh = day(1);
    const stale = day(40);
    mem.usage.set(`api_usage|ip1|${fresh}`, 3);
    mem.usage.set(`api_usage|ip2|${stale}`, 9);
    mem.usage.set(`submission_usage|ip1|${stale}`, 2);
    mem.usage.set(`submission_usage|ip1|${fresh}`, 1);
    mem.usage.set(`mcp_usage|ip1|${stale}`, 5);
    mem.usage.set(`mcp_usage|ip1|${fresh}`, 4);
    mem.usage.set(`validation_fails|ip1|${stale}`, 7);
    mem.licenses.set("k1", { status: "valid", validated_at: Date.now() - 40 * 24 * 3600 * 1000 });
    mem.licenses.set("k2", { status: "valid", validated_at: Date.now() - 1000 });

    const r = await admin({ action: "list" }, { env });
    expect(r.status).toBe(200); // pruning never breaks the moderation call

    // All five pruning statements fired, each with a bound cutoff parameter.
    const tables = mem.prunes.map((p) => p.sql.split(" ")[2]).sort();
    expect(tables).toEqual(["api_usage", "licenses", "mcp_usage", "submission_usage", "validation_fails"]);
    for (const p of mem.prunes) expect(p.sql).toMatch(/< \?$/);

    // Stale rows gone, fresh rows kept.
    expect(mem.usage.has(`api_usage|ip2|${stale}`)).toBe(false);
    expect(mem.usage.has(`submission_usage|ip1|${stale}`)).toBe(false);
    expect(mem.usage.has(`mcp_usage|ip1|${stale}`)).toBe(false);
    expect(mem.usage.has(`validation_fails|ip1|${stale}`)).toBe(false);
    expect(mem.usage.has(`api_usage|ip1|${fresh}`)).toBe(true);
    expect(mem.usage.has(`submission_usage|ip1|${fresh}`)).toBe(true);
    expect(mem.usage.has(`mcp_usage|ip1|${fresh}`)).toBe(true);
    expect(mem.licenses.has("k1")).toBe(false);
    expect(mem.licenses.has("k2")).toBe(true);
  });

  it("pruning failures (missing tables on a legacy DB) never fail the list", async () => {
    const mem = memoryD1({ failDeletes: true });
    mem.submissions.push({
      id: 1, job_title: "Nurse", city: "Phoenix", state: "AZ", salary: 90000,
      years_experience: null, title: null, ip_hash: "h1", status: "pending", created_at: 1,
    });
    const r = await admin({ action: "list" }, { env: { DB: mem.db, ADMIN_KEY: "admin-secret" } });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(1);
  });
});
