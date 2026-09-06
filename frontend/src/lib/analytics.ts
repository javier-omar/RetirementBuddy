/**
 * Derive holdings, balances over time, and contribution history from the
 * transaction ledger — a browser port of backend/app/services/analytics.py.
 * Everything is computed on the fly so the numbers always reconcile with what
 * was imported. Dates are ISO "YYYY-MM-DD" strings (lexicographically sortable).
 */

export interface TxnRecord {
  id: number;
  row_hash: string;
  batch_id: number;
  txn_date: string;
  category: string;
  portfolio: string;
  security: string;
  fund_name: string;
  action: string;
  transaction_type: string;
  quantity: number;
  price: number;
  amount: number;
}

function round(v: number, n = 2): number {
  const f = 10 ** n;
  return Math.round((v + Number.EPSILON) * f) / f;
}

export type Flow = "contribution" | "dividend" | "adjustment" | "reallocation" | "other";

export function classify(txnType: string, action: string): Flow {
  const t = (txnType || "").toLowerCase();
  const starts = (prefixes: string[]) => prefixes.some((p) => t.startsWith(p));
  if (starts(["ee pre-tax", "employee", "employer match", "profit sharing", "roth", "after-tax"])) return "contribution";
  if ((action || "").toUpperCase() === "REINVDIV" || t.startsWith("dividend")) return "dividend";
  if (t.startsWith("gain/loss")) return "adjustment";
  if (starts(["buy", "sell"])) return "reallocation";
  return "other";
}

function sortedByDate(txns: TxnRecord[]): TxnRecord[] {
  return [...txns].sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0));
}

export function latestPrices(txns: TxnRecord[]): Record<string, number> {
  const prices: Record<string, number> = {};
  const seenDate: Record<string, string> = {};
  for (const t of txns) {
    if (t.price > 0 && (!(t.security in seenDate) || t.txn_date >= seenDate[t.security])) {
      prices[t.security] = t.price;
      seenDate[t.security] = t.txn_date;
    }
  }
  return prices;
}

export interface Holding {
  security: string; fund_name: string; shares: number; price: number;
  market_value: number; cost_basis: number; gain: number; gain_pct: number;
}

export function holdings(txns: TxnRecord[]): Holding[] {
  if (!txns.length) return [];
  const sorted = sortedByDate(txns);
  const prices = latestPrices(sorted);
  const bySecurity = new Map<string, TxnRecord[]>();
  for (const t of sorted) {
    if (!bySecurity.has(t.security)) bySecurity.set(t.security, []);
    bySecurity.get(t.security)!.push(t);
  }
  const out: Holding[] = [];
  for (const [sec, grp] of bySecurity) {
    const shares = grp.reduce((s, t) => s + t.quantity, 0);
    if (shares <= 1e-6) continue; // fully exited / over-sold -> closed, $0
    const price = prices[sec] ?? 0.0;
    const mkt = shares * price;
    const cost = grp.reduce((s, t) => s + t.amount, 0);
    const fundName = grp[grp.length - 1].fund_name || sec;
    out.push({
      security: sec, fund_name: fundName, shares: round(shares, 4), price: round(price, 4),
      market_value: round(mkt), cost_basis: round(cost), gain: round(mkt - cost),
      gain_pct: cost > 0 ? round(((mkt - cost) / cost) * 100) : 0.0,
    });
  }
  return out.sort((a, b) => b.market_value - a.market_value);
}

export interface Summary {
  market_value: number; total_contributions: number; employee_contributions: number;
  employer_contributions: number; dividends: number; total_gain: number;
  first_date: string | null; last_date: string | null;
}

export function summary(txns: TxnRecord[]): Summary {
  if (!txns.length) {
    return {
      market_value: 0, total_contributions: 0, employee_contributions: 0,
      employer_contributions: 0, dividends: 0, total_gain: 0, first_date: null, last_date: null,
    };
  }
  const mkt = holdings(txns).reduce((s, h) => s + h.market_value, 0);
  let employee = 0, employer = 0, totalContrib = 0, dividends = 0;
  let first = txns[0].txn_date, last = txns[0].txn_date;
  for (const t of txns) {
    if (t.txn_date < first) first = t.txn_date;
    if (t.txn_date > last) last = t.txn_date;
    const flow = classify(t.transaction_type, t.action);
    if (flow === "contribution") {
      totalContrib += t.amount;
      if (/employee/i.test(t.category)) employee += t.amount;
      else employer += t.amount;
    } else if (flow === "dividend") {
      dividends += t.amount;
    }
  }
  return {
    market_value: round(mkt), total_contributions: round(totalContrib),
    employee_contributions: round(employee), employer_contributions: round(employer),
    dividends: round(dividends), total_gain: round(mkt - totalContrib),
    first_date: first, last_date: last,
  };
}

export interface BalancePoint {
  date: string; market_value: number; contributions_cum: number; gain_cum: number;
}

function lastDayOfMonth(year: number, month1: number): string {
  const day = new Date(year, month1, 0).getDate(); // month1 is 1-indexed
  return `${year}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Month-end series of market value vs cumulative contributions. */
export function balanceSeries(txns: TxnRecord[]): BalancePoint[] {
  if (!txns.length) return [];
  const sorted = sortedByDate(txns);
  const start = sorted[0].txn_date;
  const end = sorted[sorted.length - 1].txn_date;
  const [sy, sm] = start.split("-").map(Number);

  const periods: string[] = [];
  let y = sy, m = sm;
  for (let guard = 0; guard < 2400; guard++) {
    const me = lastDayOfMonth(y, m);
    if (me > end) break;
    if (me >= start) periods.push(me);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  if (!periods.length || periods[periods.length - 1] < end) periods.push(end);

  const securities = [...new Set(sorted.map((t) => t.security))];
  return periods.map((pe) => {
    const upto = sorted.filter((t) => t.txn_date <= pe);
    let mkt = 0;
    for (const sec of securities) {
      const sub = upto.filter((t) => t.security === sec);
      if (!sub.length) continue;
      const shares = sub.reduce((s, t) => s + t.quantity, 0);
      if (shares <= 1e-6) continue;
      const priced = sub.filter((t) => t.price > 0);
      if (!priced.length) continue;
      mkt += shares * priced[priced.length - 1].price;
    }
    const contribCum = upto
      .filter((t) => classify(t.transaction_type, t.action) === "contribution")
      .reduce((s, t) => s + t.amount, 0);
    return { date: pe, market_value: round(mkt), contributions_cum: round(contribCum), gain_cum: round(mkt - contribCum) };
  });
}

export interface DataQualityWarning {
  security: string; fund_name: string; severity: string; message: string;
}

export function dataQuality(txns: TxnRecord[]): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];
  if (!txns.length) return warnings;
  const sorted = sortedByDate(txns);
  const bySecurity = new Map<string, TxnRecord[]>();
  for (const t of sorted) {
    if (!bySecurity.has(t.security)) bySecurity.set(t.security, []);
    bySecurity.get(t.security)!.push(t);
  }
  for (const [sec, grp] of bySecurity) {
    let running = 0, minShares = Infinity;
    for (const t of grp) { running += t.quantity; if (running < minShares) minShares = running; }
    const netShares = running;
    if (netShares < -1e-4 || minShares < -1e-4) {
      const fund = grp[grp.length - 1].fund_name || sec;
      const firstDate = grp[0].txn_date;
      warnings.push({
        security: sec, fund_name: fund, severity: "warning",
        message: `${sec} sold more shares than the imported history shows were bought `
          + `(net ${netShares.toFixed(2)}). Early transactions are likely missing, so balances `
          + `before ${firstDate} may be understated. Import an earlier statement to complete it.`,
      });
    }
  }
  return warnings;
}

export interface YearContribution { year: number; employee: number; employer: number; total: number }

export function contributionsByYear(txns: TxnRecord[]): YearContribution[] {
  if (!txns.length) return [];
  const byYear = new Map<number, { emp: number; empr: number }>();
  for (const t of txns) {
    if (classify(t.transaction_type, t.action) !== "contribution") continue;
    const year = Number(t.txn_date.slice(0, 4));
    if (!byYear.has(year)) byYear.set(year, { emp: 0, empr: 0 });
    const bucket = byYear.get(year)!;
    if (/employee/i.test(t.category)) bucket.emp += t.amount;
    else bucket.empr += t.amount;
  }
  return [...byYear.entries()]
    .map(([year, v]) => ({ year, employee: round(v.emp), employer: round(v.empr), total: round(v.emp + v.empr) }))
    .sort((a, b) => a.year - b.year);
}
