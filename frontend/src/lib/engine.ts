/**
 * Retirement projection engine — a faithful TypeScript port of the original
 * Python engine (backend/app/services/projections.py) so the whole app can run
 * in the browser with no server.
 *
 *   * Mid-year contribution compounding (contributions earn ~half a year)
 *   * Nominal vs. real (today's-dollars) output toggle
 *   * Social Security claim-age scenarios
 *   * Required Minimum Distributions (RMDs) from age 73 (SECURE 2.0)
 *   * Multi-bucket, spending-driven drawdown with per-type taxation
 *   * Monte Carlo success probability (random annual returns)
 */

export type Assumptions = Record<string, number>;

export interface EventRow { age: number; amount: number; label?: string }
export interface BracketRow { threshold: number; rate: number }
export interface AssetRow {
  name?: string; value: number; growth_rate: number; contribution_annual: number;
  tax_type: string; cost_basis: number; is_market: number;
}
export interface LoanInput {
  name?: string; balance: number; annual_rate: number; months_remaining: number;
  extra_payment_monthly: number; lump_sum_payoff_age: number; start_age?: number;
}

interface Bucket {
  name: string; value: number; rate: number; tax: string; basis: number;
  is_market: boolean; auto?: boolean;
}

// IRS Uniform Lifetime Table distribution periods (age -> divisor).
const RMD_TABLE: Record<number, number> = {
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1,
  80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2,
  87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1,
  94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4,
};

// Neutral starting values only — every one is editable in the app; the user's
// own figures live in the local database, not here.
export const DEFAULT_ASSUMPTIONS: Assumptions = {
  current_age: 35,
  retirement_age: 65,
  life_expectancy: 90,
  ss_claim_age: 67,
  ss_annual_benefit: 30000,
  current_salary: 75000,
  starting_balance: 0, // manual current 401(k) balance when no CSV is imported
  salary_growth: 0.02,
  employee_contrib_pct: 0.1,
  employer_match_pct: 0.5,
  match_cap_pct: 0.06,
  employer_profit_sharing_pct: 0.0,
  nominal_return: 0.08,
  inflation: 0.03,
  return_volatility: 0.15,
  tax_rate_401k: 0.15,
  tax_rate_ss: 0.0,
  annual_spending: 50000,
  bridge_withdrawal: 60000,
  post_ss_withdrawal: 60000,
  apply_rmd: 1,
  index_to_inflation: 1,
  retirement_goal_today: 0,

  // Contribution limits (editable: caps vary by jurisdiction and plan)
  limit_employee_deferral: 23500,
  limit_catchup: 7500,
  catchup_age: 50,
  limit_total_415c: 70000,
  index_limits: 1,

  // Contribution escalation
  contrib_escalation: 0.0,
  contrib_escalation_cap: 0.0,

  // Coast / barista FIRE: from `coast_age` onward, contribute `coast_contrib_pct`
  // of salary instead of the normal (escalating) rate. 0% = stop entirely.
  // `coast_age` of 0 disables coasting (contribute normally to retirement).
  coast_age: 0,
  coast_contrib_pct: 0.0,

  // Roth
  roth_share: 0.0,

  // Other assets & income outside this 401(k)
  other_assets_today: 0,
  other_income_annual: 0,
  other_income_start_age: 0,
  tax_rate_other_income: 0.0,

  // Healthcare (on top of annual_spending, today's $)
  healthcare_pre65: 0,
  healthcare_post65: 0,
  medicare_age: 65,

  // Progressive tax (used only when a bracket table exists)
  standard_deduction: 0,

  // Tax-free retirement-income exclusion (e.g. Puerto Rico's pension exemption).
  // The exempt amount is subtracted from ordinary retirement-plan withdrawals
  // before tax; it steps up at `retirement_exclusion_age`. Today's dollars.
  retirement_exclusion: 0,          // annual exempt amount before the step age
  retirement_exclusion_senior: 0,   // annual exempt amount at/after the step age
  retirement_exclusion_age: 60,     // age the higher exemption begins

  // Withdrawal buckets (Assets & Debts tab)
  cap_gains_rate: 0.15,
  cash_savings_rate: 0.02,
  order_cash: 1,
  order_taxable: 2,
  order_deferred: 3,
  order_roth: 4,
};

// ---- helpers -------------------------------------------------------------- //

const EPS = 1e-9;
function round(v: number, n = 2): number {
  const f = 10 ** n;
  return Math.round((v + Number.EPSILON) * f) / f;
}
const num = (a: Assumptions, k: string, d = 0): number => (a[k] ?? d);

export function merged(assumptions: Assumptions | null | undefined): Assumptions {
  const a: Assumptions = { ...DEFAULT_ASSUMPTIONS };
  if (assumptions) {
    for (const [k, v] of Object.entries(assumptions)) {
      if (v !== null && v !== undefined && !Number.isNaN(v)) a[k] = Number(v);
    }
  }
  return a;
}

function limitsForYear(a: Assumptions, year: number, baseYear: number): [number, number, number] {
  const f = num(a, "index_limits", 1) ? (1 + a.inflation) ** (year - baseYear) : 1.0;
  return [num(a, "limit_employee_deferral") * f, num(a, "limit_catchup") * f, num(a, "limit_total_415c") * f];
}

function contributions(
  a: Assumptions, salary: number, age: number, empPct: number, year: number, baseYear: number,
): [number, number] {
  const [deferralCap, catchup, totalCap] = limitsForYear(a, year, baseYear);
  let employee = salary * empPct;
  if (deferralCap > 0) {
    const cap = deferralCap + (age >= num(a, "catchup_age", 50) ? catchup : 0.0);
    employee = Math.min(employee, cap);
  }
  const matchedBase = Math.min(empPct, a.match_cap_pct) * salary;
  let employer = matchedBase * a.employer_match_pct + salary * a.employer_profit_sharing_pct;
  if (totalCap > 0 && employee + employer > totalCap) {
    employer = Math.max(totalCap - employee, 0.0);
  }
  return [employee, employer];
}

function escalate(a: Assumptions, empPct: number): number {
  const step = num(a, "contrib_escalation", 0.0);
  if (step <= 0) return empPct;
  const cap = num(a, "contrib_escalation_cap", 0.0);
  const nxt = empPct + step;
  return cap > 0 ? Math.min(nxt, cap) : nxt;
}

/** Employee contribution % actually used at `age`, honoring a coast plan: once
 * `coast_age` is reached, contributions switch to `coast_contrib_pct`
 * (0 = stop entirely). `basePct` is the normally-escalating percentage. */
function effContribPct(a: Assumptions, age: number, basePct: number): number {
  const coastAge = Math.trunc(num(a, "coast_age", 0));
  if (coastAge > 0 && age >= coastAge) return Math.max(num(a, "coast_contrib_pct", 0.0), 0.0);
  return basePct;
}

function eventsByAge(events: EventRow[] | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const e of events || []) {
    const age = Math.trunc(e.age);
    out[age] = (out[age] || 0) + Number(e.amount);
  }
  return out;
}

function eventAmount(byAge: Record<number, number>, age: number, a: Assumptions, year: number, baseYear: number): number {
  const amt = byAge[age] || 0.0;
  if (!amt) return 0.0;
  return num(a, "index_to_inflation", 1) ? amt * (1 + a.inflation) ** (year - baseYear) : amt;
}

function progressiveTax(income: number, brackets: BracketRow[] | undefined, factor = 1.0): number {
  if (income <= 0 || !brackets || brackets.length === 0) return 0.0;
  const rows = [...brackets].sort((x, y) => x.threshold - y.threshold);
  let tax = 0.0;
  for (let i = 0; i < rows.length; i++) {
    const lo = rows[i].threshold * factor;
    const hi = i + 1 < rows.length ? rows[i + 1].threshold * factor : Infinity;
    if (income > lo) tax += (Math.min(income, hi) - lo) * rows[i].rate;
  }
  return tax;
}

function rmdDivisor(age: number): number {
  if (age < 73) return 0.0;
  return RMD_TABLE[age] ?? RMD_TABLE[100];
}

/** Tax-free retirement-income exclusion for a given age (today's dollars). */
function retirementExclusion(a: Assumptions, age: number): number {
  const stepAge = num(a, "retirement_exclusion_age", 60);
  return age >= stepAge ? num(a, "retirement_exclusion_senior", 0) : num(a, "retirement_exclusion", 0);
}

// ---- accumulation --------------------------------------------------------- //

export interface AccumRow {
  year: number; age: number; salary: number; start_balance: number;
  employee_contribution: number; employer_contribution: number; total_contribution: number;
  contribution_capped: boolean; growth: number; life_event: number; end_balance: number;
}

export function runAccumulation(
  a: Assumptions, startBalance: number, startYear: number, events?: EventRow[],
): AccumRow[] {
  const rows: AccumRow[] = [];
  let balance = startBalance;
  let salary = a.current_salary;
  const r = a.nominal_return;
  let age = Math.trunc(a.current_age);
  const retAge = Math.trunc(a.retirement_age);
  let year = startYear;
  let empPct = a.employee_contrib_pct;
  const byAge = eventsByAge(events);
  while (age < retAge) {
    const effPct = effContribPct(a, age, empPct);
    const uncapped = salary * effPct;
    const [employee, employer] = contributions(a, salary, age, effPct, year, startYear);
    const contrib = employee + employer;
    // Enhancement: balance grows a full year, contributions ~half a year.
    const growth = balance * r + contrib * (Math.sqrt(1 + r) - 1);
    const event = eventAmount(byAge, age, a, year, startYear);
    const end = Math.max(balance + contrib + growth + event, 0.0);
    rows.push({
      year, age, salary: round(salary), start_balance: round(balance),
      employee_contribution: round(employee), employer_contribution: round(employer),
      total_contribution: round(contrib), contribution_capped: uncapped - employee > 0.01,
      growth: round(growth), life_event: round(event), end_balance: round(end),
    });
    balance = end;
    salary *= 1 + a.salary_growth;
    empPct = escalate(a, empPct);
    age += 1;
    year += 1;
  }
  return rows;
}

// ---- other assets & buckets ---------------------------------------------- //

function growAsset(asset: AssetRow, a: Assumptions, startYear: number, retYear: number): [number, number] {
  let bal = Number(asset.value || 0.0);
  let basis = Number(asset.cost_basis || 0.0) || bal; // unknown basis -> assume all basis
  const rate = Number(asset.growth_rate || 0.0);
  const contrib0 = Number(asset.contribution_annual || 0.0);
  const index = !!num(a, "index_to_inflation", 1);
  for (let y = startYear; y < retYear; y++) {
    const c = contrib0 * (index ? (1 + a.inflation) ** (y - startYear) : 1.0);
    bal += c + bal * rate + c * (Math.sqrt(1 + rate) - 1);
    basis += c;
  }
  return [bal, Math.min(basis, bal)];
}

function buildBuckets(
  a: Assumptions, portAtRet: number, assets: AssetRow[] | undefined, startYear: number, retYear: number,
): Bucket[] {
  const roth = Math.min(Math.max(num(a, "roth_share", 0.0), 0.0), 1.0);
  const buckets: Bucket[] = [{
    name: "401(k)", value: portAtRet * (1 - roth), rate: a.nominal_return,
    tax: "deferred", basis: 0.0, is_market: true,
  }];
  if (roth > 0) {
    buckets.push({
      name: "401(k) Roth", value: portAtRet * roth, rate: a.nominal_return,
      tax: "roth", basis: 0.0, is_market: true,
    });
  }
  for (const asset of assets || []) {
    const [val, basis] = growAsset(asset, a, startYear, retYear);
    buckets.push({
      name: asset.name || asset.tax_type || "asset",
      value: val, rate: Number(asset.growth_rate || 0.0),
      tax: asset.tax_type || "taxable", basis, is_market: !!(asset.is_market ?? 1),
    });
  }
  return buckets;
}

function assetsAtRetirement(a: Assumptions, assets: AssetRow[] | undefined, startYear: number, retYear: number): number {
  return (assets || []).reduce((s, x) => s + growAsset(x, a, startYear, retYear)[0], 0.0);
}

function withdrawalOrder(a: Assumptions, buckets: Bucket[]): number[] {
  const types = ["cash", "taxable", "deferred", "roth"];
  const rank: Record<string, number> = {};
  types.forEach((t, i) => (rank[t] = num(a, `order_${t}`, i + 1)));
  return buckets.map((_, i) => i).sort((i, j) => {
    const ri = rank[buckets[i].tax] ?? 9, rj = rank[buckets[j].tax] ?? 9;
    return ri !== rj ? ri - rj : i - j;
  });
}

interface LoanSchedule {
  payment_by_age: Record<number, number>;
  lump_by_age: Record<number, number>;
  payoffs: { name: string; payoff_age: number | null }[];
}

function loanSchedules(loans: LoanInput[] | undefined, a: Assumptions): LoanSchedule {
  const curAge = Math.trunc(a.current_age);
  const paymentByAge: Record<number, number> = {};
  const lumpByAge: Record<number, number> = {};
  const payoffs: { name: string; payoff_age: number | null }[] = [];
  for (const loan of loans || []) {
    let bal = Number(loan.balance || 0.0);
    if (bal <= 0) continue;
    const mr = Number(loan.annual_rate || 0.0) / 12.0;
    const n = Math.trunc(loan.months_remaining || 0);
    let pmt: number;
    if (mr > 0 && n > 0) pmt = (bal * mr) / (1 - (1 + mr) ** -n);
    else if (n > 0) pmt = bal / n;
    else pmt = 0.0;
    pmt += Number(loan.extra_payment_monthly || 0.0);
    const lumpAge = Math.trunc(loan.lump_sum_payoff_age || 0) || 0;
    // A future loan (start age beyond today) doesn't begin amortizing until then;
    // 0 / past means it's already active, so start from the current age.
    const startAge = Math.trunc(loan.start_age || 0);
    const effStart = startAge > curAge ? startAge : curAge;
    let month = 0;
    let payoffAge: number | null = null;
    while (bal > 0.01 && month < 1200) {
      const age = effStart + Math.trunc(month / 12);
      if (lumpAge && age >= lumpAge) {
        lumpByAge[age] = (lumpByAge[age] || 0) + bal;
        payoffAge = age;
        bal = 0.0;
        break;
      }
      const interest = bal * mr;
      if (pmt <= interest) { payoffAge = null; break; } // never amortizes
      const principal = Math.min(pmt - interest, bal);
      const pay = interest + principal;
      bal -= principal;
      paymentByAge[age] = (paymentByAge[age] || 0) + pay;
      month += 1;
    }
    if (bal <= 0.01 && payoffAge === null) payoffAge = effStart + Math.trunc((month - 1) / 12);
    payoffs.push({ name: loan.name || "Loan", payoff_age: payoffAge });
  }
  return { payment_by_age: paymentByAge, lump_by_age: lumpByAge, payoffs };
}

function grossUpOrdinary(
  base: number, netNeeded: number, brackets: BracketRow[] | undefined, flatRate: number,
  factor: number, deduction: number,
): [number, number] {
  if (netNeeded <= 0) return [0.0, 0.0];
  if (!brackets || brackets.length === 0) {
    const r = Math.min(Math.max(flatRate, 0.0), 0.99);
    // `deduction` is a tax-free exemption on ordinary income (standard deduction
    // + retirement-income exclusion). It shelters the lowest ordinary income
    // first, so only what's left after `base` applies to this withdrawal.
    const remainingExempt = Math.max(deduction - base, 0);
    if (netNeeded <= remainingExempt) return [netNeeded, 0.0];
    const gross = remainingExempt + (netNeeded - remainingExempt) / (1 - r);
    return [gross, (gross - remainingExempt) * r];
  }
  const rows = [...brackets].sort((x, y) => x.threshold - y.threshold);
  const thresholds = rows.map((b) => b.threshold * factor + deduction);
  const rates = rows.map((b) => b.rate);
  let gross = 0.0, tax = 0.0, net = 0.0, pos = base;
  while (net < netNeeded - 1e-6) {
    let r = 0.0;
    for (let i = 0; i < rows.length; i++) if (pos >= thresholds[i]) r = rates[i];
    const above = thresholds.filter((t) => t > pos);
    const nxt = above.length ? Math.min(...above) : Infinity;
    const stepGross = nxt - pos;
    const stepNet = stepGross * (1 - r);
    if (net + stepNet >= netNeeded) {
      const g = r < 1 ? (netNeeded - net) / (1 - r) : netNeeded - net;
      gross += g; tax += g * r; net = netNeeded;
    } else {
      gross += stepGross; tax += stepGross * r; net += stepNet; pos = nxt;
    }
  }
  return [gross, tax];
}

// ---- drawdown ------------------------------------------------------------- //

export interface DrawBucket { name: string; tax: string; balance: number }
export interface DrawRow {
  year: number; age: number; start_balance: number; growth: number; withdrawal: number;
  rmd: number; social_security: number; other_income: number; tax_401k: number;
  tax_capgains: number; tax_ss: number; tax_other: number; after_tax_income: number;
  healthcare: number; loan_payment: number; life_event: number; spending: number;
  net_cash_flow: number; end_balance: number; buckets: DrawBucket[];
}

export function runDrawdown(
  a: Assumptions, startBalance: number, startYear: number, baseYear?: number,
  events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
  marketReturns?: number[],
): DrawRow[] {
  const rows: DrawRow[] = [];
  const retAge = Math.trunc(a.retirement_age);
  const life = Math.trunc(a.life_expectancy);
  const claimAge = Math.trunc(a.ss_claim_age);
  const bYear = baseYear === undefined ? startYear : baseYear;
  const index = !!num(a, "index_to_inflation", 1);
  const inflation = a.inflation;
  const flat401k = a.tax_rate_401k;
  const cgRate = num(a, "cap_gains_rate", 0.15);
  const byAge = eventsByAge(events);

  const buckets = buildBuckets(a, startBalance, assets, bYear, startYear);
  const surplusIdx = buckets.length;
  buckets.push({
    name: "Cash savings", value: 0.0, rate: num(a, "cash_savings_rate", 0.02),
    tax: "cash", basis: 0.0, is_market: false, auto: true,
  });
  const order = withdrawalOrder(a, buckets).filter((i) => i !== surplusIdx).concat([surplusIdx]);
  const sched = loanSchedules(loans, a);

  const ordinaryTax = (income: number, deduction: number): number => {
    if (income <= 0) return 0.0;
    if (brackets && brackets.length) return progressiveTax(Math.max(income - deduction, 0.0), brackets, 1.0);
    return Math.max(income - deduction, 0.0) * flat401k; // exemption applies to the flat rate too
  };

  let year = startYear;
  for (let idx = 0; idx <= life - retAge; idx++) {
    const age = retAge + idx;
    const factor = index ? (1 + inflation) ** (year - bYear) : 1.0;
    // Ordinary-income exemption: the standard deduction plus the tax-free
    // retirement-income exclusion (both today's dollars, indexed by `factor`).
    // Subtracted from ordinary retirement-plan income before tax.
    const deduction = (num(a, "standard_deduction", 0.0) + retirementExclusion(a, age)) * factor;
    const start = buckets.reduce((s, b) => s + b.value, 0);

    let growth = 0.0;
    for (const b of buckets) {
      const rate = marketReturns && b.is_market ? marketReturns[idx] : b.rate;
      const g = b.value * rate;
      b.value += g;
      growth += g;
    }

    const ss = (age >= claimAge ? a.ss_annual_benefit : 0.0) * factor;
    const otherStart = Math.trunc(num(a, "other_income_start_age") || retAge);
    const otherIncome = (age >= otherStart ? num(a, "other_income_annual", 0.0) : 0.0) * factor;
    const taxSs = ss * a.tax_rate_ss;
    const taxOther = brackets && brackets.length
      ? progressiveTax(Math.max(otherIncome - deduction, 0.0), brackets, 1.0)
      : otherIncome * num(a, "tax_rate_other_income", 0.0);
    const incomeNet = (ss - taxSs) + (otherIncome - taxOther);

    const medicareAge = Math.trunc(num(a, "medicare_age", 65));
    const healthcare = age < medicareAge ? num(a, "healthcare_pre65", 0.0) : num(a, "healthcare_post65", 0.0);
    const loanPayment = (sched.payment_by_age[age] || 0.0) + (sched.lump_by_age[age] || 0.0);
    const baseSpending = (a.annual_spending + healthcare) * factor;
    const spending = baseSpending + loanPayment;

    const event = eventAmount(byAge, age, a, year, bYear);
    const baseNeed = Math.max(baseSpending - incomeNet, 0.0);
    const livingFloor = (age >= claimAge ? a.post_ss_withdrawal : a.bridge_withdrawal) * factor;
    const baseTarget = Math.max(baseNeed, livingFloor);
    const incomeLeft = Math.max(incomeNet - baseSpending, 0.0);
    const extras = healthcare * factor + loanPayment;
    const extraNeed = Math.max(extras - incomeLeft, 0.0);
    const netNeed = Math.max(baseTarget + extraNeed - Math.max(event, 0.0), 0.0);

    // Mutable tax/gross accumulators shared by the pull helpers.
    const acc = { ordinaryTaken: otherIncome, totGross: 0.0, taxDef: 0.0, taxCg: 0.0 };

    const pullDeferred = (bucket: Bucket, gross: number): [number, number] => {
      gross = Math.min(gross, bucket.value);
      const tx = ordinaryTax(acc.ordinaryTaken + gross, deduction) - ordinaryTax(acc.ordinaryTaken, deduction);
      acc.ordinaryTaken += gross;
      acc.taxDef += tx;
      bucket.value -= gross;
      return [gross, gross - tx];
    };

    const pullNet = (bucket: Bucket, netTarget: number): [number, number] => {
      if (bucket.value <= EPS || netTarget <= 0) return [0.0, 0.0];
      const t = bucket.tax;
      if (t === "roth" || t === "cash") {
        const g = Math.min(netTarget, bucket.value);
        bucket.value -= g;
        return [g, g];
      }
      if (t === "taxable") {
        const gf = Math.max(bucket.value - bucket.basis, 0.0) / bucket.value;
        const eff = gf * cgRate;
        const g = Math.min(eff < 1 ? netTarget / (1 - eff) : netTarget, bucket.value);
        bucket.basis -= (bucket.value + g) ? g * (bucket.basis / (bucket.value + g)) : 0.0;
        bucket.value -= g;
        const tax = g * eff;
        acc.taxCg += tax;
        return [g, g - tax];
      }
      // deferred: solve gross for the desired net given current ordinary base
      const [gross] = grossUpOrdinary(acc.ordinaryTaken, netTarget, brackets, flat401k, 1.0, deduction);
      return pullDeferred(bucket, gross);
    };

    // 1) RMD floor from tax-deferred buckets (proportional).
    const deferredIdx = buckets.map((b, i) => (b.tax === "deferred" ? i : -1)).filter((i) => i >= 0);
    const deferredTotal = deferredIdx.reduce((s, i) => s + buckets[i].value, 0);
    let rmd = (num(a, "apply_rmd", 1) && age >= 73) ? deferredTotal / rmdDivisor(age) : 0.0;
    rmd = Math.min(rmd, deferredTotal);
    let remainingNet = netNeed;
    if (rmd > 0) {
      for (const i of deferredIdx) {
        const share = deferredTotal ? buckets[i].value / deferredTotal : 0.0;
        const [g, net] = pullDeferred(buckets[i], rmd * share);
        acc.totGross += g;
        remainingNet = Math.max(remainingNet - net, 0.0);
      }
    }

    // 2) Cover the remaining need in withdrawal order.
    for (const i of order) {
      if (remainingNet <= 1e-6) break;
      const [g, net] = pullNet(buckets[i], remainingNet);
      acc.totGross += g;
      remainingNet -= net;
    }

    // 3) Positive life events land in the first bucket (kept invested).
    if (event > 0) {
      const fi = order.length ? order[0] : 0;
      buckets[fi].value += event;
      if (buckets[fi].tax === "taxable") buckets[fi].basis += event;
    }

    const afterTaxIncome = (acc.totGross - acc.taxDef - acc.taxCg) + incomeNet;
    const surplus = afterTaxIncome - spending;
    if (surplus > 1e-6) buckets[surplusIdx].value += surplus;

    const end = buckets.reduce((s, b) => s + b.value, 0);
    const visible = buckets.filter((b) => !(b.auto && b.value < 0.01));
    rows.push({
      year, age, start_balance: round(start), growth: round(growth), withdrawal: round(acc.totGross),
      rmd: round(rmd), social_security: round(ss), other_income: round(otherIncome),
      tax_401k: round(acc.taxDef), tax_capgains: round(acc.taxCg), tax_ss: round(taxSs), tax_other: round(taxOther),
      after_tax_income: round(afterTaxIncome), healthcare: round(healthcare * factor), loan_payment: round(loanPayment),
      life_event: round(event), spending: round(spending), net_cash_flow: round(afterTaxIncome - spending),
      end_balance: round(end),
      buckets: visible.map((b) => ({ name: b.name, tax: b.tax, balance: round(b.value) })),
    });
    year += 1;
  }
  return rows;
}

// ---- real-dollars deflation ---------------------------------------------- //

function deflate<T extends { year: number }>(rows: T[], inflation: number, baseYear: number, fields: string[]): T[] {
  return rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real: any = { ...row };
    const factor = (1 + inflation) ** (row.year - baseYear);
    for (const f of fields) {
      if (real[f] !== undefined && real[f] !== null) real[f] = round(real[f] / factor);
    }
    if (Array.isArray(real.buckets)) {
      real.buckets = (real.buckets as DrawBucket[]).map((b) => ({ ...b, balance: round(b.balance / factor) }));
    }
    return real as T;
  });
}

const DRAWDOWN_MONEY_FIELDS = [
  "start_balance", "growth", "withdrawal", "rmd", "social_security", "other_income",
  "tax_401k", "tax_capgains", "tax_ss", "tax_other", "after_tax_income", "healthcare",
  "loan_payment", "life_event", "spending", "net_cash_flow", "end_balance",
];

const ACCUM_MONEY_FIELDS = [
  "salary", "start_balance", "employee_contribution", "employer_contribution",
  "total_contribution", "growth", "end_balance",
];

// ---- top-level runs ------------------------------------------------------- //

export interface ProjectionResult {
  assumptions: Assumptions; real_dollars: boolean;
  accumulation: AccumRow[]; drawdown: DrawRow[];
  summary: {
    portfolio_at_retirement: number; ending_balance: number; withdrawal_rate: number;
    money_lasts: boolean; depleted_age: number | null; retirement_year: number;
  };
}

export function runProjection(
  assumptions: Assumptions | null, startBalance: number, startYear?: number, realDollars = false,
  events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
): ProjectionResult {
  const a = merged(assumptions);
  const sYear = startYear || new Date().getFullYear();
  let accumulation = runAccumulation(a, startBalance, sYear, events);
  const port401k = accumulation.length ? accumulation[accumulation.length - 1].end_balance : startBalance;
  const retYear = sYear + (Math.trunc(a.retirement_age) - Math.trunc(a.current_age));
  let drawdown = runDrawdown(a, port401k, retYear, sYear, events, brackets, assets, loans);
  let portfolioAtRet = drawdown.length
    ? drawdown[0].start_balance
    : port401k + assetsAtRetirement(a, assets, sYear, retYear);

  if (realDollars) {
    accumulation = deflate(accumulation, a.inflation, sYear, ACCUM_MONEY_FIELDS);
    drawdown = deflate(drawdown, a.inflation, sYear, DRAWDOWN_MONEY_FIELDS);
    portfolioAtRet = drawdown.length ? drawdown[0].start_balance : portfolioAtRet;
  }

  const endingBalance = drawdown.length ? drawdown[drawdown.length - 1].end_balance : portfolioAtRet;
  const depleted = drawdown.find((row) => row.end_balance <= 0);
  const firstWithdrawal = drawdown.length ? drawdown[0].withdrawal : 0.0;
  const withdrawalRate = portfolioAtRet ? firstWithdrawal / portfolioAtRet : 0.0;

  return {
    assumptions: a, real_dollars: realDollars, accumulation, drawdown,
    summary: {
      portfolio_at_retirement: round(portfolioAtRet), ending_balance: round(endingBalance),
      withdrawal_rate: round(withdrawalRate, 4), money_lasts: depleted === undefined,
      depleted_age: depleted ? depleted.age : null, retirement_year: retYear,
    },
  };
}

function drawdownSummary(drawdown: DrawRow[], portfolioAtRet: number) {
  const ending = drawdown.length ? drawdown[drawdown.length - 1].end_balance : portfolioAtRet;
  const depleted = drawdown.find((r) => r.end_balance <= 0);
  const firstWd = drawdown.length ? drawdown[0].withdrawal : 0.0;
  const wr = portfolioAtRet ? firstWd / portfolioAtRet : 0.0;
  return {
    portfolio_at_retirement: round(portfolioAtRet), ending_balance: round(ending),
    depleted_age: depleted ? depleted.age : null, money_lasts: depleted === undefined,
    withdrawal_rate: round(wr, 4),
  };
}

export interface ScenarioDef { name: string; overrides: Assumptions }

export function runDrawdownScenarios(
  assumptions: Assumptions | null, startBalance: number, scenarios: ScenarioDef[],
  startYear?: number, realDollars = false, fixedStart = true,
  events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
) {
  const a = merged(assumptions);
  const sYear = startYear || new Date().getFullYear();
  const retYear = sYear + (Math.trunc(a.retirement_age) - Math.trunc(a.current_age));
  const baseAcc = runAccumulation(a, startBalance, sYear, events);
  const basePort = baseAcc.length ? baseAcc[baseAcc.length - 1].end_balance : startBalance;
  const assetsAtRet = assetsAtRetirement(a, assets, sYear, retYear);

  const results = scenarios.map((sc) => {
    const sa = merged({ ...a, ...(sc.overrides || {}) });
    let port: number;
    if (fixedStart) {
      port = basePort;
    } else {
      const acc = runAccumulation(sa, startBalance, sYear, events);
      port = acc.length ? acc[acc.length - 1].end_balance : startBalance;
    }
    let drawdown = runDrawdown(sa, port, retYear, sYear, events, brackets, assets, loans);
    const totalPort = drawdown.length ? drawdown[0].start_balance : port + assetsAtRet;
    const summary = drawdownSummary(drawdown, totalPort);
    if (realDollars) {
      drawdown = deflate(drawdown, a.inflation, sYear, DRAWDOWN_MONEY_FIELDS);
      summary.ending_balance = drawdown.length ? drawdown[drawdown.length - 1].end_balance : summary.ending_balance;
    }
    return { name: sc.name || "Scenario", overrides: sc.overrides || {}, drawdown, summary };
  });

  return {
    retirement_year: retYear, retirement_age: Math.trunc(a.retirement_age), ss_claim_age: Math.trunc(a.ss_claim_age),
    life_expectancy: Math.trunc(a.life_expectancy), annual_spending: a.annual_spending,
    base_portfolio_at_retirement: round(basePort + assetsAtRet), fixed_start: fixedStart,
    real_dollars: realDollars, scenarios: results,
  };
}

// ---- coast fire ----------------------------------------------------------- //

function drawdownDepletes(
  a: Assumptions, startBalance: number, retYear: number, baseYear: number,
  events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
): boolean {
  const dd = runDrawdown(a, startBalance, retYear, baseYear, events, brackets, assets, loans);
  return dd.some((r) => r.end_balance <= 0);
}

function requiredNestEgg(
  a: Assumptions, startYear: number, events?: EventRow[], brackets?: BracketRow[],
  assets?: AssetRow[], loans?: LoanInput[],
): number {
  const retYear = startYear + (Math.trunc(a.retirement_age) - Math.trunc(a.current_age));
  let hi = Math.max(a.annual_spending, a.post_ss_withdrawal, a.bridge_withdrawal, 1.0) * 30;
  for (let i = 0; i < 60; i++) {
    if (!drawdownDepletes(a, hi, retYear, startYear, events, brackets, assets, loans)) break;
    hi *= 2;
  }
  let lo = 0.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (drawdownDepletes(a, mid, retYear, startYear, events, brackets, assets, loans)) lo = mid;
    else hi = mid;
  }
  return hi;
}

function balanceAtRetirementIfStop(
  a: Assumptions, startBalance: number, stopAge: number, startYear: number, events?: EventRow[],
): number {
  let balance = startBalance;
  let salary = a.current_salary;
  const r = a.nominal_return;
  let age = Math.trunc(a.current_age);
  const retAge = Math.trunc(a.retirement_age);
  let year = startYear;
  let empPct = a.employee_contrib_pct;
  const byAge = eventsByAge(events);
  while (age < retAge) {
    let contrib = 0.0;
    if (age < stopAge) {
      const [employee, employer] = contributions(a, salary, age, empPct, year, startYear);
      contrib = employee + employer;
    }
    const growth = balance * r + contrib * (Math.sqrt(1 + r) - 1);
    balance = Math.max(balance + contrib + growth + eventAmount(byAge, age, a, year, startYear), 0.0);
    salary *= 1 + a.salary_growth;
    empPct = escalate(a, empPct);
    age += 1;
    year += 1;
  }
  return balance;
}

export function coastFire(
  assumptions: Assumptions | null, startBalance: number, startYear?: number, realDollars = false,
  events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
) {
  const a = merged(assumptions);
  const sYear = startYear || new Date().getFullYear();
  const curAge = Math.trunc(a.current_age), retAge = Math.trunc(a.retirement_age);
  const r = a.nominal_return;
  const n = retAge - curAge;
  const retYear = sYear + n;
  const inflFactor = (1 + a.inflation) ** n;
  const assetsAtRet = assetsAtRetirement(a, assets, sYear, retYear);

  const custom = num(a, "retirement_goal_today", 0) || 0;
  let required: number, goalSource: "auto" | "custom";
  if (custom > 0) {
    required = custom * inflFactor;
    goalSource = "custom";
  } else {
    required = requiredNestEgg(a, sYear, events, brackets, assets, loans) + assetsAtRet;
    goalSource = "auto";
  }

  const required401k = Math.max(required - assetsAtRet, 0.0);
  const coastNumberToday = n > 0 ? required401k / (1 + r) ** n : required401k;
  const projected401k = balanceAtRetirementIfStop(a, startBalance, retAge, sYear, events);
  const projectedNestEgg = projected401k + assetsAtRet;

  let curve: { stop_age: number; retirement_balance: number }[] = [];
  let coastAge: number | null = null;
  for (let stopAge = curAge; stopAge <= retAge; stopAge++) {
    const bal = balanceAtRetirementIfStop(a, startBalance, stopAge, sYear, events) + assetsAtRet;
    curve.push({ stop_age: stopAge, retirement_balance: round(bal) });
    if (coastAge === null && bal >= required) coastAge = stopAge;
  }

  const fullyFunded = projectedNestEgg >= required;

  const lifetime = (stopAge: number) => {
    const port = balanceAtRetirementIfStop(a, startBalance, stopAge, sYear, events);
    const dd = runDrawdown(a, port, retYear, sYear, events, brackets, assets, loans);
    return dd.map((row) => {
      let bal = row.end_balance;
      if (realDollars) bal = bal / (1 + a.inflation) ** (row.year - sYear);
      return { age: row.age, balance: round(bal) };
    });
  };

  const coastDrawdown = coastAge !== null ? lifetime(coastAge) : null;
  const keepDrawdown = lifetime(retAge);

  let requiredOut: number, projectedOut: number;
  if (realDollars) {
    requiredOut = required / inflFactor;
    projectedOut = projectedNestEgg / inflFactor;
    curve = curve.map((p) => ({ stop_age: p.stop_age, retirement_balance: round(p.retirement_balance / inflFactor) }));
  } else {
    requiredOut = required;
    projectedOut = projectedNestEgg;
  }

  return {
    start_year: sYear, current_age: curAge, retirement_age: retAge, real_dollars: realDollars,
    goal_source: goalSource, retirement_goal_today: round(required / inflFactor),
    current_balance: round(startBalance), required_nest_egg: round(requiredOut),
    projected_nest_egg: round(projectedOut), coast_number_today: round(coastNumberToday),
    is_coasting_now: coastAge === curAge, coast_age: coastAge,
    coast_year: coastAge !== null ? sYear + (coastAge - curAge) : null,
    years_until_coast: coastAge !== null ? coastAge - curAge : null,
    fully_funded: fullyFunded,
    annual_employee_contribution: round(a.current_salary * a.employee_contrib_pct),
    curve, coast_drawdown: coastDrawdown, keep_drawdown: keepDrawdown, life_expectancy: Math.trunc(a.life_expectancy),
  };
}

// ---- monte carlo ---------------------------------------------------------- //

/** Deterministic PRNG (mulberry32) so the success rate is stable across runs. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarlo(
  assumptions: Assumptions | null, startBalance: number, startYear?: number, nSims = 1000,
  seed = 42, events?: EventRow[], brackets?: BracketRow[], assets?: AssetRow[], loans?: LoanInput[],
  realDollars = false,
) {
  const a = merged(assumptions);
  const sYear = startYear || new Date().getFullYear();
  const rand = mulberry32(seed);
  // Box-Muller gaussian from the uniform PRNG.
  const gauss = (mu: number, sigma: number): number => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mu = a.nominal_return, sigma = a.return_volatility;
  const curAge = Math.trunc(a.current_age), retAge = Math.trunc(a.retirement_age), life = Math.trunc(a.life_expectancy);
  const retYear = sYear + (retAge - curAge);

  // Deflate to today's dollars when asked, so the ranges/fan match the balance
  // chart's toggle. A value at `age` occurs (age - curAge) years from today.
  const deflate = (v: number, age: number): number =>
    realDollars ? v / (1 + a.inflation) ** (age - curAge) : v;

  let successes = 0;
  const endingBalances: number[] = [];
  const retirementBalances: number[] = [];
  const perAge: number[][] = []; // perAge[i] = end balances at retirement-year i across sims

  for (let s = 0; s < nSims; s++) {
    let balance = startBalance;
    let salary = a.current_salary;
    let empPct = a.employee_contrib_pct;
    let year = sYear;
    for (let age = curAge; age < retAge; age++) {
      const r = gauss(mu, sigma);
      const [employee, employer] = contributions(a, salary, age, effContribPct(a, age, empPct), year, sYear);
      const contrib = employee + employer;
      balance = Math.max(balance * (1 + r) + contrib * Math.sqrt(Math.max(1 + r, 0.0)), 0.0);
      salary *= 1 + a.salary_growth;
      empPct = escalate(a, empPct);
      year += 1;
    }
    const marketReturns: number[] = [];
    for (let age = retAge; age <= life; age++) marketReturns.push(gauss(mu, sigma));
    const dd = runDrawdown(a, balance, retYear, sYear, events, brackets, assets, loans, marketReturns);
    retirementBalances.push(deflate(dd.length ? dd[0].start_balance : balance, retAge));
    const depleted = dd.some((row) => row.end_balance <= 0);
    if (!depleted) successes += 1;
    endingBalances.push(deflate(dd.length ? dd[dd.length - 1].end_balance : balance, life));
    for (let i = 0; i < dd.length; i++) (perAge[i] ??= []).push(deflate(dd[i].end_balance, dd[i].age));
  }

  endingBalances.sort((x, y) => x - y);
  retirementBalances.sort((x, y) => x - y);
  const pct = (vals: number[], p: number): number => {
    if (!vals.length) return 0.0;
    const idx = Math.min(Math.trunc(p * vals.length), vals.length - 1);
    return round(vals[idx]);
  };

  const balance_percentiles = perAge.map((arr, i) => {
    arr.sort((x, y) => x - y);
    return { age: retAge + i, p10: pct(arr, 0.1), p50: pct(arr, 0.5), p90: pct(arr, 0.9) };
  });

  return {
    n_sims: nSims,
    real_dollars: realDollars,
    success_rate: round(successes / nSims, 4),
    retirement_balance_percentiles: { p10: pct(retirementBalances, 0.1), p50: pct(retirementBalances, 0.5), p90: pct(retirementBalances, 0.9) },
    ending_balance_percentiles: { p10: pct(endingBalances, 0.1), p50: pct(endingBalances, 0.5), p90: pct(endingBalances, 0.9) },
    balance_percentiles,
  };
}
