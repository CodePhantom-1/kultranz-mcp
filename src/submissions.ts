/**
 * Community salary submissions — the levels.fyi-style user flywheel.
 *
 * Two endpoints, wired in index.ts (and exempt from the billing/RapidAPI
 * gates there, like /billing/buy: the kultranz.com pages are this Worker's
 * own distribution channel, and these routes carry their own defenses):
 *
 *   POST /salaries/submit — anonymous, JSON body:
 *     { job_title, city, state, salary, years_experience?, title?,
 *       source? ("community"), honeypot }
 *     Honeypot: the `honeypot` field AND the site's hidden `website` field
 *     must be absent or empty — bots that fill hidden inputs are shed.
 *     Validation: salary 1,000..5,000,000 (annual, $ and commas tolerated),
 *     state a 2-letter code, job_title/city 2..80 chars, HTML stripped,
 *     any http(s)/www. URL in the free text → spam reject.
 *     Rate limit: 5 submissions/day per SHA-256-hashed IP (D1 counter,
 *     same atomic increment-and-read pattern as billing.ts api_usage).
 *     Stored with status 'pending'; a human/automation moderation pass
 *     (scripts/moderate-submissions.mjs) approves or rejects.
 *
 *   GET /salaries/recent?job=<title>&city=<city>&limit=10 — APPROVED rows
 *     only, parameterized D1 query, LIMIT clamped 1..50. At least one of
 *     job/city is required. No auth: people chose to post this publicly.
 *
 * D1 tables, created lazily on first use (same launch-grade pattern as
 * billing.ts — no migration needed, works on a fresh database):
 *
 *   salary_submissions(
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     job_title TEXT, city TEXT, state TEXT, salary INTEGER,
 *     years_experience INTEGER, title TEXT,
 *     ip_hash TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)
 *   submission_usage(ip_hash TEXT, day TEXT, count INTEGER,
 *     PRIMARY KEY (ip_hash, day))
 *
 * IPs are only ever stored SHA-256-hashed (never raw), and ip_hash is never
 * returned by any endpoint.
 */
import type { Context } from "hono";
import { normalizeRateIp } from "./lib/rate-ip";
import { anySecretMatches } from "./lib/secure-compare";

export interface SubmissionsEnv {
  DB?: D1Database;
}

const DAILY_SUBMIT_LIMIT = 5;
/** Usage rows and verdict-cache rows older than this are pruned (see
 * pruneExpired, piggybacked on the admin moderation pass). */
const PRUNE_AFTER_DAYS = 30;
const SALARY_MIN = 1_000;
const SALARY_MAX = 5_000_000;
const YEARS_MAX = 80;
const RECENT_DEFAULT_LIMIT = 10;
const RECENT_MAX_LIMIT = 50;

const RECENT_META = {
  source: "Community self-reports via kultranz.com (moderated, unverified)",
  vintage: "live",
  year: new Date().getUTCFullYear(),
};

// ---------------------------------------------------------------------------
// hashing — IPs are never stored raw (same helper as billing.ts, kept private
// to each module so neither imports the other's internals)
// ---------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// D1: lazy table creation (WeakSet keyed on the binding object, per isolate —
// CREATE IF NOT EXISTS is idempotent so a fresh binding just pays one round-trip)
// ---------------------------------------------------------------------------
const ensuredTables = new WeakSet<object>();

async function ensureTables(db: D1Database): Promise<void> {
  if (ensuredTables.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS salary_submissions (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "job_title TEXT, city TEXT, state TEXT, salary INTEGER, " +
      "years_experience INTEGER, title TEXT, " +
      "ip_hash TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)",
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS submission_usage (" +
      "ip_hash TEXT, day TEXT, count INTEGER, PRIMARY KEY (ip_hash, day))",
  ).run();
  ensuredTables.add(db);
}

// ---------------------------------------------------------------------------
// sanitization + spam heuristics
// ---------------------------------------------------------------------------
/** Strip HTML tags, stray angle brackets and control chars; collapse spaces. */
function cleanText(v: unknown): string {
  return String(v ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spam heuristics: any URL in the free-text fields. */
const URL_RE = /(https?:\/\/|www\.)\S*/i;

/** Number coercion for salary/years: number or numeric string, $ and , ok. */
function coerceNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.trim().replace(/[$,\s]/g, ""));
  return NaN;
}

type Validated = {
  job_title: string;
  city: string;
  state: string;
  salary: number;
  years_experience: number | null;
  title: string | null;
};

type Invalid = { code: string; message: string };

/**
 * Pure validation + sanitization of the submit body. Returns the clean row or
 * an error descriptor — no I/O, so it is exhaustively unit-testable.
 */
export function validateSubmission(body: unknown): { ok: true; value: Validated } | { ok: false; error: Invalid } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: { code: "invalid_body", message: "Request body must be a JSON object." } };
  }
  const b = body as Record<string, unknown>;

  // Honeypot first — cheapest spam shed. Both the API field name and the
  // site form's hidden `website` input must be absent or empty.
  for (const key of ["honeypot", "website"]) {
    const v = b[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return { ok: false, error: { code: "spam", message: "Submission rejected." } };
    }
  }

  // Fixed-source field: anything else is a client we didn't write.
  if (b.source !== undefined && b.source !== "community") {
    return { ok: false, error: { code: "invalid_source", message: 'source must be "community".' } };
  }

  const jobTitle = cleanText(b.job_title);
  if (jobTitle.length < 2 || jobTitle.length > 80) {
    return { ok: false, error: { code: "invalid_job_title", message: "job_title must be 2..80 characters." } };
  }
  const city = cleanText(b.city);
  if (city.length < 2 || city.length > 80) {
    return { ok: false, error: { code: "invalid_city", message: "city must be 2..80 characters." } };
  }
  const state = cleanText(b.state).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return { ok: false, error: { code: "invalid_state", message: "state must be a 2-letter code (e.g. TX)." } };
  }
  const salaryNum = coerceNum(b.salary);
  if (!Number.isFinite(salaryNum) || salaryNum < SALARY_MIN || salaryNum > SALARY_MAX) {
    return { ok: false, error: { code: "invalid_salary", message: `salary must be an annual number between ${SALARY_MIN.toLocaleString()} and ${SALARY_MAX.toLocaleString()}.` } };
  }
  let years: number | null = null;
  if (b.years_experience !== undefined && b.years_experience !== null && b.years_experience !== "") {
    const y = coerceNum(b.years_experience);
    if (!Number.isFinite(y) || y < 0 || y > YEARS_MAX) {
      return { ok: false, error: { code: "invalid_years", message: `years_experience must be between 0 and ${YEARS_MAX}.` } };
    }
    years = Math.round(y);
  }
  const title = cleanText(b.title);
  if (title.length > 80) {
    return { ok: false, error: { code: "invalid_title", message: "title must be at most 80 characters." } };
  }
  if (URL_RE.test(`${jobTitle} ${city} ${title}`)) {
    return { ok: false, error: { code: "spam", message: "Submission rejected." } };
  }
  return {
    ok: true,
    value: {
      job_title: jobTitle,
      city,
      state,
      salary: Math.round(salaryNum),
      years_experience: years,
      title: title || null,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /salaries/submit
// ---------------------------------------------------------------------------
export async function handleSubmit(c: Context, env: SubmissionsEnv | undefined): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const checked = validateSubmission(body);
  if (!checked.ok) {
    return c.json({ error: checked.error }, 400);
  }

  if (!env?.DB) {
    return c.json({ error: { code: "db_unavailable", message: "Storage is not configured." } }, 503);
  }
  const db = env.DB;
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(normalizeRateIp(ip));

  try {
    await ensureTables(db);

    // Rate limit AFTER validation: an honest user who typos their salary six
    // times can still succeed once fixed; only well-formed submissions meter.
    // Atomic increment-and-read — concurrent requests cannot undercount.
    const day = new Date().toISOString().slice(0, 10); // UTC day key
    const usage = await db.prepare(
      "INSERT INTO submission_usage (ip_hash, day, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 RETURNING count",
    ).bind(ipHash, day).first<{ count: number }>();
    if ((usage?.count ?? 1) > DAILY_SUBMIT_LIMIT) {
      return c.json({
        error: { code: "rate_limited", message: `Submission limit is ${DAILY_SUBMIT_LIMIT}/day. Try again tomorrow.` },
      }, 429);
    }

    const res = await db.prepare(
      "INSERT INTO salary_submissions " +
        "(job_title, city, state, salary, years_experience, title, ip_hash, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      checked.value.job_title,
      checked.value.city,
      checked.value.state,
      checked.value.salary,
      checked.value.years_experience,
      checked.value.title,
      ipHash,
      "pending",
      Date.now(),
    ).run();
    const id = res?.meta?.last_row_id ?? null;
    return c.json({ data: { id, status: "pending" } }, 201);
  } catch {
    return c.json({ error: { code: "db_error", message: "Could not store the submission. Try again shortly." } }, 503);
  }
}

// ---------------------------------------------------------------------------
// GET /salaries/recent
// ---------------------------------------------------------------------------
interface RecentRow {
  job_title: string;
  city: string;
  state: string;
  salary: number;
  years_experience: number | null;
  title: string | null;
  created_at: number;
}

export async function handleRecent(c: Context, env: SubmissionsEnv | undefined): Promise<Response> {
  const job = cleanText(c.req.query("job"));
  const city = cleanText(c.req.query("city"));
  if (!job && !city) {
    return c.json({ error: { code: "missing", message: "Provide job and/or city." } }, 400);
  }
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), RECENT_MAX_LIMIT)
    : RECENT_DEFAULT_LIMIT;

  let rows: RecentRow[] = [];
  try {
    if (env?.DB) {
      const db = env.DB;
      await ensureTables(db);
      // Exact match, case-insensitive (SQLite COLLATE NOCASE) — no LIKE
      // wildcards to smuggle, every value bound, LIMIT always present.
      let sql = "SELECT job_title, city, state, salary, years_experience, title, created_at " +
        "FROM salary_submissions WHERE status = ?";
      const args: (string | number)[] = ["approved"];
      if (job) { sql += " AND job_title = ? COLLATE NOCASE"; args.push(job); }
      if (city) { sql += " AND city = ? COLLATE NOCASE"; args.push(city); }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
      args.push(limit);
      const { results } = await db.prepare(sql).bind(...args).all<RecentRow>();
      rows = results ?? [];
    }
  } catch { /* read path fails open — the page hides the section gracefully */ }

  return c.json({
    data: {
      count: rows.length,
      submissions: rows.map((r) => ({
        job_title: r.job_title,
        city: r.city,
        state: r.state,
        salary: r.salary,
        years_experience: r.years_experience,
        title: r.title,
        posted_at: new Date(r.created_at).toISOString(),
      })),
    },
    meta: RECENT_META,
  });
}

// ---------------------------------------------------------------------------
// Opportunistic D1 pruning: usage counters and license verdict-cache rows
// older than PRUNE_AFTER_DAYS are dead weight in a database that only grows.
// Called from the admin list handler (see above). Every DELETE is idempotent
// and individually best-effort — a legacy database predating one of the
// lazily created tables just skips that statement — and pruning never fails
// the moderation call it rides on.
// ---------------------------------------------------------------------------
export async function pruneExpired(db: D1Database): Promise<void> {
  const cutoffMs = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const dayCutoff = new Date(cutoffMs).toISOString().slice(0, 10); // UTC day key
  const prunes: [string, string | number][] = [
    ["DELETE FROM api_usage WHERE day < ?", dayCutoff],
    ["DELETE FROM submission_usage WHERE day < ?", dayCutoff],
    ["DELETE FROM mcp_usage WHERE day < ?", dayCutoff],
    ["DELETE FROM validation_fails WHERE day < ?", dayCutoff],
    ["DELETE FROM licenses WHERE validated_at < ?", cutoffMs],
  ];
  for (const [sql, cutoff] of prunes) {
    try {
      await db.prepare(sql).bind(cutoff).run();
    } catch { /* table absent on a legacy DB → nothing to prune */ }
  }
}

// ---------------------------------------------------------------------------
// Admin moderation via the Worker's own D1 binding. The Cloudflare API token
// used by CI lacks D1 REST permissions (code 7403), but the binding the
// Worker already uses for writes bypasses that — so approve/reject/list ride
// the same path, gated by the ADMIN_KEY secret (unset -> 501).
// ---------------------------------------------------------------------------
export async function handleAdmin(c: Context, env: SubmissionsEnv | undefined): Promise<Response> {
  const key = (env as { ADMIN_KEY?: string } | undefined)?.ADMIN_KEY;
  if (!key) {
    return c.json({ error: { code: "admin_disabled", message: "ADMIN_KEY is not configured." } }, 501);
  }
  // Timing-safe compare via the shared helper — same treatment as every
  // other key gate (a plain === leaks length/prefix timing).
  const auth = c.req.header("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!(await anySecretMatches([bearer, c.req.header("X-Admin-Key") || ""], key))) {
    return c.json({ error: { code: "unauthorized", message: "Bad admin key." } }, 401);
  }
  let body: { action?: string; id?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_body", message: "JSON body required." } }, 400);
  }
  try {
    const db = (env as { DB?: D1Database }).DB;
    if (!db) throw new Error("no db");
    await ensureTables(db);
    if (body.action === "list") {
      // Opportunistic pruning — see pruneExpired below. Runs here because
      // this handler is driven by the weekly moderation pass, the only
      // recurring traffic that reaches it, so the moderation job doubles
      // as the Worker's one "scheduled" cleanup.
      await pruneExpired(db);
      const { results } = await db.prepare(
        "SELECT id, job_title, city, state, salary, years_experience, title, ip_hash, status, created_at " +
        "FROM salary_submissions ORDER BY created_at DESC LIMIT 200").all();
      return c.json({ data: { count: results?.length ?? 0, submissions: results ?? [] } });
    }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: "invalid_id", message: "id must be a positive integer." } }, 400);
    }
    if (body.action !== "approve" && body.action !== "reject") {
      return c.json({ error: { code: "invalid_action", message: "action must be list|approve|reject." } }, 400);
    }
    const status = body.action === "approve" ? "approved" : "rejected";
    const res = await db.prepare("UPDATE salary_submissions SET status = ? WHERE id = ?").bind(status, id).run();
    if (!res.meta?.changes) {
      return c.json({ error: { code: "not_found", message: `No submission with id ${id}.` } }, 404);
    }
    return c.json({ data: { id, status } });
  } catch {
    return c.json({ error: { code: "db_error", message: "Moderation database error." } }, 503);
  }
}
