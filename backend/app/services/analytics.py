"""Derive holdings, balances over time, and contribution history from transactions.

Everything here is computed on the fly from the raw transaction ledger, so the
numbers always reconcile with what was imported.

Flow classification (from the free-text Transaction Type):
  * contribution : EE Pre-Tax / Employer Match / Profit Sharing  -> real money in
  * dividend     : REINVDIV / "Dividend of ..."                  -> reinvested earnings
  * reallocation : "Buy N units" / "Sell N units"                -> internal transfer
  * adjustment   : "Gain/Loss ..."                               -> valuation tweak
"""
from __future__ import annotations

from datetime import date
from typing import Iterable

import pandas as pd
from sqlmodel import Session, select

from ..models import Transaction


def _classify(txn_type: str, action: str) -> str:
    t = (txn_type or "").lower()
    if t.startswith(("ee pre-tax", "employee", "employer match", "profit sharing", "roth", "after-tax")):
        return "contribution"
    if action.upper() == "REINVDIV" or t.startswith("dividend"):
        return "dividend"
    if t.startswith("gain/loss"):
        return "adjustment"
    if t.startswith(("buy", "sell")):
        return "reallocation"
    return "other"


def load_df(session: Session) -> pd.DataFrame:
    txns = session.exec(select(Transaction).order_by(Transaction.txn_date)).all()
    if not txns:
        return pd.DataFrame(
            columns=[
                "txn_date", "category", "security", "fund_name", "action",
                "transaction_type", "quantity", "price", "amount", "flow",
            ]
        )
    df = pd.DataFrame([t.model_dump() for t in txns])
    df["txn_date"] = pd.to_datetime(df["txn_date"])
    df["flow"] = [
        _classify(tt, ac) for tt, ac in zip(df["transaction_type"], df["action"])
    ]
    return df.sort_values("txn_date").reset_index(drop=True)


def latest_prices(df: pd.DataFrame) -> dict[str, float]:
    """Most recent non-zero price seen per security."""
    prices: dict[str, float] = {}
    for sec, grp in df[df["price"] > 0].groupby("security"):
        prices[sec] = float(grp.sort_values("txn_date")["price"].iloc[-1])
    return prices


def holdings(df: pd.DataFrame) -> list[dict]:
    """Current position per fund: shares, price, market value, cost basis, gain."""
    if df.empty:
        return []
    prices = latest_prices(df)
    out = []
    for sec, grp in df.groupby("security"):
        shares = float(grp["quantity"].sum())
        # <= 0 means fully exited (reallocated away). A slightly negative net
        # share count means the export is missing early buys; either way the
        # position is closed and contributes $0 -- surfaced via data_quality().
        if shares <= 1e-6:
            continue
        price = prices.get(sec, 0.0)
        mkt = shares * price
        # Cost basis = net cash put into this fund (contribs + reinvest - sells).
        cost = float(grp["amount"].sum())
        fund_name = grp["fund_name"].iloc[-1] or sec
        out.append(
            {
                "security": sec,
                "fund_name": fund_name,
                "shares": round(shares, 4),
                "price": round(price, 4),
                "market_value": round(mkt, 2),
                "cost_basis": round(cost, 2),
                "gain": round(mkt - cost, 2),
                "gain_pct": round((mkt - cost) / cost * 100, 2) if cost > 0 else 0.0,
            }
        )
    return sorted(out, key=lambda h: h["market_value"], reverse=True)


def summary(df: pd.DataFrame) -> dict:
    if df.empty:
        return {
            "market_value": 0.0, "total_contributions": 0.0,
            "employee_contributions": 0.0, "employer_contributions": 0.0,
            "dividends": 0.0, "total_gain": 0.0, "first_date": None, "last_date": None,
        }
    h = holdings(df)
    mkt = sum(x["market_value"] for x in h)

    contrib = df[df["flow"] == "contribution"]
    employee = float(
        contrib[contrib["category"].str.contains("Employee", case=False, na=False)]["amount"].sum()
    )
    employer = float(
        contrib[~contrib["category"].str.contains("Employee", case=False, na=False)]["amount"].sum()
    )
    total_contrib = float(contrib["amount"].sum())
    dividends = float(df[df["flow"] == "dividend"]["amount"].sum())

    return {
        "market_value": round(mkt, 2),
        "total_contributions": round(total_contrib, 2),
        "employee_contributions": round(employee, 2),
        "employer_contributions": round(employer, 2),
        "dividends": round(dividends, 2),
        "total_gain": round(mkt - total_contrib, 2),
        "first_date": df["txn_date"].min().date().isoformat(),
        "last_date": df["txn_date"].max().date().isoformat(),
    }


def balance_series(df: pd.DataFrame, freq: str = "ME") -> list[dict]:
    """Month-end time series of market value vs cumulative contributions.

    Shares are accumulated per fund; each fund is valued at its last known price
    on/before the period end and summed.
    """
    if df.empty:
        return []
    df = df.sort_values("txn_date")
    start = df["txn_date"].min().normalize()
    end = df["txn_date"].max().normalize()
    periods = pd.date_range(start=start, end=end, freq=freq)
    # Ensure the final actual date is represented.
    if len(periods) == 0 or periods[-1] < end:
        periods = periods.append(pd.DatetimeIndex([end]))

    securities = df["security"].unique()
    series = []
    for pe in periods:
        upto = df[df["txn_date"] <= pe]
        mkt = 0.0
        for sec in securities:
            sub = upto[upto["security"] == sec]
            if sub.empty:
                continue
            shares = float(sub["quantity"].sum())
            if shares <= 1e-6:  # closed / over-sold position holds no value
                continue
            priced = sub[sub["price"] > 0]
            if priced.empty:
                continue
            price = float(priced["price"].iloc[-1])
            mkt += shares * price
        contrib_cum = float(upto[upto["flow"] == "contribution"]["amount"].sum())
        series.append(
            {
                "date": pe.date().isoformat(),
                "market_value": round(mkt, 2),
                "contributions_cum": round(contrib_cum, 2),
                "gain_cum": round(mkt - contrib_cum, 2),
            }
        )
    return series


def data_quality(df: pd.DataFrame) -> list[dict]:
    """Detect signs the imported ledger is incomplete or inconsistent.

    The main check: a long-only 401k can never hold negative shares, so if the
    running share count for a fund ever goes below zero, buys are missing from
    the export (usually because history was truncated before some start date).
    """
    warnings: list[dict] = []
    if df.empty:
        return warnings
    for sec, grp in df.sort_values("txn_date").groupby("security"):
        running = grp["quantity"].cumsum()
        min_shares = float(running.min())
        net_shares = float(grp["quantity"].sum())
        if net_shares < -1e-4 or min_shares < -1e-4:
            fund = grp["fund_name"].iloc[-1] or sec
            warnings.append(
                {
                    "security": sec,
                    "fund_name": fund,
                    "severity": "warning",
                    "message": (
                        f"{sec} sold more shares than the imported history shows were "
                        f"bought (net {net_shares:.2f}). Early transactions are likely "
                        f"missing, so balances before {grp['txn_date'].min().date()} may "
                        f"be understated. Import an earlier statement to complete it."
                    ),
                }
            )
    return warnings


def contributions_by_year(df: pd.DataFrame) -> list[dict]:
    if df.empty:
        return []
    c = df[df["flow"] == "contribution"].copy()
    if c.empty:
        return []
    c["year"] = c["txn_date"].dt.year
    c["is_employee"] = c["category"].str.contains("Employee", case=False, na=False)
    out = []
    for year, grp in c.groupby("year"):
        emp = float(grp[grp["is_employee"]]["amount"].sum())
        empr = float(grp[~grp["is_employee"]]["amount"].sum())
        out.append(
            {
                "year": int(year),
                "employee": round(emp, 2),
                "employer": round(empr, 2),
                "total": round(emp + empr, 2),
            }
        )
    return sorted(out, key=lambda x: x["year"])
