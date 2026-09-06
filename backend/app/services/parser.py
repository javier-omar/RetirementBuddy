"""Parse 401k transaction report files (CSV / XLSX) into normalized rows.

Handles the quirks seen in real exports:
  * Accounting negatives in parentheses:  (0.149000) and $(2.10)  -> negative
  * Currency symbols and thousands separators: "$1,234.56"
  * Trailing tabs/whitespace in fund names
  * Slightly different column headers (fuzzy-matched)
"""
from __future__ import annotations

import hashlib
import io
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Optional

import pandas as pd

# Canonical field -> list of accepted header variants (lowercased, stripped).
COLUMN_ALIASES: dict[str, list[str]] = {
    "txn_date": ["date", "transaction date", "trade date"],
    "category": ["category", "source", "money source"],
    "portfolio": ["portfolio(if applicable)", "portfolio", "account"],
    "security": ["security", "ticker", "symbol"],
    "fund_name": ["fund name", "fund", "investment", "investment name"],
    "action": ["action", "activity"],
    "transaction_type": ["transaction type", "description", "details"],
    "quantity": ["quantity", "units", "shares"],
    "price": ["price", "unit price", "share price", "nav"],
    "amount": ["amount", "total", "dollar amount"],
}

DATE_FORMATS = ["%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%m-%d-%Y"]


@dataclass
class ParsedRow:
    txn_date: date
    category: str
    portfolio: str
    security: str
    fund_name: str
    action: str
    transaction_type: str
    quantity: float
    price: float
    amount: float

    def row_hash(self) -> str:
        key = "|".join(
            [
                self.txn_date.isoformat(),
                self.category,
                self.security,
                self.action,
                self.transaction_type,
                f"{self.quantity:.6f}",
                f"{self.price:.6f}",
                f"{self.amount:.6f}",
            ]
        )
        return hashlib.sha256(key.encode()).hexdigest()

    def as_dict(self) -> dict:
        return asdict(self)


class ParseError(Exception):
    pass


def _clean(text) -> str:
    if text is None or (isinstance(text, float) and pd.isna(text)):
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def parse_number(raw) -> float:
    """Parse a money/quantity cell into a signed float.

    Accounting parentheses -> negative.  Handles $, commas, spaces, N/A.
    """
    if raw is None:
        return 0.0
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    s = str(raw).strip()
    if s == "" or s.upper() in {"N/A", "NA", "-", "--"}:
        return 0.0
    # Strip currency symbols/separators first so "$(2.10)" -> "(2.10)".
    s = s.replace("$", "").replace(",", "").replace("%", "").strip()
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1].strip()
    # A leading minus may also appear.
    if s.startswith("-"):
        negative = True
        s = s[1:]
    if s == "":
        return 0.0
    try:
        val = float(s)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ParseError(f"Could not parse number: {raw!r}") from exc
    return -val if negative else val


def parse_date(raw) -> date:
    if isinstance(raw, (datetime, pd.Timestamp)):
        return raw.date()
    if isinstance(raw, date):
        return raw
    s = _clean(raw)
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    # Last resort: let pandas guess.
    try:
        return pd.to_datetime(s).date()
    except Exception as exc:
        raise ParseError(f"Unrecognized date: {raw!r}") from exc


def _build_header_map(columns: list[str]) -> dict[str, str]:
    """Map canonical field -> actual column name present in the file."""
    normalized = {c: _clean(c).lower() for c in columns}
    mapping: dict[str, str] = {}
    for field, aliases in COLUMN_ALIASES.items():
        for col, norm in normalized.items():
            if norm in aliases:
                mapping[field] = col
                break
    return mapping


REQUIRED = ["txn_date", "amount"]


def parse_file(content: bytes, filename: str) -> list[ParsedRow]:
    """Parse raw file bytes into ParsedRow objects."""
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        df = pd.read_excel(io.BytesIO(content), dtype=str)
    else:
        # dtype=str keeps parentheses/`$` intact for our own parsing.
        df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)

    header_map = _build_header_map(list(df.columns))
    missing = [f for f in REQUIRED if f not in header_map]
    if missing:
        raise ParseError(
            f"Missing required column(s): {missing}. Found headers: {list(df.columns)}"
        )

    rows: list[ParsedRow] = []
    for _, r in df.iterrows():
        def g(field: str) -> Optional[str]:
            col = header_map.get(field)
            return r[col] if col is not None else None

        try:
            row = ParsedRow(
                txn_date=parse_date(g("txn_date")),
                category=_clean(g("category")),
                portfolio=_clean(g("portfolio")),
                security=_clean(g("security")),
                fund_name=_clean(g("fund_name")),
                action=_clean(g("action")),
                transaction_type=_clean(g("transaction_type")),
                quantity=parse_number(g("quantity")),
                price=parse_number(g("price")),
                amount=parse_number(g("amount")),
            )
        except ParseError:
            # Skip unparseable rows (e.g. blank trailing lines) rather than fail.
            if _clean(g("txn_date")) == "":
                continue
            raise
        rows.append(row)
    return rows
