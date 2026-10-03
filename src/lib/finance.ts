// Pure finance calculators. Math ported from the compound-interest, net-worth,
// debt-payoff, and budget calculator partials. No external deps.

export interface CompoundResult {
  principal: number;
  monthly: number;
  rate: number;
  years: number;
  final_balance: number;
  total_contributed: number;
  interest_earned: number;
  return_multiple: number;
  series: { year: number; total: number; contributed: number }[];
}

export function compoundInterest(
  principal: number,
  monthly: number,
  rate: number,
  years: number,
): CompoundResult {
  if (years <= 0) throw new Error("years must be > 0");
  const monthlyRate = rate / 100 / 12;
  const series: { year: number; total: number; contributed: number }[] = [];
  let balance = principal;
  let contributed = principal;
  for (let y = 0; y <= years; y++) {
    series.push({ year: y, total: balance, contributed });
    for (let m = 0; m < 12; m++) {
      balance = balance * (1 + monthlyRate) + monthly;
      contributed += monthly;
    }
  }
  const final = series[series.length - 1]!;
  const earned = final.total - final.contributed;
  return {
    principal,
    monthly,
    rate,
    years,
    final_balance: round2(final.total),
    total_contributed: round2(final.contributed),
    interest_earned: round2(earned),
    return_multiple: round2(final.total / Math.max(final.contributed, 1), 2),
    series,
  };
}

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  net_worth: number;
}

export function netWorth(input: {
  cash: number;
  investments: number;
  property: number;
  mortgage: number;
  car: number;
  credit: number;
  otherAssets?: number;
  otherDebt?: number;
}): NetWorthResult {
  const assets = input.cash + input.investments + input.property + (input.otherAssets ?? 0);
  const liabilities = input.mortgage + input.car + input.credit + (input.otherDebt ?? 0);
  return { assets: round2(assets), liabilities: round2(liabilities), net_worth: round2(assets - liabilities) };
}

export interface DebtInput {
  name: string;
  balance: number;
  rate: number;  // APR %
  min: number;   // minimum monthly payment
}

export interface DebtPayoffResult {
  months: number;
  total_interest: number;
  payoff_display: string;
  stalled: boolean;
  schedule: { month: number; balance: number; payment: number; interest: number; principal: number }[];
}

export interface DebtPayoffBothResult {
  avalanche: DebtPayoffResult;
  snowball: DebtPayoffResult;
  avalanche_savings: number;  // interest saved by avalanche vs snowball
}

// Ported from debt-payoff-calculator.html `simulate()`. Budget = sum(min) + extra,
// held constant. Avalanche targets highest APR, snowball lowest balance.
export function debtPayoff(debts: DebtInput[], extra: number, strategy: "avalanche" | "snowball"): DebtPayoffResult {
  const d = debts.map((x) => ({ name: x.name, balance: x.balance, rate: x.rate / 100 / 12, min: x.min }));
  let budget = extra;
  for (const x of d) budget += x.min;

  const totalBalance = () => d.reduce((s, x) => s + Math.max(0, x.balance), 0);
  const target = () => {
    let idx = -1;
    for (let i = 0; i < d.length; i++) {
      if (d[i].balance <= 0.005) continue;
      if (idx === -1) { idx = i; continue; }
      if (strategy === "avalanche") { if (d[i].rate > d[idx].rate) idx = i; }
      else { if (d[i].balance < d[idx].balance) idx = i; }
    }
    return idx;
  };

  let month = 0, totalInterest = 0, stalled = false;
  const schedule: DebtPayoffResult["schedule"] = [];
  while (totalBalance() > 0.01 && month < 600) {
    month++;
    let monthInterest = 0, monthPrincipal = 0;
    for (const x of d) {
      if (x.balance > 0) {
        const interest = x.balance * x.rate;
        x.balance += interest;
        totalInterest += interest;
        monthInterest += interest;
      }
    }
    let available = budget;
    for (const x of d) {
      if (x.balance <= 0) continue;
      const pay = Math.min(x.min, x.balance, available);
      x.balance -= pay; available -= pay; monthPrincipal += pay;
    }
    let guard = 0;
    while (available > 0.005 && totalBalance() > 0.005 && guard++ <= d.length) {
      const t = target();
      if (t === -1) break;
      const pay = Math.min(available, d[t].balance);
      d[t].balance -= pay; available -= pay; monthPrincipal += pay;
    }
    schedule.push({ month, balance: totalBalance(), payment: monthInterest + monthPrincipal, interest: monthInterest, principal: monthPrincipal });
    if (month >= 2) {
      const prev = schedule[month - 1]!;
      const prev2 = schedule[month - 2]!;
      if (prev.balance >= prev2.balance - 0.005) { stalled = true; break; }
    }
  }

  const y = Math.floor(month / 12), m = month % 12;
  const display = stalled ? "50+ yrs" : y === 0 ? `${month} mo` : `${y}y ${m}m`;
  return { months: month, total_interest: round2(totalInterest), payoff_display: display, stalled: stalled || month >= 600, schedule };
}

// Budget calculator. Two modes:
// 1. Simple 50/30/20 split (income only, optional savingsPct override).
// 2. Full custom-category budget matching the website calculator —
//    8 category inputs, computes totals, surplus, % of income, 50/30/20 rule.
export interface BudgetResult {
  income: number;
  needs: number;
  wants: number;
  savings: number;
  savings_pct: number;
}

export interface BudgetCategory {
  name: string;
  amount: number;
  pct_of_income: number;
  rule: "Need" | "Want" | "Savings";
}

export interface BudgetFullResult {
  income: number;
  categories: BudgetCategory[];
  total_expenses: number;
  surplus: number;
  surplus_pct: number;
  needs_pct: number;
  wants_pct: number;
  savings_pct: number;
}

export function budget(income: number, savingsPct?: number): BudgetResult {
  if (income < 0) throw new Error("income must be >= 0");
  const sav = savingsPct ?? 0.20;
  if (sav < 0 || sav > 1) throw new Error("savingsPct must be 0..1");
  const needs = income * 0.50;
  const savings = income * sav;
  const wants = income - needs - savings;
  return { income: round2(income), needs: round2(needs), wants: round2(wants), savings: round2(savings), savings_pct: round2(sav * 100, 1) };
}

export function budgetFull(input: {
  income: number;
  housing: number;
  food: number;
  transport: number;
  utilities: number;
  insurance: number;
  debt: number;
  savings: number;
  other: number;
}): BudgetFullResult {
  const { income } = input;
  if (income <= 0) throw new Error("income must be > 0");
  const needs = input.housing + input.food + input.transport + input.utilities + input.insurance + input.debt;
  const wants = input.other;
  const savings = input.savings;
  const total = needs + wants + savings;
  const surplus = income - total;
  const pct = (v: number) => round2((v / income) * 100, 1);
  const cats: BudgetCategory[] = [
    { name: "Housing", amount: input.housing, pct_of_income: pct(input.housing), rule: "Need" },
    { name: "Food", amount: input.food, pct_of_income: pct(input.food), rule: "Need" },
    { name: "Transport", amount: input.transport, pct_of_income: pct(input.transport), rule: "Need" },
    { name: "Utilities", amount: input.utilities, pct_of_income: pct(input.utilities), rule: "Need" },
    { name: "Insurance", amount: input.insurance, pct_of_income: pct(input.insurance), rule: "Need" },
    { name: "Debt", amount: input.debt, pct_of_income: pct(input.debt), rule: "Need" },
    { name: "Other / Wants", amount: input.other, pct_of_income: pct(input.other), rule: "Want" },
    { name: "Savings", amount: input.savings, pct_of_income: pct(input.savings), rule: "Savings" },
  ];
  return {
    income: round2(income),
    categories: cats,
    total_expenses: round2(total),
    surplus: round2(surplus),
    surplus_pct: pct(surplus),
    needs_pct: pct(needs),
    wants_pct: pct(wants),
    savings_pct: pct(savings),
  };
}

function round2(n: number, places = 2): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}