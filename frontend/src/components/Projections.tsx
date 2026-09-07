import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { Assumptions, MonteCarloResult, ProjectionResult } from "../types";
import { pct, usd, usdCompact } from "../format";
import { sanityWarning } from "../sanity";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";
import WithdrawalOrder from "./WithdrawalOrder";
import { useChartColors } from "../theme";

type FieldType = "money" | "pct" | "age" | "num" | "bool";
interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  tip?: string;
}
interface Group {
  title: string;
  fields: FieldDef[];
  /** Optional custom control rendered after the fields. */
  widget?: "withdrawal-order";
}

/** The handful of inputs that drive most of the answer — always visible. */
const ESSENTIALS: FieldDef[] = [
  { key: "current_age", label: "Current age", type: "age" },
  { key: "retirement_age", label: "Retirement age", type: "age" },
  { key: "life_expectancy", label: "Plan until age", type: "age", tip: "How long the plan must last. Planning to 90–95 is the safer stress case." },
  { key: "current_salary", label: "Current salary", type: "money" },
  { key: "employee_contrib_pct", label: "Your contribution", type: "pct", tip: "The share of your salary you put into the 401(k) each year, before taxes." },
  { key: "annual_spending", label: "Annual spending", type: "money", tip: "What you expect to spend each year in retirement, in today's dollars. Healthcare is set separately." },
  { key: "nominal_return", label: "Expected return", type: "pct", tip: "Average yearly investment growth before subtracting inflation (a 'nominal' return)." },
  { key: "inflation", label: "Inflation", type: "pct", tip: "Assumed yearly rise in prices. It erodes what a future dollar can buy." },
];

/** Everything else, tucked into collapsible sections. */
const ADVANCED: Group[] = [
  {
    title: "Employer match & raises",
    fields: [
      { key: "salary_growth", label: "Salary growth / yr", type: "pct" },
      { key: "employer_match_pct", label: "Employer match", type: "pct", hint: "% of your contribution", tip: "For every dollar you contribute (up to the cap), your employer adds this fraction. 50% = they add 50¢ per $1." },
      { key: "match_cap_pct", label: "Match cap", type: "pct", hint: "up to this % of salary", tip: "Your employer only matches contributions up to this percent of your salary. Beyond it, there's no match." },
      { key: "employer_profit_sharing_pct", label: "Profit sharing", type: "pct", tip: "Extra employer contribution, as a % of salary, that isn't tied to what you put in." },
      { key: "contrib_escalation", label: "Auto-escalate / yr", type: "pct", hint: "0 = keep the same %", tip: "Many plans let you raise your contribution rate automatically each year. This adds that many percentage points annually." },
      { key: "contrib_escalation_cap", label: "Escalate up to", type: "pct", hint: "0 = no ceiling", tip: "Stop auto-escalating once your contribution reaches this percent of salary." },
    ],
  },
  {
    title: "Contribution limits",
    fields: [
      { key: "limit_employee_deferral", label: "Your annual cap", type: "money", hint: "0 = no limit", tip: "The most you may defer from pay in a year. Caps vary by jurisdiction and plan type — set whichever applies to yours." },
      { key: "limit_catchup", label: "Catch-up extra", type: "money", hint: "0 = none", tip: "Additional amount allowed once you reach the catch-up age." },
      { key: "catchup_age", label: "Catch-up age", type: "age", tip: "Age at which the catch-up amount becomes available (50 under US rules)." },
      { key: "limit_total_415c", label: "Combined cap", type: "money", hint: "you + employer, 0 = none", tip: "Ceiling on your contributions plus all employer money in one year. Employer dollars are trimmed first if the combined total would exceed it." },
      { key: "index_limits", label: "Grow the caps with inflation each year", type: "bool", tip: "Contribution caps are adjusted upward most years. Leaving this on avoids understating decades of future contributions." },
    ],
  },
  {
    title: "Social Security & taxes",
    fields: [
      { key: "ss_claim_age", label: "SS claim age", type: "age", tip: "The age you start taking Social Security. Claiming later means larger monthly checks." },
      { key: "ss_annual_benefit", label: "SS annual benefit", type: "money", tip: "Your estimated Social Security income per year, in today's dollars." },
      { key: "tax_rate_401k", label: "Tax on 401(k)", type: "pct", tip: "Effective income-tax rate applied to money withdrawn from the traditional 401(k)." },
      { key: "roth_share", label: "Roth share of balance", type: "pct", hint: "withdrawn tax-free", tip: "Portion of your balance that is Roth money. Roth withdrawals aren't taxed, so this share is excluded when computing tax on withdrawals." },
      { key: "standard_deduction", label: "Standard deduction", type: "money", hint: "only with tax brackets", tip: "Income exempt before progressive brackets apply. Ignored when no bracket table is set on the Events & Taxes tab." },
      { key: "tax_rate_ss", label: "Tax on SS", type: "pct", tip: "Effective tax rate on Social Security income. Some jurisdictions don't tax it — use 0 in that case." },
    ],
  },
  {
    title: "Retirement withdrawals",
    fields: [
      { key: "bridge_withdrawal", label: "Before SS starts", type: "money", tip: "Yearly amount pulled from the 401(k) during the 'bridge' years — after you retire but before Social Security begins." },
      { key: "post_ss_withdrawal", label: "After SS starts", type: "money", tip: "Yearly 401(k) withdrawal once Social Security kicks in (it can be smaller, since SS covers part of your spending)." },
      { key: "index_to_inflation", label: "Inflation-index withdrawals & Social Security", type: "bool", tip: "When on, your withdrawals, SS, and spending grow with inflation each year so their real buying power stays constant." },
      { key: "apply_rmd", label: "Enforce RMDs from age 73", type: "bool", tip: "Required minimum distributions force withdrawals from traditional balances whether you need the money or not." },
    ],
  },
  {
    title: "Healthcare",
    fields: [
      { key: "healthcare_pre65", label: "Before Medicare / yr", type: "money", tip: "Premiums and out-of-pocket costs between retiring and Medicare eligibility — often the most expensive stretch, and easy to forget if you retire early. In today's dollars, on top of your annual spending." },
      { key: "healthcare_post65", label: "On Medicare / yr", type: "money", tip: "Medicare premiums, supplements, and out-of-pocket costs after eligibility. In today's dollars, on top of your annual spending." },
      { key: "medicare_age", label: "Medicare age", type: "age", tip: "Age at which healthcare costs switch from the pre-Medicare figure to the Medicare figure." },
    ],
  },
  {
    title: "Other assets & income",
    fields: [
      { key: "other_assets_today", label: "Other invested assets", type: "money", hint: "IRA, Roth, taxable, old 401(k)", tip: "Money invested outside this 401(k) that will also fund retirement. It grows at the same expected return and is added to your projected nest egg." },
      { key: "other_income_annual", label: "Other income / yr", type: "money", hint: "pension, rental, part-time", tip: "Recurring retirement income from outside your portfolio, in today's dollars." },
      { key: "other_income_start_age", label: "Other income starts", type: "age", hint: "0 = at retirement", tip: "Age this income begins — e.g. a pension that starts later than you retire." },
      { key: "tax_rate_other_income", label: "Tax on other income", type: "pct", tip: "Effective tax rate applied to that outside income." },
    ],
  },
  {
    title: "Withdrawal order & capital gains",
    widget: "withdrawal-order",
    fields: [
      { key: "cap_gains_rate", label: "Capital-gains tax", type: "pct", tip: "Tax on the gain portion when withdrawing from a taxable brokerage bucket (set up on the Assets & Debts tab)." },
      { key: "cash_savings_rate", label: "Cash savings rate", type: "pct", hint: "growth on surplus kept as cash", tip: "When a withdrawal floor pulls more than you spend, the surplus is kept in a cash savings account that grows at this rate (rather than being reinvested or lost). It's spent only as a last resort." },
    ],
  },
  {
    title: "Risk modelling",
    fields: [
      { key: "return_volatility", label: "Volatility", type: "pct", hint: "for Monte Carlo", tip: "How much yearly returns swing around the average. Higher volatility means a wider range of outcomes. Set it to 0 and the simulation becomes deterministic." },
    ],
  },
];

function toDisplay(type: FieldType, v: number): string {
  // Round away IEEE-754 artifacts: 0.14 * 100 === 14.000000000000002.
  if (type === "pct") return String(+(v * 100).toFixed(8));
  return v.toString();
}
function fromDisplay(type: FieldType, s: string): number {
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return type === "pct" ? n / 100 : n;
}
function shortValue(f: FieldDef, v: number): string {
  if (f.type === "pct") return `${+(v * 100).toFixed(2)}%`;
  if (f.type === "money") return usdCompact(v);
  if (f.type === "bool") return v === 1 ? "on" : "off";
  return String(v);
}

/** A concrete, real-money translation shown under abstract inputs. */
function derivedHint(key: string, a: Assumptions): string | null {
  if (key === "employee_contrib_pct") {
    const dollars = (a.current_salary ?? 0) * (a.employee_contrib_pct ?? 0);
    const base = a.limit_employee_deferral ?? 0;
    const catchup = (a.current_age ?? 0) >= (a.catchup_age ?? 50) ? a.limit_catchup ?? 0 : 0;
    const cap = base > 0 ? base + catchup : 0;
    const line = `= ${usd(dollars)}/yr`;
    if (cap <= 0) return line;
    return dollars > cap ? `${line} · capped at ${usd(cap)}` : `${line} · under your ${usd(cap)} cap`;
  }
  if (key === "employer_match_pct" || key === "match_cap_pct") {
    const matched = Math.min(a.employee_contrib_pct ?? 0, a.match_cap_pct ?? 0);
    const dollars = matched * (a.current_salary ?? 0) * (a.employer_match_pct ?? 0);
    return `employer adds ${usd(dollars)}/yr`;
  }
  if (key === "nominal_return") {
    const real = (1 + (a.nominal_return ?? 0)) / (1 + (a.inflation ?? 0)) - 1;
    return `≈ ${(real * 100).toFixed(1)}% real, after inflation`;
  }
  return null;
}

export default function Projections({ hasData }: { hasData: boolean }) {
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null);
  const [defaults, setDefaults] = useState<Assumptions | null>(null);
  const [realDollars, setRealDollars] = useState(false);
  const [proj, setProj] = useState<ProjectionResult | null>(null);
  const [mc, setMc] = useState<MonteCarloResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [ssFromTable, setSsFromTable] = useState<number | null>(null);
  const [hasBrackets, setHasBrackets] = useState(false);
  const [delta, setDelta] = useState<number | null>(null);
  const didInit = useRef(false);
  const prevPortfolio = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const c = useChartColors();

  useEffect(() => {
    api.assumptions().then((r) => {
      setAssumptions(r.assumptions);
      setDefaults(r.defaults);
      setSsFromTable(r.ss_benefit_from_table);
    });
    api.taxBrackets().then((b) => setHasBrackets(b.length > 0));
  }, []);

  async function recalc(a: Assumptions, real = realDollars) {
    setPending(false);
    setBusy(true);
    try {
      await api.saveAssumptions(a);
      const [p, m, meta] = await Promise.all([
        api.projection({}, real),
        api.monteCarlo({}, 2000),
        api.assumptions(),
      ]);
      const newPortfolio = p.summary.portfolio_at_retirement;
      // Only show a delta between two runs in the same dollar basis, so the
      // nominal/real toggle doesn't register as a change you made.
      if (prevPortfolio.current !== null && real === proj?.real_dollars) {
        const d = newPortfolio - prevPortfolio.current;
        setDelta(Math.abs(d) >= 1 ? d : null);
      } else {
        setDelta(null);
      }
      prevPortfolio.current = newPortfolio;
      setProj(p);
      setMc(m);
      setSsFromTable(meta.ss_benefit_from_table);
    } finally {
      setBusy(false);
    }
  }

  // Run once on load, then auto-recalculate shortly after edits stop.
  useEffect(() => {
    if (!assumptions) return;
    if (!didInit.current) {
      didInit.current = true;
      recalc(assumptions);
      return;
    }
    setPending(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => recalc(assumptions), 600);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assumptions]);

  // Switching dollar basis re-runs immediately.
  useEffect(() => {
    if (assumptions && didInit.current) recalc(assumptions, realDollars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realDollars]);

  const cashOf = (r: { buckets?: { name: string; balance: number }[] }) =>
    r.buckets?.find((b) => b.name === "Cash savings")?.balance ?? 0;

  const chartData = useMemo(() => {
    if (!proj) return [];
    return [
      ...proj.accumulation.map((r) => ({ age: r.age, balance: r.end_balance, cash: 0 })),
      ...proj.drawdown.map((r) => ({ age: r.age, balance: r.end_balance, cash: cashOf(r) })),
    ];
  }, [proj]);

  // Detect over-withdrawal: money pulled beyond spending, kept as cash.
  const cashInfo = useMemo(() => {
    if (!proj || !assumptions || proj.drawdown.length === 0) return null;
    const endCash = cashOf(proj.drawdown[proj.drawdown.length - 1]);
    const surplusYears = proj.drawdown.filter((r) => (r.net_cash_flow ?? 0) > 1);
    if (endCash < 1 || surplusYears.length === 0) return null;
    const avgSurplus = surplusYears.reduce((s, r) => s + r.net_cash_flow, 0) / surplusYears.length;
    // Suggested floor is in today's dollars, matching the input field: your
    // yearly spending minus Social Security (both already today's-dollars inputs).
    const ssToday = ssFromTable ?? assumptions.ss_annual_benefit ?? 0;
    const suggested = Math.max(Math.round(((assumptions.annual_spending ?? 0) - ssToday) / 500) * 500, 0);
    return { endCash, avgSurplus, suggested };
  }, [proj, assumptions, ssFromTable]);

  const totalTax = useMemo(
    () => (proj ? proj.drawdown.reduce((s, r) => s + taxOf(r), 0) : 0),
    [proj],
  );

  if (!assumptions) return <div className="center-load"><div className="spinner" /> Loading assumptions…</div>;

  const retAge = assumptions.retirement_age;
  const status = busy ? "Calculating…" : pending ? "Pending…" : "Up to date";

  const renderField = (f: FieldDef) => {
    if (f.type === "bool") {
      return (
        <div className="field" key={f.key} style={{ gridColumn: "1 / -1" }}>
          <label className="toggle" style={{ color: "var(--text)" }}>
            <input
              type="checkbox"
              checked={(assumptions[f.key] ?? 0) === 1}
              onChange={(e) => setAssumptions({ ...assumptions, [f.key]: e.target.checked ? 1 : 0 })}
            />
            {f.label}
            {f.tip && <InfoTip text={f.tip} align="left" />}
          </label>
          {f.hint && <span className="hint">{f.hint}</span>}
        </div>
      );
    }
    if (f.key === "ss_annual_benefit" && ssFromTable !== null) {
      return (
        <div className="field" key={f.key}>
          <label>
            {f.label} ($){f.tip && <InfoTip text={f.tip} align="left" />}
          </label>
          <input type="text" value={usd(ssFromTable)} disabled style={{ opacity: 0.65 }} />
          <span className="hint">auto from the Social Security tab for claim age {assumptions.ss_claim_age}</span>
        </div>
      );
    }
    const warn = sanityWarning(f.key, assumptions);
    const derived = derivedHint(f.key, assumptions);
    // The flat 401(k) rate is only used when no progressive brackets are set.
    const overridden = f.key === "tax_rate_401k" && hasBrackets;
    return (
      <div className="field" key={f.key}>
        <label>
          {f.label}
          {f.type === "pct" ? " (%)" : f.type === "money" ? " ($)" : ""}
          {f.tip && <InfoTip text={f.tip} align="left" />}
        </label>
        {f.type === "money" ? (
          <MoneyInput
            className={warn ? "input-warn" : undefined}
            value={assumptions[f.key] ?? 0}
            onValue={(n) => setAssumptions({ ...assumptions, [f.key]: n })}
          />
        ) : (
          <input
            type="number"
            step="any"
            className={warn ? "input-warn" : undefined}
            value={toDisplay(f.type, assumptions[f.key] ?? 0)}
            onChange={(e) => setAssumptions({ ...assumptions, [f.key]: fromDisplay(f.type, e.target.value) })}
          />
        )}
        {warn ? (
          <span className="hint warn">⚠ {warn}</span>
        ) : (
          <>
            {overridden && <span className="hint warn">overridden by tax brackets (Events &amp; Taxes)</span>}
            {derived && <span className="hint derived">{derived}</span>}
            {f.hint && <span className="hint">{f.hint}</span>}
          </>
        )}
      </div>
    );
  };

  const summarize = (g: Group) => {
    if (!defaults) return "";
    const changed = g.fields.filter((f) => (assumptions[f.key] ?? 0) !== (defaults[f.key] ?? 0));
    const parts = changed.slice(0, 2).map((f) => `${f.label} ${shortValue(f, assumptions[f.key])}`);
    if (changed.length > 2) parts.push(`+${changed.length - 2} more`);
    if (g.widget === "withdrawal-order") {
      const ORDER: [string, string][] = [
        ["order_cash", "Cash"], ["order_taxable", "Taxable"],
        ["order_deferred", "Deferred"], ["order_roth", "Roth"],
      ];
      const seq = [...ORDER].sort((a, b) => (assumptions[a[0]] ?? 99) - (assumptions[b[0]] ?? 99));
      const custom = ORDER.some(([k]) => (assumptions[k] ?? 0) !== (defaults[k] ?? 0));
      if (custom) parts.push(seq.map(([, l]) => l).join(" → "));
    }
    if (parts.length === 0) return "using defaults";
    return parts.join(" · ");
  };

  return (
    <>
      {!hasData && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          <span>ℹ️</span>
          <span>No transactions imported yet — the projection starts from a $0 balance. Import a report to seed it with your real balance.</span>
        </div>
      )}

      {/* Headline results stay visible while you edit */}
      <div className="proj-sticky">
        <div>
          <div className="k">Portfolio at retirement</div>
          <div className="v">
            {proj ? usd(proj.summary.portfolio_at_retirement) : "—"}
            {delta !== null && (
              <span className={delta >= 0 ? "pos" : "neg"} style={{ fontSize: 12, fontWeight: 700, marginLeft: 8 }}>
                {delta >= 0 ? "▲" : "▼"} {usdCompact(Math.abs(delta))}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="k">Withdrawal rate</div>
          <div className="v" style={{ color: proj && proj.summary.withdrawal_rate > 0.04 ? "var(--red)" : "var(--green)" }}>
            {proj ? pct(proj.summary.withdrawal_rate) : "—"}
          </div>
        </div>
        <div>
          <div className="k">Lasts to {assumptions.life_expectancy}?</div>
          <div className="v">
            {proj ? (
              proj.summary.money_lasts ? (
                <span className="chip green" style={{ fontSize: 15, padding: "3px 11px" }}>YES</span>
              ) : (
                <span className="chip red" style={{ fontSize: 15, padding: "3px 11px" }}>
                  depletes @ {proj.summary.depleted_age}
                </span>
              )
            ) : "—"}
          </div>
        </div>
        {mc && (
          <div>
            <div className="k">Monte Carlo</div>
            <div
              className="v"
              style={{ color: mc.success_rate >= 0.85 ? "var(--green)" : mc.success_rate >= 0.7 ? "var(--amber)" : "var(--red)" }}
            >
              {pct(mc.success_rate, 0)}
            </div>
          </div>
        )}
        <div className="right">
          <span className="calc-status">
            <span className={`calc-dot ${busy || pending ? "working" : ""}`} />
            {status}
          </span>
          <label className="toggle">
            <input type="checkbox" checked={realDollars} onChange={(e) => setRealDollars(e.target.checked)} />
            Today's dollars
          </label>
        </div>
      </div>

      <div className="proj-layout">
        {/* ---------- Assumptions ---------- */}
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>Assumptions</h3>
          <p className="sub" style={{ marginTop: 0, marginBottom: 14 }}>
            Changes apply automatically. Open a section to fine-tune.
          </p>

          <div className="field-grid" style={{ marginBottom: 18 }}>
            {ESSENTIALS.map(renderField)}
          </div>

          {ADVANCED.map((g) => (
            <details className="adv" key={g.title}>
              <summary>
                <span className="chev">▶</span>
                <span className="title">{g.title}</span>
                <span className="sum">{summarize(g)}</span>
              </summary>
              <div className="adv-body">
                <div className="field-grid">{g.fields.map(renderField)}</div>
                {g.widget === "withdrawal-order" && (
                  <>
                    <div className="wd-head">
                      <span>Withdrawal order</span>
                      <InfoTip
                        align="left"
                        text="Drag (or use ▲/▼) to set which buckets are spent first in retirement. Top = drawn first. The default tax-smart order spends cash and taxable money before tax-deferred, leaving Roth to compound tax-free longest. RMDs are still forced from tax-deferred buckets at 73+ regardless of this order."
                      />
                    </div>
                    <WithdrawalOrder
                      assumptions={assumptions}
                      onReorder={(patch) => setAssumptions({ ...assumptions, ...patch })}
                    />
                  </>
                )}
              </div>
            </details>
          ))}
        </div>

        {/* ---------- Results ---------- */}
        <div className="grid" style={{ gap: 16 }}>
          {cashInfo && (
            <div className="banner warn">
              <span>⚠️</span>
              <span>
                <strong>Withdrawals exceed spending.</strong> About {usd(cashInfo.avgSurplus)}/yr is
                withdrawn beyond what you spend and kept as cash (it grows to {usd(cashInfo.endCash)}
                {proj?.real_dollars ? " in today's dollars" : ""} by age {assumptions.life_expectancy},
                shown in amber below). This happens because your <em>“After SS starts”</em> withdrawal
                exceeds your need — lower it toward about {usd(cashInfo.suggested)} to withdraw only
                what you spend.
              </span>
            </div>
          )}
          {proj && (
            <>
              <div className="card">
                <h3>
                  Projected balance{proj.real_dollars ? " (today's dollars)" : ""}
                  {cashInfo && <span className="sub"> — green total, amber = cash from over-withdrawal</span>}
                </h3>
                <ResponsiveContainer width="100%" height={330}>
                  <AreaChart data={chartData} margin={{ left: 8, right: 12, top: 20, bottom: 6 }}>
                    <defs>
                      <linearGradient id="gBal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={c.green} stopOpacity={0.5} />
                        <stop offset="100%" stopColor={c.green} stopOpacity={0.03} />
                      </linearGradient>
                      <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={c.amber} stopOpacity={0.4} />
                        <stop offset="100%" stopColor={c.amber} stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={c.grid} vertical={false} />
                    <XAxis dataKey="age" tick={{ stroke: c.axis, fontSize: 12 }} />
                    <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={62} />
                    <Tooltip
                      formatter={(v: number, n) => [usd(v), n === "cash" ? "Cash savings" : "Total balance"]}
                      labelFormatter={(a) => `Age ${a}`}
                      contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
                    />
                    <ReferenceLine
                      x={retAge}
                      stroke={c.amber}
                      strokeDasharray="4 4"
                      label={{ value: "Retire", fill: c.amber, fontSize: 11, position: "insideTop", dy: -14 }}
                    />
                    <Area type="monotone" dataKey="balance" stroke={c.green} fill="url(#gBal)" strokeWidth={2.4} isAnimationActive={false} />
                    {cashInfo && (
                      <Area type="monotone" dataKey="cash" stroke={c.amber} fill="url(#gCash)" strokeWidth={1.8} isAnimationActive={false} />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {mc && (
                <div className="card">
                  <h3>
                    Monte Carlo — {mc.n_sims.toLocaleString()} randomized market simulations
                    <InfoTip align="left" text="Instead of one fixed return, this runs your plan thousands of times with random year-to-year returns and reports how often the money lasted." />
                  </h3>
                  <div className="gauge-wrap">
                    <Gauge value={mc.success_rate} />
                    <div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        of simulations funded spending through age {assumptions.life_expectancy}.
                      </div>
                      <div style={{ marginTop: 14, display: "flex", gap: 22, flexWrap: "wrap" }}>
                        <Pctile label="Unlucky (10th %)" v={mc.retirement_balance_percentiles.p10} />
                        <Pctile label="Median (50th %)" v={mc.retirement_balance_percentiles.p50} />
                        <Pctile label="Lucky (90th %)" v={mc.retirement_balance_percentiles.p90} />
                      </div>
                      <div className="sub" style={{ marginTop: 8 }}>Range of portfolio value at retirement across outcomes.</div>
                    </div>
                  </div>
                </div>
              )}

              {proj.drawdown.length > 0 && (
                <div className="card">
                  <h3 style={{ marginBottom: 4 }}>
                    Year-by-year retirement detail{proj.real_dollars ? " (today's dollars)" : ""}
                    <InfoTip align="left" text="Each retirement year: the gross withdrawal, the income tax paid on it (401(k)/other income + capital gains + Social Security tax, after any tax-free exclusion), Social Security received, what's left after tax, your spending, and the ending balance." />
                  </h3>
                  <p className="sub" style={{ marginTop: 0, marginBottom: 12 }}>
                    Total income tax over retirement: <strong>{usd(totalTax)}</strong>
                    {" · "}first-year effective rate {proj.drawdown[0].withdrawal > 0 ? pct(taxOf(proj.drawdown[0]) / proj.drawdown[0].withdrawal, 1) : "0%"}.
                  </p>
                  <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th className="num">Age</th>
                          <th className="num">Withdrawal</th>
                          <th className="num">Taxes</th>
                          <th className="num">Soc. Sec.</th>
                          <th className="num">After-tax</th>
                          <th className="num">Spending</th>
                          <th className="num">End balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proj.drawdown.map((r) => (
                          <tr key={r.age}>
                            <td className="num">{r.age}</td>
                            <td className="num">{usd(r.withdrawal)}</td>
                            <td className="num" style={{ color: taxOf(r) > 0 ? "var(--amber)" : undefined }}>{usd(taxOf(r))}</td>
                            <td className="num">{r.social_security ? usd(r.social_security) : "—"}</td>
                            <td className="num">{usd(r.after_tax_income)}</td>
                            <td className="num">{usd(r.spending)}</td>
                            <td className="num">{usd(r.end_balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          {!proj && <div className="center-load"><div className="spinner" /> Running projection…</div>}
        </div>
      </div>
    </>
  );
}

/** Total income tax for a drawdown year (income tax + capital gains + SS tax). */
function taxOf(r: { tax_401k?: number; tax_capgains?: number; tax_ss?: number; tax_other?: number }): number {
  return (r.tax_401k ?? 0) + (r.tax_capgains ?? 0) + (r.tax_ss ?? 0) + (r.tax_other ?? 0);
}

function Pctile({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{usdCompact(v)}</div>
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const cc = useChartColors();
  const r = 52;
  const circ = 2 * Math.PI * r;
  const dash = circ * value;
  const color = value >= 0.85 ? cc.green : value >= 0.7 ? cc.amber : cc.red;
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" style={{ stroke: "var(--border)" }} strokeWidth="12" />
      <circle
        cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`} transform="rotate(-90 65 65)"
      />
      <text x="65" y="72" textAnchor="middle" fontSize="26" fontWeight="700" style={{ fill: "var(--text)" }}>
        {Math.round(value * 100)}
      </text>
    </svg>
  );
}
