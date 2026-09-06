import { useEffect, useState } from "react";
import { api } from "../api";
import type { LifeEventRow, TaxBracketRow } from "../types";
import { usd } from "../format";
import InfoTip from "./InfoTip";
import MoneyInput from "./MoneyInput";

type Msg = { kind: "ok" | "error"; text: string } | null;

const inputStyle = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  padding: "6px 9px",
} as const;

export default function EventsTaxes() {
  const [events, setEvents] = useState<LifeEventRow[]>([]);
  const [brackets, setBrackets] = useState<TaxBracketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventMsg, setEventMsg] = useState<Msg>(null);
  const [taxMsg, setTaxMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [e, b] = await Promise.all([api.lifeEvents(), api.taxBrackets()]);
    setEvents(e);
    setBrackets(b);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  async function saveEvents() {
    setBusy(true);
    setEventMsg(null);
    try {
      await api.saveLifeEvents(events.filter((e) => e.age > 0 && e.amount !== 0));
      await load();
      setEventMsg({ kind: "ok", text: "Saved. Projections now include these events." });
    } catch (err) {
      setEventMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function saveBrackets() {
    setBusy(true);
    setTaxMsg(null);
    try {
      await api.saveTaxBrackets(brackets.filter((b) => b.threshold >= 0 && b.rate >= 0));
      await load();
      setTaxMsg({
        kind: "ok",
        text: brackets.length
          ? "Saved. Withdrawals are now taxed with these brackets instead of the flat rate."
          : "Cleared. Back to the flat effective rate from the Projections tab.",
      });
    } catch (err) {
      setTaxMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="center-load"><div className="spinner" /> Loading…</div>;

  const updateEvent = (i: number, patch: Partial<LifeEventRow>) => {
    const next = [...events];
    next[i] = { ...next[i], ...patch };
    setEvents(next);
  };
  const updateBracket = (i: number, patch: Partial<TaxBracketRow>) => {
    const next = [...brackets];
    next[i] = { ...next[i], ...patch };
    setBrackets(next);
  };

  const sortedBrackets = [...brackets].sort((a, b) => a.threshold - b.threshold);

  return (
    <div className="two-col">
      {/* ---------------- Life events ---------------- */}
      <div className="card">
        <h3>
          One-off life events
          <InfoTip align="left" text="Large one-time cash flows that hit your portfolio in a single year — an inheritance or home sale coming in, college tuition or a new roof going out. Amounts are in today's dollars and grow with inflation like your other figures." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Enter amounts in <strong>today's dollars</strong>. Use a positive number for money
          coming in and a negative number for money going out.
        </p>

        {events.length === 0 ? (
          <p className="muted">No events yet — your projection assumes a smooth path.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Age</th>
                <th className="num">Amount ($)</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="number"
                      value={e.age || ""}
                      onChange={(ev) => updateEvent(i, { age: parseInt(ev.target.value) || 0 })}
                      style={{ ...inputStyle, width: 66 }}
                    />
                  </td>
                  <td className="num">
                    <MoneyInput
                      value={e.amount}
                      onValue={(n) => updateEvent(i, { amount: n })}
                      blankOnZero
                      style={{ ...inputStyle, width: 110, textAlign: "right", color: e.amount < 0 ? "var(--red)" : "var(--green)" }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={e.label}
                      placeholder="e.g. College"
                      onChange={(ev) => updateEvent(i, { label: ev.target.value })}
                      style={{ ...inputStyle, width: "100%" }}
                    />
                  </td>
                  <td className="num">
                    <button className="btn danger sm" onClick={() => setEvents(events.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn ghost" onClick={() => setEvents([...events, { age: 0, amount: 0, label: "" }])}>
            + Add event
          </button>
          <button className="btn" disabled={busy} onClick={saveEvents}>{busy ? "Saving…" : "Save"}</button>
        </div>

        {eventMsg && (
          <div className={`banner ${eventMsg.kind === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}>
            <span>{eventMsg.kind === "ok" ? "✅" : "⚠️"}</span>
            <span>{eventMsg.text}</span>
          </div>
        )}
      </div>

      {/* ---------------- Tax brackets ---------------- */}
      <div className="card">
        <h3>
          Progressive tax brackets
          <InfoTip align="left" text="Instead of one flat effective rate, tax retirement income by bracket. Each rate applies only to income above its threshold, up to the next one. Thresholds are today's dollars and are inflation-adjusted each year." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Optional. Leave empty to keep the flat effective rate from the Projections tab.
          Each rate applies to income <em>above</em> its threshold. Applies to taxable 401(k)
          withdrawals plus other income — Social Security keeps its own rate.
        </p>

        {brackets.length === 0 ? (
          <p className="muted">No brackets — using the flat rate.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th className="num">Income above ($)</th>
                <th className="num">Rate (%)</th>
                <th>Applies to</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {brackets.map((b, i) => {
                const idx = sortedBrackets.findIndex((x) => x.threshold === b.threshold);
                const next = sortedBrackets[idx + 1];
                return (
                  <tr key={i}>
                    <td className="num">
                      <MoneyInput
                        value={b.threshold}
                        onValue={(n) => updateBracket(i, { threshold: n })}
                        style={{ ...inputStyle, width: 110, textAlign: "right" }}
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        step="0.5"
                        value={+(b.rate * 100).toFixed(6)}
                        onChange={(ev) => updateBracket(i, { rate: (parseFloat(ev.target.value) || 0) / 100 })}
                        style={{ ...inputStyle, width: 78, textAlign: "right" }}
                      />
                    </td>
                    <td className="sub">
                      {usd(b.threshold)} – {next ? usd(next.threshold) : "up"}
                    </td>
                    <td className="num">
                      <button className="btn danger sm" onClick={() => setBrackets(brackets.filter((_, j) => j !== i))}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button
            className="btn ghost"
            onClick={() => setBrackets([...brackets, { threshold: 0, rate: 0 }])}
          >
            + Add bracket
          </button>
          <button className="btn" disabled={busy} onClick={saveBrackets}>{busy ? "Saving…" : "Save"}</button>
        </div>

        {taxMsg && (
          <div className={`banner ${taxMsg.kind === "ok" ? "ok" : "error"}`} style={{ marginTop: 12 }}>
            <span>{taxMsg.kind === "ok" ? "✅" : "⚠️"}</span>
            <span>{taxMsg.text}</span>
          </div>
        )}

        <p className="sub" style={{ marginTop: 14 }}>
          Set a <strong>standard deduction</strong> on the Projections tab to exempt the first
          slice of income. Tax schedules vary by jurisdiction — use the figures that apply
          to you, and confirm them with a CPA.
        </p>
      </div>
    </div>
  );
}
