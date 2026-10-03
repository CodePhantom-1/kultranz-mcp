// Cost-of-living math. Ported from scripts/programmatic/comparison_generator.py
// (equivalent_salary, gap_pct, mortgage, monthly_breakdown) and the COL
// calculator partial's ratio. RPP = BEA Regional Price Parity, US=100.

export interface CityRpp {
  rpp: number;
  rpp_rents: number | null;
  median_rent: number | null;
  median_home_value: number | null;
  median_income: number | null;
}
export type CityRppMap = Record<string, CityRpp>;

// BLS Consumer Expenditure Survey national shares (baseline).
const NATIONAL_SHARES = {
  housing: 0.338,
  transport: 0.164,
  food: 0.129,
  healthcare: 0.081,
  other: 0.288,
} as const;

export function equivalentSalary(amount: number, rppFrom: number, rppTo: number): number {
  return round2(amount * rppTo / rppFrom);
}

export function gapPct(rppFrom: number, rppTo: number): number {
  return round2((rppTo - rppFrom) / rppFrom * 100);
}

export function mortgageMonthly(
  homeValue: number,
  rateAnnual = 6.7,
  years = 30,
  downPct = 0.10,
): number {
  if (!homeValue) return 0;
  const loan = homeValue * (1 - downPct);
  const r = rateAnnual / 100 / 12;
  const n = years * 12;
  if (r === 0) return loan / n;
  return loan * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

export interface MonthlyBreakdown {
  housing: number;
  transport: number;
  food: number;
  healthcare: number;
  other: number;
  total_rent: number;
  mortgage: number;
  total_own: number;
}

export function monthlyBreakdown(
  city: { rpp?: number; income?: number | null; median_rent?: number | null; median_home_value?: number | null },
): MonthlyBreakdown {
  const rpp = city.rpp ?? 100;
  const income = city.income ?? 65000;
  const rent = city.median_rent ?? 0;
  const home = city.median_home_value ?? 0;
  const housing = rent || mortgageMonthly(home);
  const scale = rpp / 100;
  const transport = Math.max((income * NATIONAL_SHARES.transport * scale) / 12, 400);
  const food = Math.max((income * NATIONAL_SHARES.food * scale) / 12, 300);
  const healthcare = Math.max((income * NATIONAL_SHARES.healthcare * scale) / 12, 250);
  const other = Math.max((income * NATIONAL_SHARES.other * scale) / 12, 600);
  const mort = mortgageMonthly(home);
  return {
    housing: Math.round(housing),
    transport: Math.round(transport),
    food: Math.round(food),
    healthcare: Math.round(healthcare),
    other: Math.round(other),
    total_rent: Math.round(housing + transport + food + healthcare + other),
    mortgage: Math.round(mort),
    total_own: Math.round(mort + transport + food + healthcare + other),
  };
}

export function rentToIncome(rent: number, income: number): number {
  if (!rent || !income) return 0;
  return round2((rent * 12) / income * 100);
}

export function homePriceToIncome(home: number, income: number): number {
  if (!home || !income) return 0;
  return round2(home / income, 1);
}

function round2(n: number, places = 2): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

export interface ColComparison {
  from: { city: string; rpp: number };
  to: { city: string; rpp: number };
  equivalent_salary: number;
  gap_pct: number;
  from_breakdown?: MonthlyBreakdown;
  to_breakdown?: MonthlyBreakdown;
}

export function compareCities(
  fromKey: string,
  toKey: string,
  salary: number,
  cities: CityRppMap,
  rich = false,
): ColComparison | null {
  const a = cities[fromKey];
  const b = cities[toKey];
  if (!a || !b) return null;
  const equiv = equivalentSalary(salary, a.rpp, b.rpp);
  const gap = gapPct(a.rpp, b.rpp);
  const out: ColComparison = {
    from: { city: fromKey, rpp: a.rpp },
    to: { city: toKey, rpp: b.rpp },
    equivalent_salary: equiv,
    gap_pct: gap,
  };
  if (rich) {
    out.from_breakdown = monthlyBreakdown({ ...a, income: a.median_income });
    out.to_breakdown = monthlyBreakdown({ ...b, income: b.median_income });
  }
  return out;
}