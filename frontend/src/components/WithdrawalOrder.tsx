import { useState } from "react";
import type { Assumptions } from "../types";

/** The four bucket types, with the assumption key that stores their rank. */
const BUCKETS: { key: string; label: string; tax: string }[] = [
  { key: "order_cash", label: "Cash", tax: "untaxed" },
  { key: "order_taxable", label: "Taxable", tax: "gains taxed" },
  { key: "order_deferred", label: "Tax-deferred", tax: "taxed as income" },
  { key: "order_roth", label: "Roth", tax: "tax-free" },
];

/**
 * Drag (or use the ▲/▼ buttons) to set the order buckets are drawn down in.
 * The list position is the source of truth: reordering rewrites order_* to
 * 1..4 so "top = spent first". Arrow buttons keep it usable on touch/keyboard.
 */
export default function WithdrawalOrder({
  assumptions,
  onReorder,
}: {
  assumptions: Assumptions;
  onReorder: (patch: Record<string, number>) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const ordered = [...BUCKETS].sort(
    (a, b) => (assumptions[a.key] ?? 99) - (assumptions[b.key] ?? 99),
  );

  function commit(list: typeof BUCKETS) {
    const patch: Record<string, number> = {};
    list.forEach((b, i) => (patch[b.key] = i + 1));
    onReorder(patch);
  }
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= ordered.length) return;
    const list = [...ordered];
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    commit(list);
  }

  return (
    <ul className="wd-order" onDragOver={(e) => e.preventDefault()}>
      {ordered.map((b, i) => (
        <li
          key={b.key}
          className={`wd-item${dragIdx === i ? " dragging" : ""}${overIdx === i && dragIdx !== null && dragIdx !== i ? " over" : ""}`}
          draggable
          onDragStart={(e) => {
            setDragIdx(i);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnter={() => setOverIdx(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIdx !== null) move(dragIdx, i);
            setDragIdx(null);
            setOverIdx(null);
          }}
          onDragEnd={() => {
            setDragIdx(null);
            setOverIdx(null);
          }}
        >
          <span className="wd-grip" aria-hidden>⠿</span>
          <span className="wd-rank">{i + 1}</span>
          <span className="wd-name">{b.label}</span>
          <span className="wd-tax">{b.tax}</span>
          <span className="wd-arrows">
            <button
              type="button"
              aria-label={`Move ${b.label} up`}
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={`Move ${b.label} down`}
              disabled={i === ordered.length - 1}
              onClick={() => move(i, i + 1)}
            >
              ▼
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
