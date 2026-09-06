import { useMemo, useState } from "react";
import type { Transaction } from "../types";
import { num, usd } from "../format";

export default function Transactions({ txns }: { txns: Transaction[] }) {
  const [q, setQ] = useState("");
  const [security, setSecurity] = useState("all");

  const securities = useMemo(
    () => Array.from(new Set(txns.map((t) => t.security))).filter(Boolean).sort(),
    [txns]
  );

  const filtered = useMemo(() => {
    const term = q.toLowerCase();
    return txns.filter(
      (t) =>
        (security === "all" || t.security === security) &&
        (term === "" ||
          t.category.toLowerCase().includes(term) ||
          t.transaction_type.toLowerCase().includes(term) ||
          t.action.toLowerCase().includes(term))
    );
  }, [txns, q, security]);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <h3 style={{ margin: 0, marginRight: "auto" }}>
          Transactions <span className="sub">({filtered.length.toLocaleString()} of {txns.length.toLocaleString()})</span>
        </h3>
        <input
          placeholder="Search category, action, type…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "8px 11px", width: 260 }}
        />
        <select
          value={security}
          onChange={(e) => setSecurity(e.target.value)}
          style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "8px 11px" }}
        >
          <option value="all">All funds</option>
          {securities.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div style={{ maxHeight: 560, overflow: "auto" }}>
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Fund</th>
              <th>Action</th>
              <th className="num">Quantity</th>
              <th className="num">Price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id}>
                <td>{t.txn_date}</td>
                <td>{t.category}</td>
                <td>{t.security}</td>
                <td>{t.action}</td>
                <td className="num">{num(t.quantity, 3)}</td>
                <td className="num">{t.price ? usd(t.price, 2) : "—"}</td>
                <td className={`num ${t.amount < 0 ? "neg" : ""}`}>{usd(t.amount, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
