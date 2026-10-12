# Kultranz MCP Server — US Salary, Tax & Cost of Living

[![Glama MCP Score](https://glama.ai/mcp/servers/CodePhantom-1/kultranz-mcp/badges/score.svg)](https://glama.ai/mcp/servers/CodePhantom-1/kultranz-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-blue)](https://smithery.ai/servers/cianot978/kultranz)
[![TensorBlock](https://img.shields.io/badge/TensorBlock-listed-blue)](https://github.com/TensorBlock/awesome-mcp-servers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Remote MCP server (Streamable HTTP) + REST API over real US government data.
**Live endpoint: https://api.kultranz.com/mcp** — no auth, no API key. The free tier is metered: **200 tool calls/day per IP** (`initialize`, `ping` and `tools/list` are never metered; JSON-RPC batches are capped at 16 entries).

Five read-only tools a model cannot compute itself:

| Tool | What it returns |
|---|---|
| `get_take_home_pay` | 2026 net pay from gross: federal tax, Social Security (2026 wage base), Medicare, state income tax — all 50 states + DC |
| `compare_cost_of_living` | Equivalent salary between two US metros (BEA Regional Price Parities, US=100) with per-category monthly breakdown |
| `get_tax_brackets` | Full IRS 2026 bracket ladder + standard deduction, plus any state's rules (none/flat/progressive) |
| `list_metros` | The 50 supported metros: price index, median rent, home value, household income |
| `get_salary_percentiles` | BLS OEWS annual wages, 10th–90th percentile spread, by occupation × metro |

## Why this exists

Ask five paycheck calculators what $85,000 nets in Missouri and you will get five answers, because three 2026 state schedules are widely mis-modeled: Missouri is graduated (0 to 4.7% starting above $9,436, not flat), Mississippi charges 0% on the first $10,000, and Ohio taxes nothing below $26,050. All three were corrected on 2026-10-09 against the state Departments of Revenue, and everything behind the fix is open: the datasets (CC BY 4.0), the D1 seed, and this server.

The bar this repo holds itself to: if a number cannot be traced to a named release (BLS OEWS, BEA RPP, Census ACS, IRS Rev. Proc. 2025-32, or a state DOR form), it does not ship. Corrections are applied fast: open an issue with the source and we fix the data, not the marketing.

## Use it

Any MCP client that speaks Streamable HTTP (Claude Desktop, Claude Code, Cursor, Windsurf):

```
claude mcp add --transport http kultranz https://api.kultranz.com/mcp
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "kultranz": { "url": "https://api.kultranz.com/mcp" }
  }
}
```

Stateless server: plain `POST https://api.kultranz.com/mcp` with JSON-RPC 2.0 works from curl or fetch, no session required.

## Pricing

| Surface | Free tier | Paid |
|---|---|---|
| MCP (`/mcp`) | 200 tool calls/day per IP, no key | — |
| REST API | 25 requests/day | [$5 lifetime key](https://kultranz.com/pages/api-docs/?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct): no rate limit, no RapidAPI requirement |
| RapidAPI | — | [Pro / Ultra / Mega tiers](https://rapidapi.com/cianot978/api/kultranz?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct), gated by the RapidAPI proxy secret |

Docs and full pricing: https://kultranz.com/pages/api-docs/?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct

## What is in this repo

A complete, deployable Cloudflare Worker: the MCP server, the REST API it shares a codebase with, the D1 schema + seed (50 metros, 51 tax jurisdictions, salary percentiles), the community salary-submission flywheel (`src/submissions.ts` + moderation script in `scripts/`), and a 206-test vitest suite (`npm test`).

## Run your own

```bash
npm install
npx wrangler d1 create kultranz   # then put the id in wrangler.toml
npx wrangler d1 execute kultranz --file schema.sql
npx wrangler d1 execute kultranz --file seed.sql
npm test
npx wrangler deploy
```

All credentials are environment secrets (`RAPIDAPI_PROXY_SECRET`, `MCP_API_KEY`, `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID`) — none are required to run the open MCP endpoint.

Data sources: BLS OEWS · BEA Regional Price Parities · U.S. Census ACS · IRS 2026.
Methodology: https://kultranz.com/pages/methodology/?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct · Docs & pricing: https://kultranz.com/pages/api-docs/?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct
Open datasets (CC BY 4.0): [us-salary-cost-of-living-dataset](https://github.com/CodePhantom-1/us-salary-cost-of-living-dataset?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct) · [2026-tax-brackets](https://github.com/CodePhantom-1/kultranz-2026-tax-brackets?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct) · [cost-of-living-index](https://github.com/CodePhantom-1/kultranz-cost-of-living-index?utm_source=github&utm_medium=organic&utm_campaign=revtest-oct)

MIT License. © kultranz.com
