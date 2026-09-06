import type { Assumptions } from "./types";

/** Soft plausibility checks for assumption values.
 *
 * These never block input — they only return a short warning string when a
 * value is far outside the historically plausible range (usually a typo,
 * e.g. 90 instead of 9 for a return). Keys not listed are never flagged.
 */
const CHECKS: Record<string, (v: number, a: Assumptions) => string | null> = {
  nominal_return: (v) =>
    v > 0.15
      ? "Very high — the S&P 500's long-run average is ~10%/yr. Typo?"
      : v < 0
        ? "Negative average return means losing money every year."
        : null,
  inflation: (v) =>
    v > 0.1 ? "Very high — US inflation has averaged ~3%/yr." : v < 0 ? "Negative inflation (deflation) is rare." : null,
  return_volatility: (v) =>
    v > 0.4 ? "Very high — stock-market volatility is typically 15–20%." : null,
  salary_growth: (v) => (v > 0.15 ? "Very high for a sustained yearly raise." : null),
  employee_contrib_pct: (v) =>
    v > 0.5 ? "Over 50% of salary — IRS limits usually cap 401(k) deferrals well below this." : null,
  tax_rate_401k: (v) => (v > 0.6 ? "Higher than any realistic effective tax rate." : null),
  tax_rate_ss: (v) => (v > 0.6 ? "Higher than any realistic effective tax rate." : null),
  ss_claim_age: (v) =>
    v !== 0 && (v < 62 || v > 70) ? "Social Security can only be claimed between ages 62 and 70." : null,
  retirement_age: (v, a) =>
    v <= (a.current_age ?? 0) ? "At or below your current age — accumulation years will be zero." : null,
  life_expectancy: (v, a) =>
    v <= (a.retirement_age ?? 0) ? "At or below retirement age — there are no retirement years to plan." : null,
};

export function sanityWarning(key: string, a: Assumptions): string | null {
  const check = CHECKS[key];
  if (!check) return null;
  const v = a[key];
  if (v === undefined || v === null || Number.isNaN(v)) return null;
  return check(v, a);
}
