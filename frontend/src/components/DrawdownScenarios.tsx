import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { Assumptions, DrawdownScenariosResult, ScenarioInput } from "../types";
import { pct, usd, usdCompact } from "../format";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";
import { useChartColors } from "../theme";

interface ScenarioConfig {
  label: string;
  ret: number; // percent
  color: string;
  enabled: boolean;
}

const PALETTE = ["#35c88a", "#4f9dff", "#ffb454", "#ff6b6b", "#7c5cff"];

/** Total income tax for a drawdown year (income tax + capital gains + SS tax). */
function taxOf(r: { tax_401k?: number; tax_capgains?: number; tax_ss?: number; tax_other?: number }): number {
  return (r.tax_401k ?? 0) + (r.tax_capgains ?? 0) + (r.tax_ss ?? 0) + (r.tax_other ?? 0);
}

export default function DrawdownScenarios({ hasData }: { hasData: boolean }) {
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioConfig[]>([]);
  const [bridge, setBridge] = useState(0);
  const [postSs, setPostSs] = useState(0);
  const [fixedStart, setFixedStart] = useState(true);
  const [realDollars, setRealDollars] = useState(false);
  const [indexInflation, setIndexInflation] = useState(true);
  const [ssFromTable, setSsFromTable] = useState<number | null>(null);
  const [result, setResult] = useState<DrawdownScenariosResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailIdx, setDetailIdx] = useState(0);
  const didInit = useRef(false);
  const c = useChartColors();

  // Load assumptions and seed default scenarios from the expected return.
  useEffect(() => {
    api.assumptions().then((r) => {
      const a = r.assumptions;
      setAssumptions(a);
      const base = Math.round(a.nominal_return * 100);
      setScenarios([
        { label: "Optimistic", ret: base + 2, color: PALETTE[0], enabled: true },
        { label: "Expected", ret: base, color: PALETTE[1], enabled: true },
        { label: "Conservative", ret: base - 2, color: PALETTE[2], enabled: true },
        { label: "Stress", ret: 3, color: PALETTE[3], enabled: true },
      ]);
      setBridge(a.bridge_withdrawal);
      setPostSs(a.post_ss_withdrawal);
      setIndexInflation((a.index_to_inflation ?? 1) === 1);
      setSsFromTable(r.ss_benefit_from_table);
    });
  }, []);

  async function recalc(
    scs = scenarios,
    b = bridge,
    p = postSs,
    fixed = fixedStart,
    real = realDollars,
    idx = indexInflation
  ) {
    const active = scs.filter((s) => s.enabled);
    if (active.length === 0) {
      setResult(null);
      return;
    }
    setBusy(true);
    try {
      const payload: ScenarioInput[] = active.map((s) => ({
        name: `${s.label} · ${s.ret}%`,
        overrides: {
          nominal_return: s.ret / 100,
          bridge_withdrawal: b,
          post_ss_withdrawal: p,
        },
      }));
      const res = await api.drawdownScenarios(
        payload,
        { index_to_inflation: idx ? 1 : 0 },
        real,
        fixed
      );
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (assumptions && scenarios.length && !didInit.current) {
      didInit.current = true;
      recalc();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assumptions, scenarios]);

  // Reshape drawdown rows into one row per age with a column per scenario.
  const chartData = useMemo(() => {
    if (!result) return [];
    const byAge = new Map<number, Record<string, number | null>>();
    for (const s of result.scenarios) {
      for (const row of s.drawdown) {
        const entry = byAge.get(row.age) ?? { age: row.age };
        entry[s.name] = row.end_balance;
        byAge.set(row.age, entry);
      }
    }
    return [...byAge.values()].sort((a, b) => (a.age as number) - (b.age as number));
  }, [result]);

  // Income composition (net-of-tax) for the first enabled scenario.
  const incomeData = useMemo(() => {
    if (!result || result.scenarios.length === 0) return [];
    return result.scenarios[0].drawdown.map((r) => ({
      age: r.age,
      withdrawal: Math.max(r.withdrawal - r.tax_401k, 0),
      socialSecurity: Math.max(r.social_security - r.tax_ss, 0),
      spending: r.spending,
    }));
  }, [result]);

  if (!assumptions) return <div className="center-load"><div className="spinner" /> Loading…</div>;

  const colorFor = (name: string) => {
    const label = name.split(" · ")[0];
    return scenarios.find((s) => s.label === label)?.color ?? "#888";
  };

  return (
    <>
      {!hasData && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          <span>ℹ️</span>
          <span>No transactions imported — scenarios start from a $0 balance. Import a report to use your real balance.</span>
        </div>
      )}

      {/* Controls */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>
              Drawdown scenarios
              <InfoTip align="left" text="How your savings get spent down in retirement. Each line is a different return assumption applied to the same starting balance, so the gaps between them show sequence-of-returns risk — the danger of hitting weak markets early in retirement." />
            </h3>
            <div className="sub">
              Every scenario starts from the same {result ? usd(result.base_portfolio_at_retirement) : "…"} nest egg at age {assumptions.retirement_age},
              then draws down under a different assumption — so you see retirement (sequence) risk in isolation.
            </div>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={fixedStart}
                onChange={(e) => { setFixedStart(e.target.checked); recalc(scenarios, bridge, postSs, e.target.checked, realDollars); }}
              />
              Same starting nest egg
              <InfoTip align="right" text="On: every scenario begins from the identical retirement balance, so differences come purely from retirement-era returns. Off: each scenario also re-runs your saving years at its own return." />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={indexInflation}
                onChange={(e) => { setIndexInflation(e.target.checked); recalc(scenarios, bridge, postSs, fixedStart, realDollars, e.target.checked); }}
              />
              Inflation-index withdrawals
              <InfoTip align="right" text="Grow withdrawals, Social Security, and spending with inflation so their buying power stays constant. This is more realistic and usually more conservative." />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={realDollars}
                onChange={(e) => { setRealDollars(e.target.checked); recalc(scenarios, bridge, postSs, fixedStart, e.target.checked); }}
              />
              Today's dollars
              <InfoTip align="right" text="Restates future balances in today's purchasing power, so they're comparable to what money buys now." />
            </label>
          </div>
        </div>

        <div className="two-col" style={{ marginTop: 16 }}>
          <div>
            <div className="section-title" style={{ margin: "0 0 8px" }}>Return scenarios</div>
            {scenarios.map((s, i) => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => {
                    const next = [...scenarios];
                    next[i] = { ...s, enabled: e.target.checked };
                    setScenarios(next);
                    recalc(next);
                  }}
                  style={{ accentColor: s.color, width: 16, height: 16 }}
                />
                <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: "inline-block" }} />
                <span style={{ width: 108, fontSize: 14 }}>{s.label}</span>
                <input
                  type="number"
                  step="0.5"
                  value={s.ret}
                  onChange={(e) => {
                    const next = [...scenarios];
                    next[i] = { ...s, ret: parseFloat(e.target.value) || 0 };
                    setScenarios(next);
                  }}
                  onBlur={() => recalc()}
                  style={{
                    width: 74, background: "var(--input-bg)", borderRadius: 8, color: "var(--text)", padding: "6px 9px",
                    border: `1px solid ${s.ret > 15 || s.ret < -5 ? "rgba(255,180,84,0.65)" : "var(--border)"}`,
                  }}
                />
                <span className="sub">% return</span>
                {(s.ret > 15 || s.ret < -5) && (
                  <span className="hint warn" style={{ fontSize: 11, color: "var(--amber)", fontWeight: 600 }}>
                    ⚠ unusually {s.ret > 15 ? "high" : "low"} — typo?
                  </span>
                )}
              </div>
            ))}
          </div>
          <div>
            <div className="section-title" style={{ margin: "0 0 8px" }}>Annual withdrawal (applied to all)</div>
            <div className="field-grid">
              <div className="field">
                <label>Before SS starts ($)</label>
                <MoneyInput value={bridge} onValue={setBridge} onCommit={() => recalc()} />
              </div>
              <div className="field">
                <label>After SS starts ($)</label>
                <MoneyInput value={postSs} onValue={setPostSs} onCommit={() => recalc()} />
              </div>
            </div>
            <div className="sub" style={{ marginTop: 10 }}>
              SS of {usd(ssFromTable ?? assumptions.ss_annual_benefit)}/yr begins at age {assumptions.ss_claim_age}
              {ssFromTable !== null && " (from your SS table)"}. Spending target {usd(assumptions.annual_spending)}/yr.
            </div>
            <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={() => recalc()}>
              {busy ? "Calculating…" : "Recalculate"}
            </button>
          </div>
        </div>
      </div>

      {result && result.scenarios.length > 0 && (
        <>
          {/* Balance comparison chart */}
          <div className="card">
            <h3>Portfolio balance through retirement{result.real_dollars ? " (today's dollars)" : ""}</h3>
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData} margin={{ left: 8, right: 12, top: 22 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="age" tick={{ stroke: c.axis, fontSize: 12 }} />
                <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={62} />
                <Tooltip
                  formatter={(v: number, n) => [usd(v), n as string]}
                  labelFormatter={(a) => `Age ${a}`}
                  contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
                />
                <Legend />
                <ReferenceLine y={0} stroke={c.red} strokeDasharray="3 3" />
                {result.ss_claim_age >= result.retirement_age && result.ss_claim_age <= result.life_expectancy && (
                  <ReferenceLine x={result.ss_claim_age} stroke={c.axis} strokeDasharray="4 4"
                    label={{ value: "SS starts", fill: c.axis, fontSize: 11, position: "insideTop" }} />
                )}
                {result.scenarios.map((s) => (
                  <Line key={s.name} type="monotone" dataKey={s.name} stroke={colorFor(s.name)}
                    strokeWidth={2.2} dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Summary table + income composition */}
          <div className="two-col" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>Outcome by scenario</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th className="num">Ends with</th>
                    <th className="num">Lasts to</th>
                  </tr>
                </thead>
                <tbody>
                  {result.scenarios.map((s) => (
                    <tr key={s.name}>
                      <td>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: colorFor(s.name), display: "inline-block", marginRight: 8 }} />
                        {s.name}
                      </td>
                      <td className="num">{usd(s.summary.ending_balance)}</td>
                      <td className="num">
                        {s.summary.money_lasts ? (
                          <span className="chip green">age {result.life_expectancy}+</span>
                        ) : (
                          <span className="chip red">depletes @ {s.summary.depleted_age}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="sub" style={{ marginTop: 10 }}>
                Initial withdrawal rate {pct(result.scenarios[0].summary.withdrawal_rate)} of the nest egg.
              </div>
            </div>

            <div className="card">
              <h3>Retirement income sources <span className="sub">(net of tax, {result.scenarios[0].name.split(" · ")[0]})</span></h3>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={incomeData} margin={{ left: 4, right: 8, top: 6 }}>
                  <defs>
                    <linearGradient id="gW" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={c.accent} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={c.accent} stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="gS" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={c.green} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={c.green} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="age" tick={{ stroke: c.axis, fontSize: 12 }} />
                  <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={54} />
                  <Tooltip
                    formatter={(v: number, n) => [
                      usd(v),
                      n === "withdrawal" ? "401(k) (after tax)" : n === "socialSecurity" ? "Social Security" : "Spending",
                    ]}
                    labelFormatter={(a) => `Age ${a}`}
                    contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
                  />
                  <Area type="monotone" dataKey="socialSecurity" stackId="i" stroke={c.green} fill="url(#gS)" strokeWidth={2} />
                  <Area type="monotone" dataKey="withdrawal" stackId="i" stroke={c.accent} fill="url(#gW)" strokeWidth={2} />
                  <Line type="monotone" dataKey="spending" stroke={c.amber} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="sub" style={{ marginTop: 6 }}>
                Blue = after-tax 401(k) withdrawal, green = Social Security, amber dashed = your spending target.
                Where the stack sits above the line, income covers spending.
              </div>
            </div>
          </div>

          {/* Year-by-year detail for one scenario */}
          {(() => {
            const sel = result.scenarios[Math.min(detailIdx, result.scenarios.length - 1)];
            if (!sel || sel.drawdown.length === 0) return null;
            const totalTax = sel.drawdown.reduce((s, r) => s + taxOf(r), 0);
            return (
              <div className="card" style={{ marginTop: 16 }}>
                <h3 style={{ marginBottom: 6 }}>
                  Year-by-year detail{result.real_dollars ? " (today's dollars)" : ""}
                  <InfoTip align="left" text="Each retirement year for the selected scenario: gross withdrawal, income tax paid on it (after any tax-free exclusion), Social Security, after-tax income, spending, and ending balance." />
                </h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  {result.scenarios.map((s, i) => (
                    <button
                      key={s.name}
                      onClick={() => setDetailIdx(i)}
                      className={`btn sm ${i === detailIdx ? "" : "ghost"}`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: colorFor(s.name), display: "inline-block" }} />
                      {s.name.split(" · ")[0]}
                    </button>
                  ))}
                </div>
                <p className="sub" style={{ marginTop: 0, marginBottom: 12 }}>
                  Total income tax over retirement: <strong>{usd(totalTax)}</strong>
                  {sel.drawdown[0].withdrawal > 0 ? ` · first-year effective rate ${pct(taxOf(sel.drawdown[0]) / sel.drawdown[0].withdrawal, 1)}` : ""}.
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
                      {sel.drawdown.map((r) => (
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
            );
          })()}
        </>
      )}
      {busy && !result && <div className="center-load"><div className="spinner" /> Running scenarios…</div>}
    </>
  );
}
