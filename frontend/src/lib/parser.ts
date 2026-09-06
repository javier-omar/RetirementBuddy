/**
 * Parse 401(k) transaction report CSVs into normalized rows — a browser port of
 * backend/app/services/parser.py. Handles the quirks seen in real exports:
 *   * Accounting negatives in parentheses:  (0.149000) and $(2.10)  -> negative
 *   * Currency symbols and thousands separators: "$1,234.56"
 *   * Trailing tabs/whitespace in fund names
 *   * Slightly different column headers (fuzzy-matched)
 *
 * (The original also read .xlsx via pandas; the static app is CSV-only. Export
 * an .xlsx to CSV first.)
 */

export interface ParsedRow {
  txn_date: string; // ISO YYYY-MM-DD
  category: string;
  portfolio: string;
  security: string;
  fund_name: string;
  action: string;
  transaction_type: string;
  quantity: number;
  price: number;
  amount: number;
  row_hash: string;
}

export class ParseError extends Error {}

const COLUMN_ALIASES: Record<string, string[]> = {
  txn_date: ["date", "transaction date", "trade date"],
  category: ["category", "source", "money source"],
  portfolio: ["portfolio(if applicable)", "portfolio", "account"],
  security: ["security", "ticker", "symbol"],
  fund_name: ["fund name", "fund", "investment", "investment name"],
  action: ["action", "activity"],
  transaction_type: ["transaction type", "description", "details"],
  quantity: ["quantity", "units", "shares"],
  price: ["price", "unit price", "share price", "nav"],
  amount: ["amount", "total", "dollar amount"],
};

const REQUIRED = ["txn_date", "amount"];

function clean(text: unknown): string {
  if (text === null || text === undefined) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

export function parseNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0.0;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  let s = String(raw).trim();
  if (s === "" || ["N/A", "NA", "-", "--"].includes(s.toUpperCase())) return 0.0;
  // Strip currency symbols/separators first so "$(2.10)" -> "(2.10)".
  s = s.replace(/\$/g, "").replace(/,/g, "").replace(/%/g, "").trim();
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s === "") return 0.0;
  const val = Number(s);
  if (Number.isNaN(val)) throw new ParseError(`Could not parse number: ${JSON.stringify(raw)}`);
  return negative ? -val : val;
}

/** Parse a date cell into an ISO YYYY-MM-DD string. */
export function parseDate(raw: unknown): string {
  const s = clean(raw);
  if (s === "") throw new ParseError("Empty date");
  // ISO first (YYYY-MM-DD or YYYY/MM/DD)
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // US M/D/Y or M-D-Y (2- or 4-digit year)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return `${year}-${pad(m[1])}-${pad(m[2])}`;
  }
  // Last resort: let the JS Date parser try.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  throw new ParseError(`Unrecognized date: ${JSON.stringify(raw)}`);
}

function pad(v: string | number): string {
  return String(v).padStart(2, "0");
}

/** Minimal RFC-4180-ish CSV tokenizer (handles quoted fields, commas, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (ch === "\r") {
      // handled by the \n branch; ignore lone CR
    } else {
      field += ch;
    }
  }
  // Flush the final field/row if the file didn't end with a newline.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function buildHeaderMap(columns: string[]): Record<string, number> {
  const normalized = columns.map((c) => clean(c).toLowerCase());
  const mapping: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) { mapping[field] = i; break; }
    }
  }
  return mapping;
}

/** Deterministic 53-bit string hash (cyrb53) for de-duplicating re-imports. */
function rowHash(key: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function parseFile(text: string): ParsedRow[] {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (table.length === 0) throw new ParseError("File is empty.");
  const header = table[0];
  const headerMap = buildHeaderMap(header);
  const missing = REQUIRED.filter((f) => !(f in headerMap));
  if (missing.length) {
    throw new ParseError(`Missing required column(s): ${missing.join(", ")}. Found headers: ${header.join(", ")}`);
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const g = (field: string): string | undefined => {
      const idx = headerMap[field];
      return idx === undefined ? undefined : cells[idx];
    };
    try {
      const txn_date = parseDate(g("txn_date"));
      const quantity = parseNumber(g("quantity"));
      const price = parseNumber(g("price"));
      const amount = parseNumber(g("amount"));
      const row: ParsedRow = {
        txn_date,
        category: clean(g("category")),
        portfolio: clean(g("portfolio")),
        security: clean(g("security")),
        fund_name: clean(g("fund_name")),
        action: clean(g("action")),
        transaction_type: clean(g("transaction_type")),
        quantity, price, amount,
        row_hash: "",
      };
      row.row_hash = rowHash([
        row.txn_date, row.category, row.security, row.action, row.transaction_type,
        quantity.toFixed(6), price.toFixed(6), amount.toFixed(6),
      ].join("|"));
      rows.push(row);
    } catch (e) {
      // Skip unparseable rows (e.g. blank trailing lines) rather than fail.
      if (clean(g("txn_date")) === "") continue;
      throw e;
    }
  }
  return rows;
}
