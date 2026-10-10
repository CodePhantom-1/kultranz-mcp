CREATE TABLE IF NOT EXISTS salary_data (
  job_title TEXT NOT NULL,
  job_code TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  avg_salary REAL,
  salary_10th REAL,
  salary_25th REAL,
  salary_median REAL,
  salary_75th REAL,
  salary_90th REAL,
  national_avg REAL,
  employment INTEGER,
  rpp_all_items REAL,
  median_rent REAL,
  median_home_value REAL,
  city_median_income REAL,
  city_population INTEGER,
  data_quality_score INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Runtime tables below are created LAZILY by the Worker itself (CREATE TABLE
-- IF NOT EXISTS in src/billing.ts, src/mcp.ts, src/submissions.ts). They are
-- restated here to document the full schema. EXISTING production D1 databases
-- need no migration: the Worker creates mcp_usage / validation_fails on first
-- use, and nothing about the pre-existing tables changes. IPs and keys are
-- only ever stored SHA-256-hashed, never raw.
--
--   api_usage        REST free tier meter: 25 GETs/day per hashed IP.
--   mcp_usage        /mcp tool-call meter: 200 tool calls/day per hashed IP
--                    (sibling table, not an api_usage column, so MCP usage can
--                    never consume the REST counter and no PK migration is
--                    needed).
--   validation_fails anti-probe meter: definitive Polar license-validation
--                    misses per hashed IP (20/day); past the limit further
--                    validation attempts answer 401 without calling Polar.
--   licenses         24h verdict cache for Polar license keys (key hashed).
--   salary_submissions / submission_usage   community flywheel (submissions.ts).
CREATE TABLE IF NOT EXISTS licenses (
  key_hash TEXT PRIMARY KEY,
  status TEXT,
  validated_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_usage (
  ip_hash TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (ip_hash, day)
);
CREATE TABLE IF NOT EXISTS mcp_usage (
  ip_hash TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (ip_hash, day)
);
CREATE TABLE IF NOT EXISTS validation_fails (
  ip_hash TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (ip_hash, day)
);
CREATE TABLE IF NOT EXISTS salary_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_title TEXT, city TEXT, state TEXT, salary INTEGER,
  years_experience INTEGER, title TEXT,
  ip_hash TEXT, status TEXT DEFAULT 'pending', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS submission_usage (
  ip_hash TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (ip_hash, day)
);
