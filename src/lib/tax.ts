// Take-home tax engine. Ported verbatim from layouts/partials/tools/
// paycheck-calculator.html (JS) which itself mirrors scripts/tax/engine.py.
// Both reference data/tax_2026.json. All amounts annual USD.

export type FilingStatus = "single" | "mfj";
export type StateType = "none" | "flat" | "progressive";

export interface FederalBrackets {
  standard_deduction: Record<FilingStatus, number>;
  brackets: Record<FilingStatus, [number, number][]>;
}
export interface FicaRules {
  social_security: { rate: number; wage_base: number };
  medicare: { rate: number; additional_rate: number; additional_threshold: Record<FilingStatus, number> };
}
export interface StateRules {
  type: StateType;
  rate?: number;
  standard_deduction?: Partial<Record<FilingStatus, number>>;
  brackets?: Record<FilingStatus, [number, number][]>;
}
export interface TaxData {
  _meta?: unknown;
  federal: FederalBrackets;
  fica: FicaRules;
  states: Record<string, StateRules>;
}

export interface TakeHome {
  gross: number;
  pretax: number;
  taxable_income: number;
  federal_tax: number;
  social_security: number;
  medicare: number;
  state_tax: number;
  total_tax: number;
  net: number;
  effective_rate: number;
}

export function walkBrackets(taxable: number, brackets: [number, number][]): number {
  if (taxable <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lower = brackets[i][0];
    const rate = brackets[i][1];
    const upper = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * rate;
    else break;
  }
  return tax;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fica(gross: number, f: FicaRules, status: FilingStatus): [number, number] {
  const ss = Math.min(gross, f.social_security.wage_base) * f.social_security.rate;
  const medBase = gross * f.medicare.rate;
  const addtl = Math.max(0, gross - f.medicare.additional_threshold[status]) * f.medicare.additional_rate;
  return [round2(ss), round2(medBase + addtl)];
}

function stateTax(gross: number, pretax: number, status: FilingStatus, rules: StateRules): number {
  if (rules.type === "none") return 0;
  const ded = rules.standard_deduction?.[status] ?? 0;
  const base = Math.max(0, gross - pretax - ded);
  if (rules.type === "flat") return base * (rules.rate ?? 0);
  const brackets = rules.brackets?.[status] ?? [];
  return walkBrackets(base, brackets);
}

export function computeTakeHome(
  gross: number,
  state: string,
  filingStatus: FilingStatus,
  pretax: number,
  taxData: TaxData,
): TakeHome {
  const fed = taxData.federal;
  const taxable = Math.max(0, gross - pretax - fed.standard_deduction[filingStatus]);
  const federalTax = round2(walkBrackets(taxable, fed.brackets[filingStatus]));
  const [ss, med] = fica(gross, taxData.fica, filingStatus);
  const rules = taxData.states[state];
  if (!rules) throw new Error(`Unknown state code: ${state}`);
  const stateT = round2(stateTax(gross, pretax, filingStatus, rules));
  const total = round2(federalTax + ss + med + stateT);
  const net = round2(gross - total - pretax);
  return {
    gross: round2(gross),
    pretax: round2(pretax),
    taxable_income: round2(taxable),
    federal_tax: federalTax,
    social_security: ss,
    medicare: med,
    state_tax: stateT,
    total_tax: total,
    net,
    effective_rate: gross ? round2((total / gross) * 100) : 0,
  };
}