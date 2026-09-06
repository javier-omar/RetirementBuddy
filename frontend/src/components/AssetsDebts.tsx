import { useEffect, useState } from "react";
import { api } from "../api";
import type { LoanRow, OtherAssetRow } from "../types";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";

type Msg = { kind: "ok" | "error"; text: string } | null;
const inp = { background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", padding: "6px 9px" } as const;

const TAX_LABEL: Record<string, string> = {
  deferred: "Tax-deferred", roth: "Roth (tax-free)", taxable: "Taxable", cash: "Cash",
};

export default function AssetsDebts() {
  const [assets, setAssets] = useState<OtherAssetRow[]>([]);
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [aMsg, setAMsg] = useState<Msg>(null);
  const [lMsg, setLMsg] = useState<Msg>(null);

  async function load() {
    const [a, l, meta] = await Promise.all([api.otherAssets(), api.loans(), api.assumptions()]);
    // Migrate the legacy single "other assets" field into an editable row so it
    // isn't silently dropped once the table takes over.
    const legacy = meta.assumptions.other_assets_today ?? 0;
    if (a.length === 0 && legacy > 0) {
      setAssets([{
        name: "Other assets", value: legacy, growth_rate: meta.assumptions.nominal_return ?? 0.06,
        contribution_annual: 0, tax_type: "taxable", cost_basis: legacy, is_market: 1,
      }]);
    } else {
      setAssets(a);
    }
    setLoans(l);
  }
  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  async function saveAssets() {
    setBusy(true); setAMsg(null);
    try {
      await api.saveOtherAssets(assets.filter((a) => a.value > 0));
      await load();
      setAMsg({ kind: "ok", text: "Saved. Projections now include these assets as separate buckets." });
    } catch (e) { setAMsg({ kind: "error", text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function saveLoans() {
    setBusy(true); setLMsg(null);
    try {
      await api.saveLoans(loans.filter((l) => l.balance > 0));
      await load();
      setLMsg({ kind: "ok", text: "Saved. Loan payments now reduce retirement spending until payoff." });
    } catch (e) { setLMsg({ kind: "error", text: (e as Error).message }); } finally { setBusy(false); }
  }

  if (loading) return <div className="center-load"><div className="spinner" /> Loading…</div>;

  const upA = (i: number, patch: Partial<OtherAssetRow>) => {
    const n = [...assets]; n[i] = { ...n[i], ...patch }; setAssets(n);
  };
  const upL = (i: number, patch: Partial<LoanRow>) => {
    const n = [...loans]; n[i] = { ...n[i], ...patch }; setLoans(n);
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* -------- Other assets -------- */}
      <div className="card">
        <h3>
          Other assets
          <InfoTip align="left" text="Investable money outside your 401(k) — IRAs, a Roth, taxable brokerage, cash/HYSA. Each grows at its own rate and, in retirement, is its own withdrawal bucket taxed by its type. Values are today's dollars." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Each asset grows at its own rate and is drawn down separately in retirement, taxed by
          its type. Withdrawal order is set on the Projections tab.
        </p>
        {assets.length === 0 ? (
          <p className="muted">No other assets — only your 401(k) is projected.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Value ($)</th>
                  <th className="num">Growth %</th>
                  <th className="num">Contrib/yr ($)</th>
                  <th>Tax type</th>
                  <th className="num">Cost basis ($)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a, i) => (
                  <tr key={i}>
                    <td><input value={a.name} placeholder="Roth IRA" onChange={(e) => upA(i, { name: e.target.value })} style={{ ...inp, width: 120 }} /></td>
                    <td className="num"><MoneyInput value={a.value} onValue={(n) => upA(i, { value: n })} blankOnZero style={{ ...inp, width: 100, textAlign: "right" }} /></td>
                    <td className="num"><input type="number" step="0.5" value={+(a.growth_rate * 100).toFixed(4)} onChange={(e) => upA(i, { growth_rate: (parseFloat(e.target.value) || 0) / 100 })} style={{ ...inp, width: 70, textAlign: "right" }} /></td>
                    <td className="num"><MoneyInput value={a.contribution_annual} onValue={(n) => upA(i, { contribution_annual: n })} blankOnZero style={{ ...inp, width: 90, textAlign: "right" }} /></td>
                    <td>
                      <select value={a.tax_type} onChange={(e) => upA(i, { tax_type: e.target.value as OtherAssetRow["tax_type"] })} style={{ ...inp, width: 130 }}>
                        {Object.entries(TAX_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td className="num">
                      {a.tax_type === "taxable"
                        ? <MoneyInput value={a.cost_basis} onValue={(n) => upA(i, { cost_basis: n })} blankOnZero style={{ ...inp, width: 90, textAlign: "right" }} />
                        : <span className="sub">—</span>}
                    </td>
                    <td className="num"><button className="btn danger sm" onClick={() => setAssets(assets.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn ghost" onClick={() => setAssets([...assets, { name: "", value: 0, growth_rate: 0.06, contribution_annual: 0, tax_type: "taxable", cost_basis: 0, is_market: 1 }])}>+ Add asset</button>
          <button className="btn" disabled={busy} onClick={saveAssets}>{busy ? "Saving…" : "Save"}</button>
        </div>
        {aMsg && <div className={`banner ${aMsg.kind === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}><span>{aMsg.kind === "ok" ? "✅" : "⚠️"}</span><span>{aMsg.text}</span></div>}
        <p className="sub" style={{ marginTop: 12 }}>
          <strong>Tax types:</strong> tax-deferred (taxed as income on withdrawal), Roth (tax-free),
          taxable (only gains taxed, at the capital-gains rate on the Projections tab — set a cost
          basis), cash (untaxed). Cash grows at its set rate even in Monte Carlo; the rest vary.
        </p>
      </div>

      {/* -------- Loans / mortgage -------- */}
      <div className="card">
        <h3>
          Loans &amp; mortgage
          <InfoTip align="left" text="Amortizing debts. While a loan is active in retirement its payment is added to your spending; it drops off at payoff. Extra payments shorten it; a lump-sum payoff age clears the balance from your portfolio that year." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Each loan's payment is added to retirement spending until it's paid off. Enter the current
          balance, rate, and months left (the payment is computed). Loans paid off before retirement
          have no effect on the projection.
        </p>
        {loans.length === 0 ? (
          <p className="muted">No loans — spending has no debt payments.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Balance ($)</th>
                  <th className="num">Rate %</th>
                  <th className="num">Months left</th>
                  <th className="num">Extra $/mo</th>
                  <th className="num">Lump payoff age</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l, i) => (
                  <tr key={i}>
                    <td><input value={l.name} placeholder="Mortgage" onChange={(e) => upL(i, { name: e.target.value })} style={{ ...inp, width: 120 }} /></td>
                    <td className="num"><MoneyInput value={l.balance} onValue={(n) => upL(i, { balance: n })} blankOnZero style={{ ...inp, width: 100, textAlign: "right" }} /></td>
                    <td className="num"><input type="number" step="0.125" value={+(l.annual_rate * 100).toFixed(4)} onChange={(e) => upL(i, { annual_rate: (parseFloat(e.target.value) || 0) / 100 })} style={{ ...inp, width: 70, textAlign: "right" }} /></td>
                    <td className="num"><input type="number" value={l.months_remaining || ""} onChange={(e) => upL(i, { months_remaining: parseInt(e.target.value) || 0 })} style={{ ...inp, width: 80, textAlign: "right" }} /></td>
                    <td className="num"><MoneyInput value={l.extra_payment_monthly} onValue={(n) => upL(i, { extra_payment_monthly: n })} blankOnZero style={{ ...inp, width: 80, textAlign: "right" }} /></td>
                    <td className="num"><input type="number" value={l.lump_sum_payoff_age || ""} placeholder="—" onChange={(e) => upL(i, { lump_sum_payoff_age: parseInt(e.target.value) || 0 })} style={{ ...inp, width: 70, textAlign: "right" }} /></td>
                    <td className="num"><button className="btn danger sm" onClick={() => setLoans(loans.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn ghost" onClick={() => setLoans([...loans, { name: "", balance: 0, annual_rate: 0.055, months_remaining: 300, extra_payment_monthly: 0, lump_sum_payoff_age: 0 }])}>+ Add loan</button>
          <button className="btn" disabled={busy} onClick={saveLoans}>{busy ? "Saving…" : "Save"}</button>
        </div>
        {lMsg && <div className={`banner ${lMsg.kind === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}><span>{lMsg.kind === "ok" ? "✅" : "⚠️"}</span><span>{lMsg.text}</span></div>}
        <p className="sub" style={{ marginTop: 12 }}>
          <strong>Early payoff:</strong> add an <em>extra $/mo</em> to shorten the loan, or set a
          <em> lump payoff age</em> to clear the remaining balance from your portfolio in that year.
          Compare the effect on the Projections and Drawdown tabs.
        </p>
      </div>
    </div>
  );
}
