import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { SSBenefitRow } from "../types";
import { usd, usdCompact } from "../format";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";
import { useChartColors } from "../theme";

export default function SocialSecurity() {
  const [rows, setRows] = useState<SSBenefitRow[]>([]);
  const [claimAge, setClaimAge] = useState<number | null>(null);
  const [effective, setEffective] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const c = useChartColors();

  async function load() {
    const [benefits, meta] = await Promise.all([api.ssBenefits(), api.assumptions()]);
    setRows(benefits);
    setClaimAge(meta.assumptions.ss_claim_age ?? null);
    setEffective(meta.ss_benefit_from_table);
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const clean = rows.filter((r) => r.claim_age > 0 && r.monthly_benefit > 0);
      await api.saveSSBenefits(clean);
      await load();
      setMsg({ kind: "ok", text: "Saved. Projections now pick the benefit matching your claim age." });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const chartData = useMemo(
    () =>
      [...rows]
        .filter((r) => r.claim_age > 0 && r.monthly_benefit > 0)
        .sort((a, b) => a.claim_age - b.claim_age)
        .map((r) => ({ age: r.claim_age, annual: r.monthly_benefit * 12 })),
    [rows]
  );

  const update = (i: number, patch: Partial<SSBenefitRow>) => {
    const next = [...rows];
    next[i] = { ...next[i], ...patch };
    setRows(next);
  };

  return (
    <div className="two-col wide-left">
      <div className="card">
        <h3>
          Your SSA benefit estimates
          <InfoTip align="left" text="Social Security pays more per month the later you claim, between ages 62 and 70. These estimates come from your Social Security statement and are expressed in today's dollars." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Copy these from your statement at <strong>ssa.gov/myaccount</strong> (they're in
          today's dollars). Refresh them once a year — don't add COLAs yourself; the app
          already grows benefits with your inflation assumption.
        </p>

        <table className="data">
          <thead>
            <tr>
              <th>Claim age</th>
              <th className="num">Monthly ($)</th>
              <th className="num">Annual</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="number"
                    min={50}
                    max={80}
                    value={r.claim_age || ""}
                    onChange={(e) => update(i, { claim_age: parseInt(e.target.value) || 0 })}
                    style={{ width: 70, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", padding: "6px 9px" }}
                  />
                </td>
                <td className="num">
                  <MoneyInput
                    value={r.monthly_benefit}
                    onValue={(n) => update(i, { monthly_benefit: n })}
                    blankOnZero
                    style={{ width: 100, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", padding: "6px 9px", textAlign: "right" }}
                  />
                </td>
                <td className="num">{r.monthly_benefit > 0 ? usd(r.monthly_benefit * 12) : "—"}</td>
                <td className="num">
                  <button className="btn danger sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button
            className="btn ghost"
            onClick={() => setRows([...rows, { claim_age: 0, monthly_benefit: 0 }])}
          >
            + Add claim age
          </button>
          <button className="btn" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>

        {msg && (
          <div className={`banner ${msg.kind === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}>
            <span>{msg.kind === "ok" ? "✅" : "⚠️"}</span>
            <span>{msg.text}</span>
          </div>
        )}

        <p className="sub" style={{ marginTop: 14 }}>
          <strong>How it's used:</strong> when this table has values, projections automatically
          use the benefit matching your claim age (set in the Projections tab), interpolating
          between ages — e.g. claiming at 63 lands between your 62 and 65 estimates. The manual
          "SS annual benefit" field is ignored while the table is active. Delete all rows to go
          back to manual entry.
        </p>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        {effective !== null && claimAge !== null && (
          <div className="card stat">
            <div className="label">Active in projections</div>
            <div className="value">{usd(effective)}/yr</div>
            <div className="delta muted">
              for your claim age of {claimAge} · {usd(effective / 12)}/mo
            </div>
          </div>
        )}

        {chartData.length > 0 && (
          <div className="card">
            <h3>Annual benefit by claim age <span className="sub">(today's dollars)</span></h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ left: 4, right: 8, top: 6 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="age" tick={{ stroke: c.axis, fontSize: 12 }} />
                <YAxis tick={{ stroke: c.axis, fontSize: 12 }} tickFormatter={(v) => usdCompact(v)} width={56} />
                <Tooltip
                  formatter={(v: number) => [usd(v), "Annual benefit"]}
                  labelFormatter={(a) => `Claim at ${a}`}
                  contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
                />
                <Bar dataKey="annual" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {chartData.map((d) => (
                    <Cell key={d.age} fill={claimAge === d.age ? c.green : c.accent} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="sub" style={{ marginTop: 6 }}>
              Green = your current claim age. Waiting from 62 to 70 raises the check
              {chartData.length >= 2
                ? ` ~${Math.round(((chartData[chartData.length - 1].annual / chartData[0].annual) - 1) * 100)}%`
                : ""} — for life.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
