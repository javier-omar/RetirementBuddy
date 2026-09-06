import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  BalancePoint,
  DataQualityWarning,
  Holding,
  Summary,
  YearContribution,
} from "../types";
import { pct, usd, usdCompact } from "../format";
import InfoTip from "./InfoTip";
import { useChartColors } from "../theme";

interface Props {
  summary: Summary;
  holdings: Holding[];
  balance: BalancePoint[];
  contributions: YearContribution[];
  warnings: DataQualityWarning[];
}

function Stat({ label, value, delta, deltaClass, tip }: { label: string; value: string; delta?: string; deltaClass?: string; tip?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}{tip && <InfoTip text={tip} align="left" />}</div>
      <div className="value">{value}</div>
      {delta && <div className={`delta ${deltaClass ?? ""}`}>{delta}</div>}
    </div>
  );
}

export default function Dashboard({ summary, holdings, balance, contributions, warnings }: Props) {
  const c = useChartColors();
  const axis = { stroke: c.axis, fontSize: 12 };
  const gainPct = summary.total_contributions
    ? summary.total_gain / summary.total_contributions
    : 0;

  return (
    <>
      {warnings.map((w) => (
        <div key={w.security} className="banner warn" style={{ marginBottom: 14 }}>
          <span>⚠️</span>
          <span><strong>{w.security} — incomplete history.</strong> {w.message}</span>
        </div>
      ))}

      <div className="grid cols-4">
        <Stat label="Current Balance" value={usd(summary.market_value)} />
        <Stat
          label="Total Gain"
          value={usd(summary.total_gain)}
          delta={`${summary.total_gain >= 0 ? "▲" : "▼"} ${pct(gainPct)} on contributions`}
          deltaClass={summary.total_gain >= 0 ? "pos" : "neg"}
          tip="Your current balance minus everything you and your employer ever contributed — i.e. investment growth plus reinvested dividends."
        />
        <Stat label="Total Contributions" value={usd(summary.total_contributions)}
          delta={`You ${usd(summary.employee_contributions)} · Employer ${usd(summary.employer_contributions)}`}
          tip="Real money paid in (your pre-tax contributions + employer match + profit sharing). Reinvested dividends and internal fund swaps are excluded." />
        <Stat label="Dividends Reinvested" value={usd(summary.dividends)}
          delta={summary.first_date ? `since ${summary.first_date}` : undefined}
          tip="Fund payouts (dividends) automatically used to buy more shares rather than paid out as cash." />
      </div>

      <div className="section-title">Balance over time — market value vs. what you put in</div>
      <div className="card">
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={balance} margin={{ left: 8, right: 12, top: 6 }}>
            <defs>
              <linearGradient id="gMkt" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.accent} stopOpacity={0.5} />
                <stop offset="100%" stopColor={c.accent} stopOpacity={0.03} />
              </linearGradient>
              <linearGradient id="gCon" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.accent2} stopOpacity={0.35} />
                <stop offset="100%" stopColor={c.accent2} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" tick={axis} minTickGap={40} tickFormatter={(d) => String(d).slice(0, 7)} />
            <YAxis tick={axis} tickFormatter={(v) => usdCompact(v)} width={62} />
            <Tooltip
              formatter={(v: number, n) => [usd(v), n === "market_value" ? "Market value" : "Contributions"]}
              labelStyle={{ color: c.axis }}
              contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
            />
            <Legend formatter={(v) => (v === "market_value" ? "Market value" : "Cumulative contributions")} />
            <Area type="monotone" dataKey="contributions_cum" stroke={c.accent2} fill="url(#gCon)" strokeWidth={2} />
            <Area type="monotone" dataKey="market_value" stroke={c.accent} fill="url(#gMkt)" strokeWidth={2.4} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: "start" }}>
        <div className="card">
          <h3>Current Holdings</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Fund</th>
                <th className="num">Shares</th>
                <th className="num">Price</th>
                <th className="num">Value</th>
                <th className="num">Gain<InfoTip align="right" text="Current market value minus your cost basis (what you paid for the shares you still hold)." /></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.security}>
                  <td>
                    <strong>{h.security}</strong>
                    <div className="sub">{h.fund_name}</div>
                  </td>
                  <td className="num">{h.shares.toLocaleString()}</td>
                  <td className="num">{usd(h.price, 2)}</td>
                  <td className="num">{usd(h.market_value)}</td>
                  <td className={`num ${h.gain >= 0 ? "pos" : "neg"}`}>
                    {usd(h.gain)}<div className="sub">{pct(h.gain_pct / 100)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Contributions by Year</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={contributions} margin={{ left: 4, right: 8, top: 6 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="year" tick={axis} />
              <YAxis tick={axis} tickFormatter={(v) => usdCompact(v)} width={54} />
              <Tooltip
                formatter={(v: number, n) => [usd(v), n === "employee" ? "You" : "Employer"]}
                contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10 }}
              />
              <Legend formatter={(v) => (v === "employee" ? "You" : "Employer")} />
              <Bar dataKey="employee" stackId="c" fill={c.accent} radius={[0, 0, 0, 0]} />
              <Bar dataKey="employer" stackId="c" fill={c.green} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
