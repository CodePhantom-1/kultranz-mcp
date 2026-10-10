#!/usr/bin/env node
/**
 * Moderate community salary submissions (kultranz.com flywheel).
 *
 * Run by a human or automation ~weekly. Lists pending submissions with spam
 * flags, and approves/rejects by id via Cloudflare D1 (wrangler CLI). No
 * dependencies beyond Node + npx wrangler (already used for deploys).
 *
 * USAGE (from anywhere — the script locates api/wrangler.toml itself):
 *   node api/scripts/moderate-submissions.mjs                 # list pending + flags
 *   node api/scripts/moderate-submissions.mjs --approve 42    # approve id 42
 *   node api/scripts/moderate-submissions.mjs --reject  42    # reject  id 42
 *
 * EXACT COMMANDS THIS SCRIPT RUNS (for manual use / runbook):
 *   List pending (200 newest, bounded — D1 free tier):
 *     npx wrangler d1 execute kultranz --remote --json --config api/wrangler.toml \
 *       --command "SELECT id, job_title, city, state, salary, years_experience, title, ip_hash, status, created_at FROM salary_submissions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200"
 *   Approve:
 *     npx wrangler d1 execute kultranz --remote --config api/wrangler.toml \
 *       --command "UPDATE salary_submissions SET status = 'approved' WHERE id = 42"
 *   Reject:
 *     npx wrangler d1 execute kultranz --remote --config api/wrangler.toml \
 *       --command "UPDATE salary_submissions SET status = 'rejected' WHERE id = 42"
 *
 * SPAM FLAGS in the listing (advisory — the human decides):
 *   SPAM-URL    free text contains http(s):// or www. (API rejects these on
 *               submit, so any that appear mean the row predates that guard)
 *   SPAM-SALARY salary outside 1,000..5,000,000 (same: belt-and-braces)
 *   BURST       >= 3 pending submissions share one ip_hash (flooding)
 *
 * Rows are never deleted — rejected stays in D1 for audit. The ids in
 * --approve/--reject are parsed as integers, so there is no SQL to inject.
 */
import { execFileSync } from "node:child_process";

// Preferred path (2026-10-03 review): the Worker admin endpoint — the CI CF
// token lacks D1 REST perms (7403). Falls back to the wrangler path below
// when ADMIN_KEY is unset.
const ADMIN_KEY = process.env.ADMIN_KEY;
const ADMIN_ENDPOINT = process.env.MOD_ENDPOINT || "https://api.kultranz.com/admin/submissions";
if (ADMIN_KEY) {
  const args = process.argv.slice(2);
  let act = "list", id = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approve") { act = "approve"; id = args[i + 1] || ""; }
    if (args[i] === "--reject")  { act = "reject";  id = args[i + 1] || ""; }
  }
  if (act !== "list" && !/^\d+$/.test(id)) { console.error("--approve/--reject need a numeric id"); process.exit(1); }
  const res = await fetch(ADMIN_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(id ? { action: act, id: Number(id) } : { action: act }),
  }).catch((e) => { console.error("endpoint failed:", e.message); process.exit(1); });
  console.log(`[admin ${res.status}]`, (await res.text()).slice(0, 4000));
  process.exit(0);
}
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// api/scripts/moderate-submissions.mjs -> api/wrangler.toml
const WRANGLER_CONFIG = path.resolve(SCRIPT_DIR, "..", "wrangler.toml");

const LIST_LIMIT = 200;
const BURST_THRESHOLD = 3;
const SALARY_MIN = 1_000;
const SALARY_MAX = 5_000_000;
const URL_RE = /(https?:\/\/|www\.)/i;

function d1(sql) {
  // execFileSync with an argv array — the SQL contains spaces and quotes, so
  // it must never go through a shell string.
  const args = [
    "npx", "wrangler", "d1", "execute", "kultranz",
    "--remote", "--json",
    "--config", WRANGLER_CONFIG,
    "--command", sql,
  ];
  const stdout = execFileSync("npx", args.slice(1), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  // wrangler --json prints a JSON array (occasionally after log noise):
  // take the outermost [ ... ] block.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return parsed[0]?.results ?? [];
}

function fmtRow(r, flags) {
  const when = new Date(r.created_at).toISOString().slice(0, 10);
  const title = r.title ? `"${r.title}"` : "—";
  const years = r.years_experience == null ? "—" : `${r.years_experience}y`;
  const salary = `$${Number(r.salary).toLocaleString("en-US")}`;
  return `${String(r.id).padStart(4)}  ${String(flags).padEnd(11)} ${String(r.job_title).slice(0, 28).padEnd(28)} ` +
    `${String(r.city).slice(0, 18).padEnd(18)} ${String(r.state).padEnd(2)} ${salary.padStart(11)} ${years.padStart(3)} ` +
    `${String(title).slice(0, 18).padEnd(18)} ${when}  ip=${String(r.ip_hash).slice(0, 8)}`;
}

function listPending() {
  const rows = d1(
    "SELECT id, job_title, city, state, salary, years_experience, title, ip_hash, status, created_at " +
    `FROM salary_submissions WHERE status = 'pending' ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
  );
  if (!rows.length) {
    console.log("No pending submissions. (Table may not exist yet — that is fine until the first submit.)");
    return;
  }
  // ip_hash burst detection: >= BURST_THRESHOLD pending from one hashed IP.
  const perIp = new Map();
  for (const r of rows) perIp.set(r.ip_hash, (perIp.get(r.ip_hash) ?? 0) + 1);

  console.log(`Pending submissions (newest first, ${rows.length} shown — cap ${LIST_LIMIT}):`);
  console.log(`${"ID".padStart(4)}  ${"FLAG".padEnd(11)} ${"JOB TITLE".padEnd(28)} ${"CITY".padEnd(18)} ST ${"SALARY".padStart(11)} YRS ${"LEVEL".padEnd(18)} REPORTED    IP-HASH`);
  for (const r of rows) {
    const flags = [];
    if (URL_RE.test(`${r.job_title ?? ""} ${r.city ?? ""} ${r.title ?? ""}`)) flags.push("SPAM-URL");
    if (Number(r.salary) < SALARY_MIN || Number(r.salary) > SALARY_MAX) flags.push("SPAM-SALARY");
    if ((perIp.get(r.ip_hash) ?? 0) >= BURST_THRESHOLD) flags.push("BURST");
    console.log(fmtRow(r, flags.join("+") || "ok"));
  }
  console.log(`
Next: node api/scripts/moderate-submissions.mjs --approve <ID>   (goes live on the site)
      node api/scripts/moderate-submissions.mjs --reject  <ID>   (hidden, kept for audit)`);
}

function setStatus(id, status) {
  d1(`UPDATE salary_submissions SET status = '${status}' WHERE id = ${id}`);
  const after = d1(`SELECT id, job_title, city, state, salary, status FROM salary_submissions WHERE id = ${id}`);
  if (!after.length) {
    console.error(`id ${id} not found in salary_submissions — nothing changed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Submission ${id} is now ${after[0].status}:`, after[0]);
}

// ---- args ----
const argv = process.argv.slice(2);
if (argv.includes("--approve")) {
  const id = parseInt(argv[argv.indexOf("--approve") + 1] ?? "", 10);
  if (!Number.isInteger(id)) { console.error("--approve needs a numeric id"); process.exit(1); }
  setStatus(id, "approved");
} else if (argv.includes("--reject")) {
  const id = parseInt(argv[argv.indexOf("--reject") + 1] ?? "", 10);
  if (!Number.isInteger(id)) { console.error("--reject needs a numeric id"); process.exit(1); }
  setStatus(id, "rejected");
} else {
  listPending();
}
