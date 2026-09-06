export const usd = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

export const usdCompact = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  });

export const pct = (n: number, decimals = 1) => `${(n * 100).toFixed(decimals)}%`;

export const num = (n: number, decimals = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * Format a raw text string as a money value with thousands separators, while
 * the user is typing. Keeps a single leading minus, a single decimal point, and
 * any digits the user has entered after it (so "99045.6" -> "99,045.6" mid-type,
 * without forcing trailing zeros). Empty stays empty.
 */
export function formatMoneyInput(raw: string): string {
  const neg = raw.trim().startsWith("-");
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  let intPart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const decPart = dot === -1 ? null : cleaned.slice(dot + 1).replace(/\./g, "");
  intPart = intPart.replace(/^0+(?=\d)/, ""); // drop leading zeros ("007" -> "7")
  const grouped =
    intPart === ""
      ? decPart !== null
        ? "0"
        : ""
      : intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let out = grouped;
  if (decPart !== null) out += "." + decPart;
  return neg && out !== "" ? "-" + out : out;
}

/** Parse a comma-formatted money string back to a number (0 when blank). */
export function parseMoneyInput(raw: string): number {
  const n = parseFloat(raw.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}
