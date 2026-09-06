export interface Summary {
  market_value: number;
  total_contributions: number;
  employee_contributions: number;
  employer_contributions: number;
  dividends: number;
  total_gain: number;
  first_date: string | null;
  last_date: string | null;
}

export interface Holding {
  security: string;
  fund_name: string;
  shares: number;
  price: number;
  market_value: number;
  cost_basis: number;
  gain: number;
  gain_pct: number;
}

export interface BalancePoint {
  date: string;
  market_value: number;
  contributions_cum: number;
  gain_cum: number;
}

export interface YearContribution {
  year: number;
  employee: number;
  employer: number;
  total: number;
}

export interface DataQualityWarning {
  security: string;
  fund_name: string;
  severity: string;
  message: string;
}

export interface ImportBatch {
  id: number;
  filename: string;
  imported_at: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
}

export interface Transaction {
  id: number;
  txn_date: string;
  category: string;
  security: string;
  fund_name: string;
  action: string;
  transaction_type: string;
  quantity: number;
  price: number;
  amount: number;
}

export type Assumptions = Record<string, number>;

export interface OtherAssetRow {
  id?: number;
  name: string;
  value: number;
  growth_rate: number;
  contribution_annual: number;
  tax_type: "deferred" | "roth" | "taxable" | "cash";
  cost_basis: number;
  is_market: number;
}

export interface LoanRow {
  id?: number;
  name: string;
  balance: number;
  annual_rate: number;
  months_remaining: number;
  extra_payment_monthly: number;
  lump_sum_payoff_age: number;
}

export interface LifeEventRow {
  id?: number;
  age: number;
  amount: number;
  label: string;
}

export interface TaxBracketRow {
  threshold: number;
  rate: number;
}

export interface SSBenefitRow {
  claim_age: number;
  monthly_benefit: number;
}

export interface AssumptionsResponse {
  assumptions: Assumptions;
  defaults: Assumptions;
  /** Annual benefit derived from the SS table for the saved claim age; null when the table is empty. */
  ss_benefit_from_table: number | null;
}

export interface AccumulationRow {
  year: number;
  age: number;
  salary: number;
  start_balance: number;
  employee_contribution: number;
  employer_contribution: number;
  total_contribution: number;
  growth: number;
  end_balance: number;
}

export interface DrawdownRow {
  year: number;
  age: number;
  start_balance: number;
  growth: number;
  withdrawal: number;
  rmd: number;
  social_security: number;
  tax_401k: number;
  tax_ss: number;
  after_tax_income: number;
  spending: number;
  net_cash_flow: number;
  end_balance: number;
  loan_payment?: number;
  buckets?: { name: string; tax: string; balance: number }[];
}

export interface ProjectionResult {
  assumptions: Assumptions;
  real_dollars: boolean;
  accumulation: AccumulationRow[];
  drawdown: DrawdownRow[];
  summary: {
    portfolio_at_retirement: number;
    ending_balance: number;
    withdrawal_rate: number;
    money_lasts: boolean;
    depleted_age: number | null;
    retirement_year: number;
  };
}

export interface ScenarioResult {
  name: string;
  overrides: Record<string, number>;
  drawdown: DrawdownRow[];
  summary: {
    portfolio_at_retirement: number;
    ending_balance: number;
    depleted_age: number | null;
    money_lasts: boolean;
    withdrawal_rate: number;
  };
}

export interface DrawdownScenariosResult {
  retirement_year: number;
  retirement_age: number;
  ss_claim_age: number;
  life_expectancy: number;
  annual_spending: number;
  base_portfolio_at_retirement: number;
  fixed_start: boolean;
  real_dollars: boolean;
  scenarios: ScenarioResult[];
}

export interface ScenarioInput {
  name: string;
  overrides: Record<string, number>;
}

export interface CoastFirePoint {
  stop_age: number;
  retirement_balance: number;
}

export interface CoastFireResult {
  start_year: number;
  current_age: number;
  retirement_age: number;
  real_dollars: boolean;
  goal_source: "auto" | "custom";
  retirement_goal_today: number;
  current_balance: number;
  required_nest_egg: number;
  projected_nest_egg: number;
  coast_number_today: number;
  is_coasting_now: boolean;
  coast_age: number | null;
  coast_year: number | null;
  years_until_coast: number | null;
  fully_funded: boolean;
  annual_employee_contribution: number;
  curve: CoastFirePoint[];
  coast_drawdown: { age: number; balance: number }[] | null;
  keep_drawdown: { age: number; balance: number }[];
  life_expectancy: number;
}

export interface MonteCarloResult {
  n_sims: number;
  success_rate: number;
  retirement_balance_percentiles: { p10: number; p50: number; p90: number };
  ending_balance_percentiles: { p10: number; p50: number; p90: number };
}
