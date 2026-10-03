# Kultranz MCP Server — US Salary, Tax & Cost of Living

Remote MCP server (Streamable HTTP) + REST API over real US government data.
**Live endpoint: https://api.kultranz.com/mcp** — free, no auth, no quota.

Five read-only tools a model cannot compute itself:

| Tool | What it returns |
|---|---|
| `get_take_home_pay` | 2026 net pay from gross: federal tax, Social Security (2026 wage base), Medicare, state income tax — all 50 states + DC |
| `compare_cost_of_living` | Equivalent salary between two US metros (BEA Regional Price Parities, US=100) with per-category monthly breakdown |
| `get_tax_brackets` | Full IRS 2026 bracket ladder + standard deduction, plus any state's rules (none/flat/progressive) |
| `list_metros` | The 50 supported metros: price index, median rent, home value, household income |
| `get_salary_percentiles` | BLS OEWS annual wages, 10th–90th percentile spread, by occupation × metro |

## Use it

Any MCP client (Claude, Cursor, Windsurf, Claude Code):
```
claude mcp add --transport http kultranz https://api.kultranz.com/mcp
```

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
Methodology: https://kultranz.com/pages/methodology/ · Docs & pricing: https://kultranz.com/pages/api-docs/
Open datasets (CC BY 4.0): [us-salary-cost-of-living-dataset](https://github.com/CodePhantom-1/us-salary-cost-of-living-dataset) · [2026-tax-brackets](https://github.com/CodePhantom-1/kultranz-2026-tax-brackets) · [cost-of-living-index](https://github.com/CodePhantom-1/kultranz-cost-of-living-index)

MIT License. © kultranz.com
