/**
 * A synthetic demo dataset so first-time visitors can explore the app with
 * realistic-looking numbers without importing anything. It is entirely made up
 * (a fictional saver) — no real person's data.
 *
 * We generate a plain CSV string in the same shape a real export has, so it
 * flows through the exact same parser/import path as a user's own file.
 */
import type { Assumptions } from "../types";
import type { OtherAssetRow, LoanRow, SSBenefitRow } from "./db";

const FUND = "Vanguard 500 Index Fund";
const TICKER = "VFIAX";

/** Build ~6 years of monthly contributions + quarterly reinvested dividends. */
export function sampleCsv(): string {
  const rows: string[][] = [[
    "Date", "Category", "Security", "Fund Name", "Action", "Transaction Type", "Quantity", "Price", "Amount",
  ]];

  const now = new Date();
  const years = 6;
  const months = years * 12;
  const salaryStart = 78000;
  const employeePct = 0.12;
  const employerMatch = 0.5 * 0.06; // 50% match up to 6% of salary
  const priceStart = 300;
  const monthlyGrowth = 0.0058; // ~7.2%/yr

  let price = priceStart;
  let monthsSinceDiv = 0;

  for (let i = months; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-15`;
    // Gentle deterministic wiggle so the price line isn't a perfect curve.
    const wiggle = 1 + 0.03 * Math.sin(i / 2.5);
    price = priceStart * Math.pow(1 + monthlyGrowth, months - i) * wiggle;
    const p = +price.toFixed(2);
    // Salary drifts up ~2.5%/yr.
    const salary = salaryStart * Math.pow(1.025, (months - i) / 12);
    const emp = +((salary * employeePct) / 12).toFixed(2);
    const empr = +((salary * employerMatch) / 12).toFixed(2);

    rows.push([iso, "Employee Pre-Tax Contributions", TICKER, FUND, "Buy",
      "Employee Pre-Tax Contribution", (emp / p).toFixed(6), `$${p.toFixed(2)}`, `$${emp.toFixed(2)}`]);
    rows.push([iso, "Employer Match", TICKER, FUND, "Buy",
      "Employer Match Contribution", (empr / p).toFixed(6), `$${p.toFixed(2)}`, `$${empr.toFixed(2)}`]);

    monthsSinceDiv++;
    if (monthsSinceDiv >= 3) {
      monthsSinceDiv = 0;
      const div = +(150 + (months - i) * 3).toFixed(2); // dividends grow as the balance does
      rows.push([iso, "Dividends", TICKER, FUND, "REINVDIV",
        `Dividend of $${div.toFixed(2)}`, (div / p).toFixed(6), `$${p.toFixed(2)}`, `$${div.toFixed(2)}`]);
    }
  }

  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Sample plan settings shown alongside the demo transactions. */
export const sampleAssumptions: Assumptions = {
  current_age: 34,
  retirement_age: 65,
  life_expectancy: 92,
  current_salary: 90000,
  employee_contrib_pct: 0.12,
  employer_match_pct: 0.5,
  match_cap_pct: 0.06,
  annual_spending: 55000,
  ss_claim_age: 67,
  nominal_return: 0.07,
  inflation: 0.03,
  cap_gains_rate: 0.15,
};

export const sampleSSBenefits: SSBenefitRow[] = [
  { claim_age: 62, monthly_benefit: 1850 },
  { claim_age: 67, monthly_benefit: 2650 },
  { claim_age: 70, monthly_benefit: 3300 },
];

export const sampleOtherAssets: OtherAssetRow[] = [
  { name: "Roth IRA", value: 42000, growth_rate: 0.07, contribution_annual: 7000, tax_type: "roth", cost_basis: 0, is_market: 1 },
  { name: "Brokerage", value: 25000, growth_rate: 0.06, contribution_annual: 3000, tax_type: "taxable", cost_basis: 18000, is_market: 1 },
];

export const sampleLoans: LoanRow[] = [
  { name: "Mortgage", balance: 265000, annual_rate: 0.055, months_remaining: 312, extra_payment_monthly: 0, lump_sum_payoff_age: 0 },
];
