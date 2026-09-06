import { useEffect, useRef, useState } from "react";
import {
  Area,
  ComposedChart,
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
import type { CoastFireResult } from "../types";
import { usd, usdCompact } from "../format";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";
import { useChartColors } from "../theme";

export default function CoastFire({ hasData }: { hasData: boolean }) {
  const [cf, setCf] = useState<CoastFireResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [realDollars, setRealDollars] = useState(false);
  const [goalMode, setGoalMode] = useState<"auto" | "custom">("auto");
  const [goal, setGoal] = useState<number>(0);
  const didInit = useRef(false);
  const c = useChartColors();

  async function load(real = realDollars) {
    const res = await api.coastFire({}, real);
    setCf(res);
    if (!didInit.current) {
      didInit.current = true;
      setGoalMode(res.goal_source);
      setGoal(Math.round(res.retirement_goal_today));
    }
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyGoal(mode: "auto" | "custom", value?: number) {
    setBusy(true);
    try {
      const target = mode === "custom" ? (value ?? goal) : 0;
      await api.saveAssumptions({ retirement_goal_today: target });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleReal(v: boolean) {
    setRealDollars(v);
    setBusy(true);
    try {
      await load(v);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="center-load"><div className="spinner" /> Calculating Coast FIRE…</div>;
  if (!cf) return <div className="center-load">Couldn't load Coast FIRE.</div>;

  const progress = cf.coast_number_today > 0 ? Math.min(cf.current_balance / cf.coast_number_today, 1) : 1;
  const realTag = cf.real_dollars ? " (today's $)" : "";

  let verdict: { chip: string; chipClass: string; line: string };
  if (cf.is_coasting_now) {
    verdict = {
      chip: "COASTING",
      chipClass: "green",
      line: `You've reached Coast FIRE — your ${usd(cf.current_balance)} will grow to your ${usd(cf.required_nest_egg)}${realTag} goal by age ${cf.retirement_age} with no further contributions.`,
    };
  } else if (cf.fully_funded && cf.coast_age !== null) {
    verdict = {
      chip: `STOP AT ${cf.coast_age}`,
      chipClass: "amber",
      line: `Keep contributing for ${cf.years_until_coast} more year${cf.years_until_coast === 1 ? "" : "s"} — at age ${cf.coast_age} (${cf.coast_year}) you can stop, and growth alone carries you to the goal.`,
    };
  } else {
    verdict = {
      chip: "SHORTFALL",
      chipClass: "red",
      line: `On these assumptions, contributing all the way to retirement still falls ${usd(cf.required_nest_egg - cf.projected_nest_egg)}${realTag} short of the ${usd(cf.required_nest_egg)} goal. Raise contributions, retire later, trim spending, or lower the target.`,
    };
  }

  return (
    <>
      {!hasData && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          <span>ℹ️</span>
          <span>No transactions imported — this uses a $0 starting balance. Import a report to use your real balance.</span>
        </div>
      )}

      <div className="banner warn" style={{ marginBottom: 14 }}>
        <span>⚠️</span>
        <span>
          <strong>Coasting means stopping contributions, not stopping work.</strong> Your Social
          Security estimate assumes you keep earning until you claim, so these numbers hold if you
          stay employed and simply contribute less. If you stop working entirely, those zero-earning
          years lower your top-35 average and your actual benefit will come in below the figures on
          the Social Security tab.
        </span>
      </div>

      {/* Controls: goal editor + display toggle */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 20, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="section-title" style={{ margin: "0 0 8px" }}>
              Retirement goal
              <InfoTip align="left" text="Auto solves for the nest egg that funds your drawdown plan to life expectancy. Custom lets you set your own target number in today's dollars." />
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <label className="toggle" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="goalmode"
                  checked={goalMode === "auto"}
                  onChange={() => { setGoalMode("auto"); applyGoal("auto"); }}
                  style={{ accentColor: "var(--accent)", width: 16, height: 16 }}
                />
                Auto — fund my plan
              </label>
              <label className="toggle" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="goalmode"
                  checked={goalMode === "custom"}
                  onChange={() => { setGoalMode("custom"); applyGoal("custom", goal); }}
                  style={{ accentColor: "var(--accent)", width: 16, height: 16 }}
                />
                Custom target
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: goalMode === "custom" ? 1 : 0.45 }}>
                <span className="sub">$</span>
                <MoneyInput
                  value={goal}
                  disabled={goalMode !== "custom"}
                  onValue={setGoal}
                  onCommit={(n) => goalMode === "custom" && applyGoal("custom", n)}
                  style={{ width: 130, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", padding: "7px 10px" }}
                />
                <span className="sub">in today's dollars</span>
              </div>
            </div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={realDollars} onChange={(e) => toggleReal(e.target.checked)} />
            Show in today's dollars
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, opacity: busy ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>
            Coast FIRE
            <InfoTip align="left" text="Coast FIRE is the point where your invested balance is large enough that, with zero new contributions, normal market growth alone reaches your retirement goal on time. After that, you only need to cover current spending — retirement is on autopilot." />
          </h3>
          <span className={`chip ${verdict.chipClass}`} style={{ fontSize: 14, padding: "5px 12px" }}>{verdict.chip}</span>
        </div>
        <p style={{ marginBottom: 0, marginTop: 10, lineHeight: 1.5 }}>{verdict.line}</p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16, opacity: busy ? 0.6 : 1 }}>
        <div className="card stat">
          <div className="label">
            Coast number today
            <InfoTip align="left" text="The balance you'd need right now for growth alone (no more contributions) to reach the goal by your retirement age. Already in today's dollars." />
          </div>
          <div className="value">{usd(cf.coast_number_today)}</div>
          <div className={`delta ${cf.current_balance >= cf.coast_number_today ? "pos" : "muted"}`}>
            you have {usd(cf.current_balance)} · {Math.round(progress * 100)}% there
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            Retirement goal{realTag}
            <InfoTip align="left" text="The nest egg at retirement your plan targets. Auto = funds your drawdown to life expectancy; Custom = your own number." />
          </div>
          <div className="value">{usdCompact(cf.required_nest_egg)}</div>
          <div className="delta muted">
            {cf.goal_source === "custom" ? "custom" : "auto"} · at age {cf.retirement_age}
          </div>
        </div>
        <div className="card stat">
          <div className="label">If you keep contributing{realTag}</div>
          <div className="value">{usdCompact(cf.projected_nest_egg)}</div>
          <div className={`delta ${cf.fully_funded ? "pos" : "neg"}`}>
            {cf.fully_funded ? "clears the goal" : "below the goal"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Can stop contributing</div>
          <div className="value">
            {cf.is_coasting_now ? (
              <span className="chip green" style={{ fontSize: 18, padding: "4px 12px" }}>NOW</span>
            ) : cf.coast_age !== null ? (
              `age ${cf.coast_age}`
            ) : (
              <span className="chip red" style={{ fontSize: 16, padding: "4px 12px" }}>NOT YET</span>
            )}
          </div>
          <div className="delta muted">
            {cf.coast_age !== null ? `frees up ${usd(cf.annual_employee_contribution)}/yr` : "on this plan"}
          </div>
        </div>
      </div>

      <div className="card" style={{ opacity: busy ? 0.6 : 1 }}>
        <h3>
          Retirement balance by the age you stop contributing{realTag}
          <InfoTip align="left" text="Each point: if you keep contributing until that age and then stop, this is the balance you'd reach at retirement (growth continues either way). Where the curve crosses the goal line is your Coast FIRE age." />
        </h3>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={cf.curve} margin={{ left: 8, right: 14, top: 24, bottom: 24 }}>
            <defs>
              <linearGradient id="gCoast" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.accent} stopOpacity={0.45} />
                <stop offset="100%" stopColor={c.accent} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis
              dataKey="stop_age"
              height={44}
              tickMargin={8}
              tick={{ stroke: c.axis, fontSize: 12 }}
              label={{ value: "Age you stop contributing", position: "insideBottom", offset: -14, fill: c.axis, fontSize: 12 }}
            />
            <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={62} />
            <Tooltip
              formatter={(v: number) => [usd(v), "Balance at retirement"]}
              labelFormatter={(a) => `Stop at age ${a}`}
              contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
            />
            <ReferenceLine
              y={cf.required_nest_egg}
              stroke={c.amber}
              strokeDasharray="5 4"
              label={{ value: `Goal ${usdCompact(cf.required_nest_egg)}`, fill: c.amber, fontSize: 11, position: "insideTopLeft" }}
            />
            {cf.coast_age !== null && (
              <ReferenceLine
                x={cf.coast_age}
                stroke={c.green}
                strokeDasharray="4 4"
                label={{ value: `Coast @ ${cf.coast_age}`, fill: c.green, fontSize: 11, position: "insideTop", dy: -14 }}
              />
            )}
            <Area type="monotone" dataKey="retirement_balance" stroke={c.accent} fill="url(#gCoast)" strokeWidth={2.4} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="sub" style={{ marginTop: 6 }}>
          Uses your current balance and the assumptions from the Projections &amp; Social Security tabs.
          The custom goal is entered in today's dollars; the display toggle only changes how the goal,
          projected balance, and curve are shown — your Coast age is the same either way.
        </div>
      </div>

      {cf.coast_drawdown && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>
            Retirement drawdown: stop at {cf.coast_age} vs. keep contributing{realTag}
            <InfoTip align="left" text="Both paths drawn through retirement to your planned age. 'Stop at Coast age' halts 401(k) contributions once you can coast; 'keep contributing' funds it to retirement. Other assets grow the same in both." />
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart
              data={cf.keep_drawdown.map((k, i) => ({
                age: k.age,
                keep: k.balance,
                coast: cf.coast_drawdown?.[i]?.balance,
              }))}
              margin={{ left: 8, right: 14, top: 10, bottom: 6 }}
            >
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="age" tick={{ stroke: c.axis, fontSize: 12 }} />
              <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={62} />
              <Tooltip
                formatter={(v: number, n) => [usd(v), n === "coast" ? `Stop at ${cf.coast_age}` : "Keep contributing"]}
                labelFormatter={(a) => `Age ${a}`}
                contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
              />
              <Legend formatter={(v) => (v === "coast" ? `Stop at ${cf.coast_age}` : "Keep contributing")} />
              <ReferenceLine y={0} stroke={c.red} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="keep" stroke={c.accent} strokeWidth={2.4} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="coast" stroke={c.green} strokeWidth={2.4} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="sub" style={{ marginTop: 6 }}>
            Green stops 401(k) contributions at your Coast age and coasts to retirement; blue keeps
            contributing. Both then draw down to age {cf.life_expectancy}. The gap is what the extra
            contributions buy you — often a larger cushion, not a different "will it last" answer.
          </div>
        </div>
      )}
    </>
  );
}
