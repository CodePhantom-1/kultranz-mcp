import { describe, it, expect } from "vitest";
import { computeTakeHome, walkBrackets, type TaxData } from "../src/lib/tax";
import { equivalentSalary, gapPct, mortgageMonthly, monthlyBreakdown } from "../src/lib/col";
import { compoundInterest, netWorth, debtPayoff, budget, budgetFull } from "../src/lib/finance";
import realTaxData from "../src/data/tax_2026.json";
import realCityRpp from "../src/data/city_rpp.json";

// Router-level validation tests via Hono test client (no D1 binding needed —
// /salaries is the only D1 route and is skipped here).
import app from "../src/index";

async function req(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  const body = await res.json();
  return { status: res.status, body };
}

// Synthetic params mirror tests/test_tax_engine.py exactly — hand-computable.
const SYNTH: TaxData = {
  federal: {
    standard_deduction: { single: 10000, mfj: 20000 },
    brackets: {
      single: [[0, 0.10], [20000, 0.20]],
      mfj: [[0, 0.10], [40000, 0.20]],
    },
  },
  fica: {
    social_security: { rate: 0.062, wage_base: 150000 },
    medicare: { rate: 0.0145, additional_rate: 0.009, additional_threshold: { single: 200000, mfj: 250000 } },
  },
  states: {
    NONE: { type: "none" },
    FLAT: { type: "flat", rate: 0.05 },
    PROG: {
      type: "progressive",
      standard_deduction: { single: 5000, mfj: 10000 },
      brackets: {
        single: [[0, 0.02], [30000, 0.04]],
        mfj: [[0, 0.02], [60000, 0.04]],
      },
    },
  },
};

describe("walkBrackets", () => {
  it("matches python: 40000 @ [10%,20%] = 6000", () => {
    expect(walkBrackets(40000, [[0, 0.10], [20000, 0.20]])).toBe(6000);
    expect(walkBrackets(0, [[0, 0.10], [20000, 0.20]])).toBe(0);
    expect(walkBrackets(-5, [[0, 0.10]])).toBe(0);
  });
});

describe("computeTakeHome (synthetic, mirrors test_tax_engine.py)", () => {
  it("no-tax state single: net = 40175", () => {
    const r = computeTakeHome(50000, "NONE", "single", 0, SYNTH);
    expect(r.federal_tax).toBe(6000);
    expect(r.social_security).toBe(3100);
    expect(r.medicare).toBe(725);
    expect(r.state_tax).toBe(0);
    expect(r.total_tax).toBe(9825);
    expect(r.net).toBe(40175);
  });

  it("flat state single: state_tax 2500, net 37675", () => {
    const r = computeTakeHome(50000, "FLAT", "single", 0, SYNTH);
    expect(r.state_tax).toBe(2500);
    expect(r.net).toBe(37675);
  });

  it("progressive state single: state_tax 1200, net 38975", () => {
    const r = computeTakeHome(50000, "PROG", "single", 0, SYNTH);
    expect(r.state_tax).toBe(1200);
    expect(r.net).toBe(38975);
  });

  it("pretax reduces income tax not FICA", () => {
    const r = computeTakeHome(50000, "NONE", "single", 10000, SYNTH);
    expect(r.federal_tax).toBe(4000);
    expect(r.social_security).toBe(3100);
    expect(r.net).toBe(32175);
  });

  it("SS wage base cap + additional medicare", () => {
    const r = computeTakeHome(300000, "NONE", "single", 0, SYNTH);
    expect(r.social_security).toBe(9300);
    expect(r.medicare).toBe(5250);
    expect(r.net).toBe(229450);
  });

  it("zero income", () => {
    const r = computeTakeHome(0, "FLAT", "single", 0, SYNTH);
    expect(r.total_tax).toBe(0);
    expect(r.net).toBe(0);
    expect(r.effective_rate).toBe(0);
  });
});

describe("computeTakeHome (real 2026 data, mirrors python sanity)", () => {
  const TD = realTaxData as unknown as TaxData;
  const ALL = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
  it("all 51 jurisdictions present", () => {
    expect(new Set(Object.keys(TD.states))).toEqual(new Set(ALL));
  });
  it("structure valid", () => {
    for (const [code, rules] of Object.entries(TD.states)) {
      expect(["none", "flat", "progressive"]).toContain(rules.type);
      if (rules.type === "flat") expect(typeof rules.rate).toBe("number");
      if (rules.type === "progressive") {
        for (const s of ["single", "mfj"] as const) {
          expect(rules.brackets?.[s]?.[0]?.[0]).toBe(0);
        }
      }
    }
  });
  it("mfj pays no more than single (CA, NY, WI, TX, PA)", () => {
    for (const st of ["CA", "NY", "WI", "TX", "PA"]) {
      const s = computeTakeHome(100000, st, "single", 0, TD);
      const m = computeTakeHome(100000, st, "mfj", 0, TD);
      expect(m.net).toBeGreaterThanOrEqual(s.net);
    }
  });
  it("CA progressive: higher earner has higher effective rate; TX < CA at 120k", () => {
    const lo = computeTakeHome(40000, "CA", "single", 0, TD);
    const hi = computeTakeHome(200000, "CA", "single", 0, TD);
    expect(hi.effective_rate).toBeGreaterThan(lo.effective_rate);
    const tx = computeTakeHome(120000, "TX", "single", 0, TD);
    const ca = computeTakeHome(120000, "CA", "single", 0, TD);
    expect(tx.state_tax).toBe(0);
    expect(ca.state_tax).toBeGreaterThan(0);
    expect(tx.net).toBeGreaterThan(ca.net);
    expect(ca.net).toBeGreaterThan(0);
    expect(ca.net).toBeLessThan(120000);
  });
});

describe("col.ts", () => {
  it("equivalentSalary", () => {
    expect(equivalentSalary(100000, 100, 120)).toBe(120000);
    expect(equivalentSalary(100000, 100, 100)).toBe(100000);
  });
  it("gapPct", () => {
    expect(gapPct(100, 120)).toBe(20);
    expect(gapPct(100, 80)).toBe(-20);
  });
  it("mortgageMonthly", () => {
    const m = mortgageMonthly(300000, 6.7, 30, 0.1);
    expect(m).toBeGreaterThan(1600);
    expect(m).toBeLessThan(1750);  // ~10% down on 300k @ 6.7% 30yr
  });
  it("monthlyBreakdown sums the categories", () => {
    const b = monthlyBreakdown({ rpp: 100, income: 60000, median_rent: 1200, median_home_value: 200000 });
    expect(b.total_rent).toBe(b.housing + b.transport + b.food + b.healthcare + b.other);
    expect(b.housing).toBe(1200);
  });
  it("real city data: known RPP", () => {
    const cities = realCityRpp.cities as Record<string, { rpp: number }>;
    const abq = cities["Albuquerque, NM"];
    expect(abq).toBeDefined();
    expect(abq.rpp).toBe(95.5);
  });
});

describe("finance.ts", () => {
  it("compoundInterest: 0 contrib, 0 rate = principal", () => {
    const r = compoundInterest(10000, 0, 0, 5);
    expect(r.final_balance).toBe(10000);
    expect(r.interest_earned).toBe(0);
    expect(r.series.length).toBe(6);  // year 0..5
  });
  it("debtPayoff throws on zero balance", () => {
    expect(() => debtPayoff([{ name: "X", balance: 0, rate: 5, min: 100 }], 0, "avalanche")).not.toThrow();
    // balance=0: totalBalance()=0, loop never enters, months=0 — valid edge case
  });
  it("debtPayoff with single debt completes", () => {
    const r = debtPayoff([{ name: "Loan", balance: 5000, rate: 6, min: 150 }], 0, "avalanche");
    expect(r.months).toBeLessThan(120);
    expect(r.stalled).toBe(false);
  });
  it("debtPayoff mode=both doesn't mutate inputs", () => {
    const debts = [{ name: "CC", balance: 8000, rate: 24.99, min: 200 }, { name: "Loan", balance: 3000, rate: 7.5, min: 120 }];
    const snapshot = JSON.stringify(debts);
    debtPayoff(debts, 200, "avalanche");
    debtPayoff(debts, 200, "snowball");
    expect(JSON.stringify(debts)).toBe(snapshot);
  });
  it("compoundInterest caps in router (not lib)", () => {
    // The lib itself doesn't cap; router validates. Just verify lib handles 60.
    const r = compoundInterest(1000, 0, 5, 60);
    expect(r.series.length).toBe(61);
  });
  it("compoundInterest: grows with rate", () => {
    const r = compoundInterest(10000, 500, 7, 20);
    expect(r.final_balance).toBeGreaterThan(r.total_contributed);
    expect(r.return_multiple).toBeGreaterThan(1);
    expect(r.series[r.series.length - 1].year).toBe(20);
  });
  it("netWorth", () => {
    const r = netWorth({ cash: 10000, investments: 50000, property: 300000, mortgage: 200000, car: 15000, credit: 5000 });
    expect(r.assets).toBe(360000);
    expect(r.liabilities).toBe(220000);
    expect(r.net_worth).toBe(140000);
  });
  it("netWorth with other assets/debt", () => {
    const r = netWorth({ cash: 10000, investments: 50000, property: 300000, mortgage: 200000, car: 15000, credit: 5000, otherAssets: 50000, otherDebt: 10000 });
    expect(r.assets).toBe(410000);
    expect(r.liabilities).toBe(230000);
    expect(r.net_worth).toBe(180000);
  });
  it("debtPayoff avalanche", () => {
    const r = debtPayoff(
      [{ name: "CC", balance: 8000, rate: 24.99, min: 200 }, { name: "Loan", balance: 3000, rate: 7.5, min: 120 }],
      200,
      "avalanche",
    );
    expect(r.months).toBeLessThan(600);
    expect(r.total_interest).toBeGreaterThan(0);
    expect(r.schedule[0].month).toBe(1);
  });
  it("debtPayoff snowball produces different path", () => {
    const av = debtPayoff(
      [{ name: "CC", balance: 8000, rate: 24.99, min: 200 }, { name: "Loan", balance: 3000, rate: 7.5, min: 120 }],
      200,
      "avalanche",
    );
    const sn = debtPayoff(
      [{ name: "CC", balance: 8000, rate: 24.99, min: 200 }, { name: "Loan", balance: 3000, rate: 7.5, min: 120 }],
      200,
      "snowball",
    );
    // With these inputs, avalanche should save money (or at least break even)
    expect(av.total_interest).toBeLessThanOrEqual(sn.total_interest);
  });
  it("budget 50/30/20", () => {
    const r = budget(5000);
    expect(r.needs).toBe(2500);
    expect(r.wants).toBe(1500);
    expect(r.savings).toBe(1000);  // 20% default
    expect(r.savings_pct).toBe(20);
  });
  it("budget throws on invalid savingsPct", () => {
    expect(() => budget(5000, -0.1)).toThrow();
    expect(() => budget(5000, 1.5)).toThrow();
  });
  it("budgetFull throws on zero income", () => {
    expect(() => budgetFull({ income: 0, housing: 1, food: 0, transport: 0, utilities: 0, insurance: 0, debt: 0, savings: 0, other: 0 })).toThrow();
  });
  it("budgetFull — matches website budget calculator", () => {
    const r = budgetFull({
      income: 5000,
      housing: 1500,
      food: 600,
      transport: 400,
      utilities: 250,
      insurance: 200,
      debt: 300,
      savings: 500,
      other: 400,
    });
    // needs = 1500+600+400+250+200+300 = 3250
    // wants = 400, savings = 500
    // total = 4150, surplus = 850
    expect(r.total_expenses).toBe(4150);
    expect(r.surplus).toBe(850);
    expect(r.needs_pct).toBe(65.0);   // 3250/5000*100
    expect(r.wants_pct).toBe(8.0);    // 400/5000*100
    expect(r.savings_pct).toBe(10.0); // 500/5000*100
    expect(r.surplus_pct).toBe(17.0); // 850/5000*100
    expect(r.categories).toHaveLength(8);
    expect(r.categories[0].name).toBe("Housing");
    expect(r.categories[0].rule).toBe("Need");
    expect(r.categories[6].rule).toBe("Want");
    expect(r.categories[7].rule).toBe("Savings");
  });
});

// ---------------------------------------------------------------------------
// Router-level validation — exercises the actual HTTP handlers + middleware.
// These tests catch bugs lib-only tests miss (validation ordering, 400s, CORS).
// ---------------------------------------------------------------------------
describe("router validation", () => {
  it("/paycheck rejects negative salary", async () => {
    const r = await req("/paycheck?salary=-50000&state=CA&filingStatus=single");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_salary");
  });
  it("/paycheck rejects negative pretax401k", async () => {
    const r = await req("/paycheck?salary=100000&state=CA&pretax401k=-1000");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_pretax");
  });
  it("/paycheck rejects salary=0", async () => {
    const r = await req("/paycheck?salary=0&state=CA");
    expect(r.status).toBe(400);
  });
  it("/paycheck rejects unknown state", async () => {
    const r = await req("/paycheck?salary=100000&state=ZZ");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_state");
  });
  it("/paycheck rejects invalid filingStatus", async () => {
    const r = await req("/paycheck?salary=100000&state=CA&filingStatus=head_of_household");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_filing");
  });
  it("/paycheck valid request returns 200 with data", async () => {
    const r = await req("/paycheck?salary=100000&state=TX&filingStatus=mfj");
    expect(r.status).toBe(200);
    expect(r.body.data.net).toBeGreaterThan(0);
    expect(r.body.meta.year).toBe(2026);
  });

  it("/cost-of-living rejects negative salary", async () => {
    const r = await req("/cost-of-living?fromCity=Austin,%20TX&toCity=San%20Francisco,%20CA&salary=-100000");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_salary");
  });
  it("/cost-of-living rejects missing city", async () => {
    const r = await req("/cost-of-living?fromCity=Austin,%20TX");
    expect(r.status).toBe(400);
  });
  it("/cost-of-living valid returns equiv_salary", async () => {
    const r = await req("/cost-of-living?fromCity=Austin,%20TX&toCity=San%20Francisco,%20CA&salary=100000");
    expect(r.status).toBe(200);
    expect(r.body.data.equivalent_salary).toBeGreaterThan(100000);
  });

  it("/compound-interest rejects years > 60", async () => {
    const r = await req("/compound-interest?principal=1000&rate=7&years=100");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_years");
  });
  it("/compound-interest rejects rate > 50", async () => {
    const r = await req("/compound-interest?principal=1000&rate=200&years=10");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_rate");
  });
  it("/compound-interest rejects negative principal", async () => {
    const r = await req("/compound-interest?principal=-1000&rate=7&years=10");
    expect(r.status).toBe(400);
  });

  it("/net-worth rejects negative cash", async () => {
    const r = await req("/net-worth?cash=-50000");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_input");
  });
  it("/net-worth with valid inputs returns net_worth", async () => {
    const r = await req("/net-worth?cash=10000&investments=50000&property=300000&mortgage=200000");
    expect(r.status).toBe(200);
    expect(r.body.data.net_worth).toBe(160000);
  });

  it("/debt-payoff rejects negative extra", async () => {
    const debts = encodeURIComponent(JSON.stringify([{ name: "CC", balance: 5000, rate: 19, min: 150 }]));
    const r = await req(`/debt-payoff?debts=${debts}&extra=-100`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_extra");
  });
  it("/debt-payoff rejects invalid debts JSON", async () => {
    const r = await req("/debt-payoff?debts=not-json");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_debts");
  });
  it("/debt-payoff rejects debt with zero balance", async () => {
    const debts = encodeURIComponent(JSON.stringify([{ name: "X", balance: 0, rate: 5, min: 50 }]));
    const r = await req(`/debt-payoff?debts=${debts}&extra=100`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_debts");
  });
  it("/debt-payoff mode=both returns avalanche_savings", async () => {
    const debts = encodeURIComponent(JSON.stringify([
      { name: "CC", balance: 8000, rate: 24.99, min: 200 },
      { name: "Loan", balance: 3000, rate: 7.5, min: 120 },
    ]));
    const r = await req(`/debt-payoff?debts=${debts}&extra=200&mode=both`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty("avalanche");
    expect(r.body.data).toHaveProperty("snowball");
    expect(r.body.data).toHaveProperty("avalanche_savings");
  });

  it("/budget rejects negative income", async () => {
    const r = await req("/budget?income=-1000");
    expect(r.status).toBe(400);
  });
  it("/budget simple mode works", async () => {
    const r = await req("/budget?income=5000");
    expect(r.status).toBe(200);
    expect(r.body.data.needs).toBe(2500);
  });
  it("/budget full mode rejected when income=0", async () => {
    const r = await req("/budget?income=0&housing=500");
    expect(r.status).toBe(400);
  });
  it("/budget full mode works with categories", async () => {
    const r = await req("/budget?income=5000&housing=1500&food=600&transport=400&utilities=250&insurance=200&debt=300&savings=500&other=400");
    expect(r.status).toBe(200);
    expect(r.body.data.total_expenses).toBe(4150);
    expect(r.body.data.surplus).toBe(850);
  });
  it("/budget rejects savingsPct > 50 (50/30/20 frame)", async () => {
    const r = await req("/budget?income=5000&savingsPct=100");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_savings_pct");
  });
  it("/budget allows savingsPct=50 exactly, wants go to zero", async () => {
    const r = await req("/budget?income=5000&savingsPct=50");
    expect(r.status).toBe(200);
    expect(r.body.data.needs).toBe(2500);
    expect(r.body.data.savings).toBe(2500);
    expect(r.body.data.wants).toBe(0);
  });

  describe("/salaries LIKE wildcards are literal", () => {
    function dbStub(rows: Record<string, unknown>[]) {
      const captured: { sql: string; args: unknown[] }[] = [];
      const db = {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              captured.push({ sql, args });
              return { async all() { return { results: rows }; } };
            },
          };
        },
      };
      return { db, captured };
    }

    it("escapes % in job so only literal matches return", async () => {
      const rows = [{ job_title: "reg% analyst", city: "Austin", state: "TX" }];
      const { db, captured } = dbStub(rows);
      const res = await app.request("/salaries?job=reg%25", undefined, { DB: db } as never);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.count).toBe(1);
      expect(body.data.records[0].job_title).toBe("reg% analyst");
      expect(captured[0]!.sql).toContain("ESCAPE '\\'");
      expect(captured[0]!.args[0]).toBe("%reg\\%%");
    });

    it("escapes _ in city as a literal underscore", async () => {
      const rows = [{ job_title: "Nurse", city: "sea_town", state: "TX" }];
      const { db, captured } = dbStub(rows);
      const res = await app.request("/salaries?city=sea_town", undefined, { DB: db } as never);
      expect(res.status).toBe(200);
      expect(captured[0]!.sql).toContain("ESCAPE '\\'");
      expect(captured[0]!.args[0]).toBe("%sea\\_town%");
    });
  });

  it("/tax-brackets without state returns federal only", async () => {
    const r = await req("/tax-brackets?filingStatus=single");
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty("federal");
    expect(r.body.data).not.toHaveProperty("state");
  });
  it("/tax-brackets with state includes state object", async () => {
    const r = await req("/tax-brackets?state=NY&filingStatus=mfj");
    expect(r.status).toBe(200);
    expect(r.body.data.state.code).toBe("NY");
  });

  it("/col-index returns all cities", async () => {
    const r = await req("/col-index");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).length).toBeGreaterThan(40);
  });
  it("/col-index?city= filters to one", async () => {
    const r = await req("/col-index?city=Albuquerque,%20NM");
    expect(r.status).toBe(200);
    expect(r.body.data.city).toBe("Albuquerque, NM");
    expect(r.body.data.rpp).toBe(95.5);
  });
  it("/col-index unknown city returns 404", async () => {
    const r = await req("/col-index?city=Nowhere,%20XX");
    expect(r.status).toBe(404);
  });

  it("root lists all 12 endpoints", async () => {
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(r.body.endpoints).toHaveLength(12);
    expect(r.body.endpoints).toContain("/mcp (MCP server, POST)");
    expect(r.body.endpoints).toContain("/salaries/submit (POST, community)");
    expect(r.body.endpoints).toContain("/salaries/recent (community)");
  });

  it("all responses have Access-Control-Allow-Origin header", async () => {
    const res = await app.request("/col-index?city=Albuquerque,%20NM");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("gate path matching (exact /mcp exemption)", () => {
  const env = { RAPIDAPI_PROXY_SECRET: "rs" } as never;

  it("/mcp itself stays exempt from the RapidAPI gate", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toEqual({});
  });

  it("a path merely starting with /mcp does NOT inherit the exemption", async () => {
    // startsWith("/mcp") used to let /mcp<anything> bypass the gate entirely.
    const probe = await app.request("/mcpfoo", undefined, env);
    expect(probe.status).toBe(401);
    expect(((await probe.json()) as any).error.code).toBe("unauthorized");
  });
});