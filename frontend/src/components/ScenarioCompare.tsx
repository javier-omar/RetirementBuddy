import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
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
import type { Assumptions, ProjectionResult, SavedScenario } from "../types";
import { pct, usd, usdCompact } from "../format";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";
import { useChartColors } from "../theme";

/** Colors for scenario series; the base plan gets a neutral gray of its own. */
const PALETTE = ["#4f9dff", "#35c88a", "#ffb454", "#ff6b6b", "#7c5cff", "#22c1c3"];
const BASE_COLOR = "#93a3bd";
const BASE_ID = "base";

/** The handful of assumptions worth varying between plans. `pct` fields are
 * stored as fractions (0.08) but edited as whole percents (8). */
type FieldKind = "money" | "pct" | "age";
const FIELDS: { key: string; label: string; kind: FieldKind }[] = [
  { key: "retirement_age", label: "Retirement age", kind: "age" },
  { key: "annual_spending", label: "Annual spending", kind: "money" },
  { key: "nominal_return", label: "Return", kind: "pct" },
  { key: "inflation", label: "Inflation", kind: "pct" },
  { key: "employee_contrib_pct", label: "Contribution", kind: "pct" },
  { key: "current_salary", label: "Salary", kind: "money" },
  { key: "ss_claim_age", label: "SS claim age", kind: "age" },
  { key: "life_expectancy", label: "Plan to age", kind: "age" },
];

/** Total income tax across a scenario's retirement years. */
function taxOf(r: { tax_401k?: number; tax_capgains?: number; tax_ss?: number; tax_other?: number }): number {
  return (r.tax_401k ?? 0) + (r.tax_capgains ?? 0) + (r.tax_ss ?? 0) + (r.tax_other ?? 0);
}
function lifetimeTax(r: ProjectionResult): number {
  return r.drawdown.reduce((s, row) => s + taxOf(row), 0);
}

/** One continuous balance-by-age line: saving years then drawdown years. */
function balanceByAge(r: ProjectionResult): { age: number; balance: number }[] {
  const out = new Map<number, number>();
  for (const x of r.accumulation) out.set(x.age, x.end_balance);
  for (const x of r.drawdown) out.set(x.age, x.end_balance); // drawdown wins at the boundary
  return [...out.entries()].map(([age, balance]) => ({ age, balance })).sort((a, b) => a.age - b.age);
}

interface Series { id: string; name: string; color: string; result: ProjectionResult }

export default function ScenarioCompare({ hasData }: { hasData: boolean }) {
  const [base, setBase] = useState<Assumptions | null>(null);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeBase, setIncludeBase] = useState(true);
  const [realDollars, setRealDollars] = useState(false);
  const [results, setResults] = useState<Series[]>([]);
  const [showTable, setShowTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const didInit = useRef(false);
  const c = useChartColors();

  // Load base plan + saved scenarios once.
  useEffect(() => {
    Promise.all([api.assumptions(), api.savedScenarios()]).then(([a, scs]) => {
      setBase(a.assumptions);
      setScenarios(scs);
      setSelected(new Set(scs.map((s) => s.id))); // compare everything by default
    });
  }, []);

  const colorForIndex = (i: number) => PALETTE[i % PALETTE.length];

  async function recompute(
    scs = scenarios,
    sel = selected,
    withBase = includeBase,
    real = realDollars,
  ) {
    if (!base) return;
    setBusy(true);
    try {
      const jobs: { id: string; name: string; color: string; overrides: Assumptions }[] = [];
      if (withBase) jobs.push({ id: BASE_ID, name: "Base plan", color: BASE_COLOR, overrides: {} });
      scs.forEach((s, i) => {
        if (sel.has(s.id)) jobs.push({ id: `s${s.id}`, name: s.name, color: colorForIndex(i), overrides: s.overrides });
      });
      const out = await Promise.all(
        jobs.map(async (j) => ({ ...j, result: await api.projection(j.overrides, real) })),
      );
      setResults(out);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (base && !didInit.current) {
      didInit.current = true;
      recompute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Persist scenario edits and re-run the comparison.
  function commit(next: SavedScenario[], sel = selected, withBase = includeBase, real = realDollars) {
    setScenarios(next);
    api.saveScenarios(next).then((saved) => {
      // saveScenarios assigns ids to brand-new rows; adopt them so selection lines up.
      if (saved.some((s, i) => s.id !== next[i]?.id)) {
        setScenarios(saved);
        const remapped = new Set<number>();
        next.forEach((n, i) => { if (sel.has(n.id)) remapped.add(saved[i].id); });
        setSelected(remapped);
        recompute(saved, remapped, withBase, real);
      } else {
        recompute(next, sel, withBase, real);
      }
    });
  }

  function addScenario() {
    const n = scenarios.length + 1;
    const next = [...scenarios, { id: -Date.now(), name: `Scenario ${n}`, overrides: {} }];
    const sel = new Set(selected); sel.add(next[next.length - 1].id);
    setSelected(sel);
    commit(next, sel);
  }
  function removeScenario(id: number) {
    const next = scenarios.filter((s) => s.id !== id);
    const sel = new Set(selected); sel.delete(id);
    setSelected(sel);
    commit(next, sel);
  }
  function rename(id: number, name: string) {
    setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }
  function setField(id: number, key: string, kind: FieldKind, raw: number) {
    if (!base) return;
    const stored = kind === "pct" ? raw / 100 : raw;
    const baseVal = base[key] ?? 0;
    const next = scenarios.map((s) => {
      if (s.id !== id) return s;
      const ov = { ...s.overrides };
      if (Math.abs(stored - baseVal) < 1e-9) delete ov[key];
      else ov[key] = stored;
      return { ...s, overrides: ov };
    });
    commit(next);
  }
  function resetField(id: number, key: string) {
    const next = scenarios.map((s) => {
      if (s.id !== id) return s;
      const ov = { ...s.overrides }; delete ov[key];
      return { ...s, overrides: ov };
    });
    commit(next);
  }

  function toggleSelect(id: number) {
    const sel = new Set(selected);
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    setSelected(sel);
    recompute(scenarios, sel);
  }

  // Effective (displayed) value for a field: the override, or the base value.
  const shownValue = (s: SavedScenario, key: string, kind: FieldKind): number => {
    const v = s.overrides[key] ?? base?.[key] ?? 0;
    return kind === "pct" ? Math.round(v * 1000) / 10 : v;
  };

  const chartData = useMemo(() => {
    const byAge = new Map<number, Record<string, number>>();
    for (const s of results) {
      for (const pt of balanceByAge(s.result)) {
        const e = byAge.get(pt.age) ?? { age: pt.age };
        e[s.id] = pt.balance;
        byAge.set(pt.age, e);
      }
    }
    return [...byAge.values()].sort((a, b) => a.age - b.age);
  }, [results]);

  // Union of ages for the year-by-year table.
  const tableAges = useMemo(() => {
    const set = new Set<number>();
    for (const s of results) for (const pt of balanceByAge(s.result)) set.add(pt.age);
    return [...set].sort((a, b) => a - b);
  }, [results]);
  const balanceLookup = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    for (const s of results) m.set(s.id, new Map(balanceByAge(s.result).map((p) => [p.age, p.balance])));
    return m;
  }, [results]);

  if (!base) return <div className="center-load"><div className="spinner" /> Loading…</div>;

  const baseSeries = results.find((s) => s.id === BASE_ID);
  const retAge = Math.trunc(base.retirement_age);

  // Delta of a scenario metric vs the base plan (null when base isn't shown).
  const deltaMoney = (v: number, baseVal: number | undefined) =>
    baseVal === undefined ? null : v - baseVal;

  return (
    <>
      {!hasData && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          <span>ℹ️</span>
          <span>No transactions imported — scenarios start from a $0 balance. Import a report to use your real numbers.</span>
        </div>
      )}

      {/* Intro + global toggles */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>
              Compare scenarios
              <InfoTip align="left" text="Save named what-if variants of your plan — retire earlier, spend less, assume a lower return — and lay them over your base plan. Each scenario only stores the fields you change; everything else tracks your live plan." />
            </h3>
            <div className="sub">
              Each scenario overrides just the fields you edit; every other assumption follows your base plan (the one on the other tabs).
            </div>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={includeBase}
                onChange={(e) => { setIncludeBase(e.target.checked); recompute(scenarios, selected, e.target.checked); }}
              />
              Show base plan
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={realDollars}
                onChange={(e) => { setRealDollars(e.target.checked); recompute(scenarios, selected, includeBase, e.target.checked); }}
              />
              Today's dollars
              <InfoTip align="right" text="Restates future balances in today's purchasing power, so they're comparable to what money buys now." />
            </label>
          </div>
        </div>
      </div>

      {/* Scenario editors */}
      <div className="scenario-grid" style={{ marginBottom: 16 }}>
        {scenarios.map((s, i) => {
          const color = colorForIndex(i);
          const on = selected.has(s.id);
          return (
            <div key={s.id} className="card" style={{ borderTop: `3px solid ${color}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleSelect(s.id)}
                  title={on ? "Included in comparison" : "Hidden from comparison"}
                  style={{ accentColor: color, width: 16, height: 16, flex: "none" }}
                />
                <input
                  value={s.name}
                  onChange={(e) => rename(s.id, e.target.value)}
                  onBlur={() => commit(scenarios)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  style={{
                    flex: 1, minWidth: 0, background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
                    color: "var(--text)", fontSize: 15, fontWeight: 700, padding: "2px 0",
                  }}
                />
                <button className="icon-btn" title="Delete scenario" onClick={() => removeScenario(s.id)}>✕</button>
              </div>
              <div className="sc-fields">
                {FIELDS.map((f) => {
                  const overridden = f.key in s.overrides;
                  const val = shownValue(s, f.key, f.kind);
                  return (
                    <div className="field" key={f.key}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ color: overridden ? "var(--accent)" : undefined, fontWeight: overridden ? 700 : undefined }}>
                          {f.label}
                        </span>
                        {overridden && (
                          <button
                            className="link-reset"
                            title="Reset to base plan"
                            onClick={() => resetField(s.id, f.key)}
                          >↺</button>
                        )}
                      </label>
                      {f.kind === "money" ? (
                        <MoneyInput
                          value={val}
                          onValue={() => { /* commit on blur */ }}
                          onCommit={(n) => setField(s.id, f.key, f.kind, n)}
                          style={inputStyle(overridden)}
                        />
                      ) : (
                        <input
                          type="number"
                          step={f.kind === "pct" ? 0.5 : 1}
                          defaultValue={val}
                          key={`${s.id}-${f.key}-${val}`}
                          onBlur={(e) => setField(s.id, f.key, f.kind, parseFloat(e.target.value) || 0)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          style={inputStyle(overridden)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <button className="card add-scenario" onClick={addScenario}>
          <span style={{ fontSize: 26, lineHeight: 1 }}>＋</span>
          <span>Add scenario</span>
        </button>
      </div>

      {results.length === 0 ? (
        <div className="center-load">
          {busy ? <><div className="spinner" /> Comparing…</> : "Select at least one scenario (or the base plan) to compare."}
        </div>
      ) : (
        <>
          {/* Overlay chart */}
          <div className="card">
            <h3>
              Portfolio balance over time{realDollars ? " (today's dollars)" : ""}
              <InfoTip align="left" text="Your balance across the saving years and then through retirement, one line per scenario. Where a line dives to zero, that plan runs out of money." />
            </h3>
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={chartData} margin={{ left: 8, right: 12, top: 22 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]}
                  tick={{ stroke: c.axis, fontSize: 12 }} />
                <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={62} />
                <Tooltip
                  formatter={(v: number, n) => [usd(v), n as string]}
                  labelFormatter={(a) => `Age ${a}`}
                  contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
                />
                <Legend />
                <ReferenceLine y={0} stroke={c.red} strokeDasharray="3 3" />
                <ReferenceLine x={retAge} stroke={c.axis} strokeDasharray="4 4"
                  label={{ value: "Retirement", fill: c.axis, fontSize: 11, position: "insideTop" }} />
                {results.map((s) => (
                  <Line key={s.id} type="monotone" dataKey={s.id} name={s.name} stroke={s.color}
                    strokeWidth={s.id === BASE_ID ? 2.4 : 2} strokeDasharray={s.id === BASE_ID ? "5 4" : undefined}
                    dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Metric comparison */}
          <div className="card" style={{ marginTop: 16 }}>
            <h3>How the scenarios stack up</h3>
            <div style={{ overflowX: "auto" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {results.map((s) => (
                      <th key={s.id} className="num">
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: "inline-block", marginRight: 6 }} />
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <MetricRow label="Portfolio at retirement" results={results} baseSeries={baseSeries}
                    get={(r) => r.summary.portfolio_at_retirement} fmt={usd} delta={deltaMoney} />
                  <MetricRow label={`Left at age ${Math.trunc(base.life_expectancy)}`} results={results} baseSeries={baseSeries}
                    get={(r) => r.summary.ending_balance} fmt={usd} delta={deltaMoney} />
                  <MetricRow label="Lifetime tax paid" results={results} baseSeries={baseSeries}
                    get={lifetimeTax} fmt={usd} delta={deltaMoney} invertDelta />
                  <tr>
                    <td>Money lasts</td>
                    {results.map((s) => (
                      <td key={s.id} className="num">
                        {s.result.summary.money_lasts
                          ? <span className="chip green">to {Math.trunc(s.result.assumptions.life_expectancy)}+</span>
                          : <span className="chip red">depletes @ {s.result.summary.depleted_age}</span>}
                      </td>
                    ))}
                  </tr>
                  <MetricRow label="Initial withdrawal rate" results={results} baseSeries={baseSeries}
                    get={(r) => r.summary.withdrawal_rate} fmt={(v) => pct(v)} />
                </tbody>
              </table>
            </div>
            {baseSeries && (
              <div className="sub" style={{ marginTop: 10 }}>
                Green/red figures under each scenario are the change versus your base plan.
              </div>
            )}
          </div>

          {/* Year-by-year toggle */}
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>
                Year-by-year balances{realDollars ? " (today's dollars)" : ""}
              </h3>
              <button className="btn ghost sm" onClick={() => setShowTable((v) => !v)}>
                {showTable ? "Hide table" : "Show table"}
              </button>
            </div>
            {showTable && (
              <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto", marginTop: 12 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">Age</th>
                      {results.map((s) => (
                        <th key={s.id} className="num">
                          <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: "inline-block", marginRight: 6 }} />
                          {s.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableAges.map((age) => (
                      <tr key={age}>
                        <td className="num">{age}</td>
                        {results.map((s) => {
                          const v = balanceLookup.get(s.id)?.get(age);
                          return (
                            <td key={s.id} className="num" style={{ color: v !== undefined && v <= 0 ? "var(--red)" : undefined }}>
                              {v === undefined ? "—" : usd(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function inputStyle(overridden: boolean): React.CSSProperties {
  return {
    width: "100%", minWidth: 0, boxSizing: "border-box", background: "var(--input-bg)", borderRadius: 8,
    color: "var(--text)", padding: "7px 9px",
    border: `1px solid ${overridden ? "var(--accent)" : "var(--border)"}`,
  };
}

/** A metric row: value per scenario plus its delta vs the base plan. */
function MetricRow({
  label, results, baseSeries, get, fmt, delta, invertDelta = false,
}: {
  label: string;
  results: Series[];
  baseSeries: Series | undefined;
  get: (r: ProjectionResult) => number;
  fmt: (v: number) => string;
  delta?: (v: number, baseVal: number | undefined) => number | null;
  invertDelta?: boolean;
}) {
  const baseVal = baseSeries ? get(baseSeries.result) : undefined;
  return (
    <tr>
      <td>{label}</td>
      {results.map((s) => {
        const v = get(s.result);
        const d = delta && s.id !== BASE_ID ? delta(v, baseVal) : null;
        // For "good", higher is usually better; for tax, lower is better (invertDelta).
        const good = d === null ? false : invertDelta ? d < 0 : d > 0;
        const bad = d === null ? false : invertDelta ? d > 0 : d < 0;
        return (
          <td key={s.id} className="num">
            <div>{fmt(v)}</div>
            {d !== null && Math.abs(d) >= 1 && (
              <div style={{ fontSize: 11, fontWeight: 600, color: good ? "var(--green)" : bad ? "var(--red)" : "var(--muted)" }}>
                {d > 0 ? "+" : "−"}{fmt(Math.abs(d))}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}
