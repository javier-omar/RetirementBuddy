"""Retirement projection engine.

Rebuilds the user's spreadsheet model and adds enhancements:
  * Mid-year contribution compounding (contributions earn ~half a year of growth)
  * Nominal vs. real (today's-dollars) output toggle
  * Social Security claim-age scenarios
  * Required Minimum Distributions (RMDs) from age 73 (SECURE 2.0)
  * Monte Carlo success probability (random annual returns)
"""
from __future__ import annotations

import math
import random
from datetime import date

# IRS Uniform Lifetime Table distribution periods (age -> divisor).
RMD_TABLE = {
    73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1,
    80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2,
    87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1,
    94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4,
}

# Neutral starting values only — every one of these is editable in the app and
# your own figures live in the local database, not here.
DEFAULT_ASSUMPTIONS: dict[str, float] = {
    "current_age": 35,
    "retirement_age": 65,
    "life_expectancy": 90,
    "ss_claim_age": 67,
    "ss_annual_benefit": 30000,      # annual SS at the chosen claim age
    "current_salary": 75000,
    "salary_growth": 0.02,
    "employee_contrib_pct": 0.10,
    "employer_match_pct": 0.50,
    "match_cap_pct": 0.06,
    "employer_profit_sharing_pct": 0.0,
    "nominal_return": 0.08,
    "inflation": 0.03,
    "return_volatility": 0.15,       # stdev of annual returns, for Monte Carlo
    "tax_rate_401k": 0.15,
    "tax_rate_ss": 0.0,
    "annual_spending": 50000,
    "bridge_withdrawal": 60000,      # withdrawal in years before SS starts
    "post_ss_withdrawal": 60000,     # withdrawal once SS is claimed
    "apply_rmd": 1,                  # 1 = enforce RMDs, 0 = ignore
    "index_to_inflation": 1,         # 1 = grow withdrawals/SS/spending with inflation
    "retirement_goal_today": 0,      # Coast FIRE goal in today's $ (0 = auto from plan)

    # --- Contribution limits (editable: caps vary by jurisdiction and plan) ---
    "limit_employee_deferral": 23500,  # annual elective deferral cap (0 = no limit)
    "limit_catchup": 7500,             # extra allowed from catchup_age (0 = none)
    "catchup_age": 50,
    "limit_total_415c": 70000,         # employee + employer combined cap (0 = no limit)
    "index_limits": 1,                 # grow the caps with inflation each year

    # --- Contribution escalation ---
    "contrib_escalation": 0.0,         # add this many points to your % each year
    "contrib_escalation_cap": 0.0,     # stop escalating at this % (0 = no cap)

    # --- Roth ---
    "roth_share": 0.0,                 # fraction of the balance that's Roth (tax-free)

    # --- Other assets & income outside this 401(k) ---
    "other_assets_today": 0,           # other invested balances, grows at the same return
    "other_income_annual": 0,          # pension/rental/part-time, today's $/yr
    "other_income_start_age": 0,       # 0 = starts at retirement
    "tax_rate_other_income": 0.0,

    # --- Healthcare (on top of annual_spending, today's $) ---
    "healthcare_pre65": 0,             # retirement -> medicare_age
    "healthcare_post65": 0,            # medicare_age -> end of plan
    "medicare_age": 65,

    # --- Progressive tax (used only when a bracket table exists) ---
    "standard_deduction": 0,           # today's $, subtracted before brackets apply

    # --- Withdrawal buckets (Assets & Debts tab) ---
    "cap_gains_rate": 0.15,            # tax on gains from taxable buckets
    "cash_savings_rate": 0.02,         # growth on surplus withdrawals kept as cash
    # Withdrawal order by tax type (lower = drawn first). Default is tax-smart:
    # spend cash/taxable first, tax-deferred next, Roth last.
    "order_cash": 1,
    "order_taxable": 2,
    "order_deferred": 3,
    "order_roth": 4,
}


def _limits_for_year(a: dict, year: int, base_year: int) -> tuple[float, float, float]:
    """Contribution caps for a given year, optionally indexed to inflation."""
    f = (1 + a["inflation"]) ** (year - base_year) if a.get("index_limits", 1) else 1.0
    return (
        a.get("limit_employee_deferral", 0) * f,
        a.get("limit_catchup", 0) * f,
        a.get("limit_total_415c", 0) * f,
    )


def _contributions(
    a: dict, salary: float, age: int, emp_pct: float, year: int, base_year: int
) -> tuple[float, float]:
    """Employee and employer contributions for one year, after applying caps."""
    deferral_cap, catchup, total_cap = _limits_for_year(a, year, base_year)
    employee = salary * emp_pct
    if deferral_cap > 0:
        cap = deferral_cap + (catchup if age >= a.get("catchup_age", 50) else 0.0)
        employee = min(employee, cap)
    matched_base = min(emp_pct, a["match_cap_pct"]) * salary
    employer = matched_base * a["employer_match_pct"] + salary * a["employer_profit_sharing_pct"]
    if total_cap > 0 and employee + employer > total_cap:
        employer = max(total_cap - employee, 0.0)
    return employee, employer


def _escalate(a: dict, emp_pct: float) -> float:
    """Bump the contribution rate for the next year, respecting any cap."""
    step = a.get("contrib_escalation", 0.0)
    if step <= 0:
        return emp_pct
    cap = a.get("contrib_escalation_cap", 0.0)
    nxt = emp_pct + step
    return min(nxt, cap) if cap > 0 else nxt


def effective_start_balance(a: dict, start_balance: float) -> float:
    """401(k) balance plus any other invested assets the user tracks elsewhere."""
    return start_balance + a.get("other_assets_today", 0.0)


def _events_by_age(events: list[dict] | None) -> dict[int, float]:
    """Collapse life events into {age: total amount in today's dollars}."""
    out: dict[int, float] = {}
    for e in events or []:
        age = int(e["age"])
        out[age] = out.get(age, 0.0) + float(e["amount"])
    return out


def _event_amount(by_age: dict[int, float], age: int, a: dict, year: int, base_year: int) -> float:
    """A year's net life-event cash flow, inflated to that year if indexing is on."""
    amt = by_age.get(age, 0.0)
    if not amt:
        return 0.0
    if a.get("index_to_inflation", 1):
        amt *= (1 + a["inflation"]) ** (year - base_year)
    return amt


def _progressive_tax(income: float, brackets: list[dict], factor: float = 1.0) -> float:
    """Tax on `income` using ascending brackets. `factor` inflates the (today's
    dollars) thresholds into the year being computed."""
    if income <= 0 or not brackets:
        return 0.0
    rows = sorted(brackets, key=lambda b: b["threshold"])
    tax = 0.0
    for i, b in enumerate(rows):
        lo = b["threshold"] * factor
        hi = rows[i + 1]["threshold"] * factor if i + 1 < len(rows) else float("inf")
        if income > lo:
            tax += (min(income, hi) - lo) * b["rate"]
    return tax


def merged(assumptions: dict | None) -> dict:
    a = dict(DEFAULT_ASSUMPTIONS)
    if assumptions:
        a.update({k: float(v) for k, v in assumptions.items() if v is not None})
    return a


def _rmd_divisor(age: int) -> float:
    if age < 73:
        return 0.0
    return RMD_TABLE.get(age, RMD_TABLE[100])


def run_accumulation(
    a: dict, start_balance: float, start_year: int, events: list[dict] | None = None
) -> list[dict]:
    """Year-by-year accumulation from current_age to retirement_age."""
    rows = []
    balance = start_balance
    salary = a["current_salary"]
    r = a["nominal_return"]
    age = int(a["current_age"])
    ret_age = int(a["retirement_age"])
    year = start_year
    emp_pct = a["employee_contrib_pct"]
    by_age = _events_by_age(events)
    while age < ret_age:
        uncapped = salary * emp_pct
        employee, employer = _contributions(a, salary, age, emp_pct, year, start_year)
        contrib = employee + employer
        # Enhancement: balance grows a full year, contributions ~half a year.
        growth = balance * r + contrib * (math.sqrt(1 + r) - 1)
        event = _event_amount(by_age, age, a, year, start_year)
        end = max(balance + contrib + growth + event, 0.0)
        rows.append(
            {
                "year": year,
                "age": age,
                "salary": round(salary, 2),
                "start_balance": round(balance, 2),
                "employee_contribution": round(employee, 2),
                "employer_contribution": round(employer, 2),
                "total_contribution": round(contrib, 2),
                "contribution_capped": uncapped - employee > 0.01,
                "growth": round(growth, 2),
                "life_event": round(event, 2),
                "end_balance": round(end, 2),
            }
        )
        balance = end
        salary *= 1 + a["salary_growth"]
        emp_pct = _escalate(a, emp_pct)
        age += 1
        year += 1
    return rows


def _grow_asset(asset: dict, a: dict, start_year: int, ret_year: int) -> tuple[float, float]:
    """Grow one other-asset from today to retirement at its own rate, adding its
    annual contribution (mid-year, like the 401k). Returns (value, cost_basis)."""
    bal = float(asset.get("value", 0.0))
    basis = float(asset.get("cost_basis", 0.0)) or bal  # unknown basis -> assume all basis
    rate = float(asset.get("growth_rate", 0.0))
    contrib0 = float(asset.get("contribution_annual", 0.0))
    index = bool(a.get("index_to_inflation", 1))
    for y in range(start_year, ret_year):
        c = contrib0 * ((1 + a["inflation"]) ** (y - start_year) if index else 1.0)
        bal += c + bal * rate + c * (math.sqrt(1 + rate) - 1)
        basis += c
    return bal, min(basis, bal)


def _build_buckets(
    a: dict, port_at_ret: float, assets: list[dict] | None, start_year: int, ret_year: int
) -> list[dict]:
    """Assemble the retirement withdrawal buckets: the 401(k) (split into
    traditional + Roth by roth_share) plus each grown other asset."""
    roth = min(max(a.get("roth_share", 0.0), 0.0), 1.0)
    buckets = [{
        "name": "401(k)", "value": port_at_ret * (1 - roth), "rate": a["nominal_return"],
        "tax": "deferred", "basis": 0.0, "is_market": True,
    }]
    if roth > 0:
        buckets.append({
            "name": "401(k) Roth", "value": port_at_ret * roth, "rate": a["nominal_return"],
            "tax": "roth", "basis": 0.0, "is_market": True,
        })
    for asset in assets or []:
        val, basis = _grow_asset(asset, a, start_year, ret_year)
        buckets.append({
            "name": asset.get("name") or asset.get("tax_type", "asset"),
            "value": val, "rate": float(asset.get("growth_rate", 0.0)),
            "tax": asset.get("tax_type", "taxable"), "basis": basis,
            "is_market": bool(asset.get("is_market", 1)),
        })
    return buckets


def _assets_at_retirement(a: dict, assets: list[dict] | None, start_year: int, ret_year: int) -> float:
    return sum(_grow_asset(x, a, start_year, ret_year)[0] for x in (assets or []))


def _withdrawal_order(a: dict, buckets: list[dict]) -> list[int]:
    """Indices of buckets in the order they should be drawn from."""
    rank = {t: a.get(f"order_{t}", i + 1) for i, t in enumerate(["cash", "taxable", "deferred", "roth"])}
    return sorted(range(len(buckets)), key=lambda i: (rank.get(buckets[i]["tax"], 9), i))


def _loan_schedules(loans: list[dict] | None, a: dict, start_year: int) -> dict:
    """Amortize each loan month-by-month. Returns {payment_by_age, payoff_age,
    lump_by_age} where payments/lumps are keyed by the person's age."""
    cur_age = int(a["current_age"])
    payment_by_age: dict[int, float] = {}
    lump_by_age: dict[int, float] = {}
    payoffs: list[dict] = []
    for loan in loans or []:
        bal = float(loan.get("balance", 0.0))
        if bal <= 0:
            continue
        mr = float(loan.get("annual_rate", 0.0)) / 12.0
        n = int(loan.get("months_remaining", 0))
        if mr > 0 and n > 0:
            pmt = bal * mr / (1 - (1 + mr) ** -n)
        elif n > 0:
            pmt = bal / n
        else:
            pmt = 0.0
        pmt += float(loan.get("extra_payment_monthly", 0.0))
        lump_age = int(loan.get("lump_sum_payoff_age", 0) or 0)
        month = 0
        payoff_age = None
        while bal > 0.01 and month < 1200:
            age = cur_age + month // 12
            if lump_age and age >= lump_age:
                lump_by_age[age] = lump_by_age.get(age, 0.0) + bal
                payoff_age = age
                bal = 0.0
                break
            interest = bal * mr
            if pmt <= interest:  # never amortizes
                payoff_age = None
                break
            principal = min(pmt - interest, bal)
            pay = interest + principal
            bal -= principal
            payment_by_age[age] = payment_by_age.get(age, 0.0) + pay
            month += 1
        if bal <= 0.01 and payoff_age is None:
            payoff_age = cur_age + (month - 1) // 12
        payoffs.append({"name": loan.get("name", "Loan"), "payoff_age": payoff_age})
    return {"payment_by_age": payment_by_age, "lump_by_age": lump_by_age, "payoffs": payoffs}


def _gross_up_ordinary(
    base: float, net_needed: float, brackets: list[dict] | None, flat_rate: float,
    factor: float, deduction: float,
) -> tuple[float, float]:
    """Gross withdrawal (and its tax) needed to net `net_needed` of ordinary
    income, given `base` ordinary income already taken this year. Walks the
    progressive brackets exactly; falls back to a flat rate when no table."""
    if net_needed <= 0:
        return 0.0, 0.0
    if not brackets:
        r = min(max(flat_rate, 0.0), 0.99)
        gross = net_needed / (1 - r)
        return gross, gross * r
    rows = sorted(brackets, key=lambda b: b["threshold"])
    thresholds = [b["threshold"] * factor + deduction for b in rows]  # ordinary-income boundaries
    rates = [b["rate"] for b in rows]
    gross = 0.0
    tax = 0.0
    net = 0.0
    pos = base
    while net < net_needed - 1e-6:
        # marginal rate at current ordinary position
        r = 0.0
        for i in range(len(rows)):
            if pos >= thresholds[i]:
                r = rates[i]
        # distance to the next boundary above pos
        nxt = min([t for t in thresholds if t > pos], default=float("inf"))
        step_gross = nxt - pos
        step_net = step_gross * (1 - r)
        if net + step_net >= net_needed:
            g = (net_needed - net) / (1 - r) if r < 1 else (net_needed - net)
            gross += g
            tax += g * r
            net = net_needed
        else:
            gross += step_gross
            tax += step_gross * r
            net += step_net
            pos = nxt
    return gross, tax


def run_drawdown(
    a: dict,
    start_balance: float,
    start_year: int,
    base_year: int | None = None,
    events: list[dict] | None = None,
    brackets: list[dict] | None = None,
    assets: list[dict] | None = None,
    loans: list[dict] | None = None,
    market_returns: list[float] | None = None,
) -> list[dict]:
    """Year-by-year drawdown from retirement_age to life_expectancy.

    When ``index_to_inflation`` is on (the default), the withdrawal, Social
    Security, and spending inputs are treated as *today's dollars* and grown by
    inflation each year so their purchasing power stays constant. ``base_year``
    is the projection's start year (today); the inflation factor for a given
    calendar year is ``(1+inflation)**(year - base_year)``. With the flag off,
    those amounts stay flat in nominal dollars (the original behavior).
    """
    rows = []
    ret_age = int(a["retirement_age"])
    life = int(a["life_expectancy"])
    claim_age = int(a["ss_claim_age"])
    base_year = start_year if base_year is None else base_year
    index = bool(a.get("index_to_inflation", 1))
    inflation = a["inflation"]
    flat_401k = a["tax_rate_401k"]
    cg_rate = a.get("cap_gains_rate", 0.15)
    by_age = _events_by_age(events)

    # Assemble buckets (401k split by Roth share + grown other assets) and the
    # order to draw them down. `start_year` here is the retirement year.
    buckets = _build_buckets(a, start_balance, assets, base_year, start_year)
    # A cash-savings reservoir holds any withdrawal proceeds beyond spending
    # (e.g. when a withdrawal floor exceeds actual need) so nothing is lost. It
    # grows at the cash rate and is only spent as a last resort (drawn last).
    surplus_idx = len(buckets)
    buckets.append({
        "name": "Cash savings", "value": 0.0, "rate": a.get("cash_savings_rate", 0.02),
        "tax": "cash", "basis": 0.0, "is_market": False, "auto": True,
    })
    order = [i for i in _withdrawal_order(a, buckets) if i != surplus_idx] + [surplus_idx]
    sched = _loan_schedules(loans, a, base_year)

    def ordinary_tax(income: float, deduction: float) -> float:
        if income <= 0:
            return 0.0
        if brackets:
            return _progressive_tax(max(income - deduction, 0.0), brackets, 1.0)
        return income * flat_401k  # deduction only applies with a bracket table

    year = start_year
    for idx, age in enumerate(range(ret_age, life + 1)):
        factor = (1 + inflation) ** (year - base_year) if index else 1.0
        deduction = a.get("standard_deduction", 0.0) * factor
        start = sum(b["value"] for b in buckets)

        # Grow every bucket (its own rate, or a shared random market return in MC).
        growth = 0.0
        for b in buckets:
            rate = market_returns[idx] if (market_returns and b["is_market"]) else b["rate"]
            g = b["value"] * rate
            b["value"] += g
            growth += g

        ss = (a["ss_annual_benefit"] if age >= claim_age else 0.0) * factor
        other_start = int(a.get("other_income_start_age") or ret_age)
        other_income = (a.get("other_income_annual", 0.0) if age >= other_start else 0.0) * factor
        tax_ss = ss * a["tax_rate_ss"]
        tax_other = (
            _progressive_tax(max(other_income - deduction, 0.0), brackets, 1.0)
            if brackets else other_income * a.get("tax_rate_other_income", 0.0)
        )
        income_net = (ss - tax_ss) + (other_income - tax_other)

        medicare_age = int(a.get("medicare_age", 65))
        healthcare = a.get("healthcare_pre65", 0.0) if age < medicare_age else a.get("healthcare_post65", 0.0)
        loan_payment = sched["payment_by_age"].get(age, 0.0) + sched["lump_by_age"].get(age, 0.0)
        base_spending = (a["annual_spending"] + healthcare) * factor
        spending = base_spending + loan_payment

        event = _event_amount(by_age, age, a, year, base_year)  # + inflow / - outflow
        # Net (after-tax) cash to withdraw. The bridge/post-SS figures are a
        # *minimum living* withdrawal; income covers base spending first, and
        # healthcare + loans always add on top so they affect longevity.
        base_need = max(base_spending - income_net, 0.0)
        living_floor = (a["post_ss_withdrawal"] if age >= claim_age else a["bridge_withdrawal"]) * factor
        base_target = max(base_need, living_floor)
        income_left = max(income_net - base_spending, 0.0)
        extras = (healthcare * factor) + loan_payment
        extra_need = max(extras - income_left, 0.0)
        net_need = max(base_target + extra_need - max(event, 0.0), 0.0)

        # Withdraw from buckets in order, grossing up for each bucket's tax.
        ordinary_taken = other_income  # deferred withdrawals stack above other income
        tot_gross = tax_def = tax_cg = 0.0

        def pull_deferred(bucket, gross):
            nonlocal ordinary_taken, tax_def
            gross = min(gross, bucket["value"])
            tx = ordinary_tax(ordinary_taken + gross, deduction) - ordinary_tax(ordinary_taken, deduction)
            ordinary_taken += gross
            tax_def += tx
            bucket["value"] -= gross
            return gross, gross - tx  # gross, net

        def pull_net(bucket, net_target):
            """Withdraw enough gross from `bucket` to net `net_target` (capped)."""
            nonlocal tax_cg
            if bucket["value"] <= 1e-9 or net_target <= 0:
                return 0.0, 0.0
            t = bucket["tax"]
            if t in ("roth", "cash"):
                g = min(net_target, bucket["value"])
                bucket["value"] -= g
                return g, g
            if t == "taxable":
                gf = max(bucket["value"] - bucket["basis"], 0.0) / bucket["value"]
                eff = gf * cg_rate
                g = min(net_target / (1 - eff) if eff < 1 else net_target, bucket["value"])
                bucket["basis"] -= g * (bucket["basis"] / (bucket["value"] + g)) if (bucket["value"] + g) else 0.0
                bucket["value"] -= g
                tax = g * eff
                tax_cg += tax
                return g, g - tax
            # deferred: solve gross for the desired net given current ordinary base
            gross, _tx = _gross_up_ordinary(ordinary_taken, net_target, brackets, flat_401k, 1.0, deduction)
            return pull_deferred(bucket, gross)

        # 1) RMD floor from tax-deferred buckets (proportional).
        deferred_idx = [i for i in range(len(buckets)) if buckets[i]["tax"] == "deferred"]
        deferred_total = sum(buckets[i]["value"] for i in deferred_idx)
        rmd = deferred_total / _rmd_divisor(age) if (a.get("apply_rmd", 1) and age >= 73) else 0.0
        rmd = min(rmd, deferred_total)
        remaining_net = net_need
        if rmd > 0:
            for i in deferred_idx:
                share = buckets[i]["value"] / deferred_total if deferred_total else 0.0
                g, net = pull_deferred(buckets[i], rmd * share)
                tot_gross += g
                remaining_net = max(remaining_net - net, 0.0)

        # 2) Cover the remaining need in withdrawal order.
        for i in order:
            if remaining_net <= 1e-6:
                break
            g, net = pull_net(buckets[i], remaining_net)
            tot_gross += g
            remaining_net -= net

        # 3) Positive life events land in the first bucket (kept invested).
        if event > 0:
            buckets[order[0] if order else 0]["value"] += event
            if buckets[order[0] if order else 0]["tax"] == "taxable":
                buckets[order[0]]["basis"] += event

        after_tax_income = (tot_gross - tax_def - tax_cg) + income_net
        # Money withdrawn but not spent is kept as cash rather than lost.
        surplus = after_tax_income - spending
        if surplus > 1e-6:
            buckets[surplus_idx]["value"] += surplus

        end = sum(b["value"] for b in buckets)
        visible = [b for b in buckets if not (b.get("auto") and b["value"] < 0.01)]
        rows.append(
            {
                "year": year,
                "age": age,
                "start_balance": round(start, 2),
                "growth": round(growth, 2),
                "withdrawal": round(tot_gross, 2),
                "rmd": round(rmd, 2),
                "social_security": round(ss, 2),
                "other_income": round(other_income, 2),
                "tax_401k": round(tax_def, 2),
                "tax_capgains": round(tax_cg, 2),
                "tax_ss": round(tax_ss, 2),
                "tax_other": round(tax_other, 2),
                "after_tax_income": round(after_tax_income, 2),
                "healthcare": round(healthcare * factor, 2),
                "loan_payment": round(loan_payment, 2),
                "life_event": round(event, 2),
                "spending": round(spending, 2),
                "net_cash_flow": round(after_tax_income - spending, 2),
                "end_balance": round(end, 2),
                "buckets": [{"name": b["name"], "tax": b["tax"], "balance": round(b["value"], 2)} for b in visible],
            }
        )
        year += 1
    return rows


def _deflate(rows: list[dict], inflation: float, base_year: int, fields: list[str]) -> list[dict]:
    """Convert nominal dollar fields into today's dollars."""
    out = []
    for row in rows:
        real = dict(row)
        n = row["year"] - base_year
        factor = (1 + inflation) ** n
        for f in fields:
            if f in real and real[f] is not None:
                real[f] = round(real[f] / factor, 2)
        if isinstance(real.get("buckets"), list):
            real["buckets"] = [
                {**b, "balance": round(b["balance"] / factor, 2)} for b in real["buckets"]
            ]
        out.append(real)
    return out


DRAWDOWN_MONEY_FIELDS = [
    "start_balance", "growth", "withdrawal", "rmd", "social_security", "other_income",
    "tax_401k", "tax_capgains", "tax_ss", "tax_other", "after_tax_income", "healthcare",
    "loan_payment", "life_event", "spending", "net_cash_flow", "end_balance",
]


def run_projection(
    assumptions: dict | None,
    start_balance: float,
    start_year: int | None = None,
    real_dollars: bool = False,
    events: list[dict] | None = None,
    brackets: list[dict] | None = None,
    assets: list[dict] | None = None,
    loans: list[dict] | None = None,
) -> dict:
    a = merged(assumptions)
    start_year = start_year or date.today().year
    accumulation = run_accumulation(a, start_balance, start_year, events)  # 401k only
    port_401k = accumulation[-1]["end_balance"] if accumulation else start_balance
    ret_year = start_year + (int(a["retirement_age"]) - int(a["current_age"]))
    drawdown = run_drawdown(a, port_401k, ret_year, base_year=start_year,
                            events=events, brackets=brackets, assets=assets, loans=loans)
    # Total pot at retirement = 401k + other assets grown to retirement.
    portfolio_at_retirement = (
        drawdown[0]["start_balance"] if drawdown
        else port_401k + _assets_at_retirement(a, assets, start_year, ret_year)
    )

    if real_dollars:
        accumulation = _deflate(
            accumulation, a["inflation"], start_year,
            ["salary", "start_balance", "employee_contribution", "employer_contribution",
             "total_contribution", "growth", "end_balance"],
        )
        drawdown = _deflate(drawdown, a["inflation"], start_year, DRAWDOWN_MONEY_FIELDS)
        portfolio_at_retirement = drawdown[0]["start_balance"] if drawdown else portfolio_at_retirement

    ending_balance = drawdown[-1]["end_balance"] if drawdown else portfolio_at_retirement
    depleted_age = next((row["age"] for row in drawdown if row["end_balance"] <= 0), None)
    first_withdrawal = drawdown[0]["withdrawal"] if drawdown else 0.0
    withdrawal_rate = (
        first_withdrawal / portfolio_at_retirement if portfolio_at_retirement else 0.0
    )

    return {
        "assumptions": a,
        "real_dollars": real_dollars,
        "accumulation": accumulation,
        "drawdown": drawdown,
        "summary": {
            "portfolio_at_retirement": round(portfolio_at_retirement, 2),
            "ending_balance": round(ending_balance, 2),
            "withdrawal_rate": round(withdrawal_rate, 4),
            "money_lasts": depleted_age is None,
            "depleted_age": depleted_age,
            "retirement_year": ret_year,
        },
    }


def _drawdown_summary(drawdown: list[dict], portfolio_at_retirement: float) -> dict:
    ending = drawdown[-1]["end_balance"] if drawdown else portfolio_at_retirement
    depleted_age = next((r["age"] for r in drawdown if r["end_balance"] <= 0), None)
    first_wd = drawdown[0]["withdrawal"] if drawdown else 0.0
    wr = first_wd / portfolio_at_retirement if portfolio_at_retirement else 0.0
    return {
        "portfolio_at_retirement": round(portfolio_at_retirement, 2),
        "ending_balance": round(ending, 2),
        "depleted_age": depleted_age,
        "money_lasts": depleted_age is None,
        "withdrawal_rate": round(wr, 4),
    }


def run_drawdown_scenarios(
    assumptions: dict | None,
    start_balance: float,
    scenarios: list[dict],
    start_year: int | None = None,
    real_dollars: bool = False,
    fixed_start: bool = True,
    events: list[dict] | None = None,
    brackets: list[dict] | None = None,
    assets: list[dict] | None = None,
    loans: list[dict] | None = None,
) -> dict:
    """Run the retirement drawdown under several scenarios for comparison.

    Each scenario is ``{"name": str, "overrides": {assumption: value}}`` and
    typically varies the return and/or the withdrawal amount.

    ``fixed_start=True`` (the default, matching the spreadsheet's Stress Test)
    starts every scenario from the *same* nest egg — the retirement portfolio
    implied by the base assumptions — so the chart isolates retirement/sequence
    risk. ``fixed_start=False`` also re-runs accumulation per scenario, so a
    different return compounds during the saving years too.
    """
    a = merged(assumptions)
    start_year = start_year or date.today().year
    ret_year = start_year + (int(a["retirement_age"]) - int(a["current_age"]))

    base_acc = run_accumulation(a, start_balance, start_year, events)  # 401k only
    base_port = base_acc[-1]["end_balance"] if base_acc else start_balance
    assets_at_ret = _assets_at_retirement(a, assets, start_year, ret_year)

    results = []
    for sc in scenarios:
        sa = dict(a)
        sa.update({k: float(v) for k, v in (sc.get("overrides") or {}).items()})
        if fixed_start:
            port = base_port
        else:
            acc = run_accumulation(sa, start_balance, start_year, events)
            port = acc[-1]["end_balance"] if acc else start_balance
        drawdown = run_drawdown(sa, port, ret_year, base_year=start_year,
                                events=events, brackets=brackets, assets=assets, loans=loans)
        total_port = drawdown[0]["start_balance"] if drawdown else port + assets_at_ret
        summary = _drawdown_summary(drawdown, total_port)
        if real_dollars:
            drawdown = _deflate(drawdown, a["inflation"], start_year, DRAWDOWN_MONEY_FIELDS)
            summary["ending_balance"] = drawdown[-1]["end_balance"] if drawdown else summary["ending_balance"]
        results.append(
            {
                "name": sc.get("name", "Scenario"),
                "overrides": sc.get("overrides", {}),
                "drawdown": drawdown,
                "summary": summary,
            }
        )

    return {
        "retirement_year": ret_year,
        "retirement_age": int(a["retirement_age"]),
        "ss_claim_age": int(a["ss_claim_age"]),
        "life_expectancy": int(a["life_expectancy"]),
        "annual_spending": a["annual_spending"],
        "base_portfolio_at_retirement": round(base_port + assets_at_ret, 2),
        "fixed_start": fixed_start,
        "real_dollars": real_dollars,
        "scenarios": results,
    }


def _drawdown_depletes(a: dict, start_balance: float, ret_year: int, base_year: int,
                       events=None, brackets=None, assets=None, loans=None) -> bool:
    dd = run_drawdown(a, start_balance, ret_year, base_year=base_year,
                      events=events, brackets=brackets, assets=assets, loans=loans)
    return any(r["end_balance"] <= 0 for r in dd)


def _required_nest_egg(a: dict, start_year: int, events=None, brackets=None,
                       assets=None, loans=None) -> float:
    """Smallest 401(k) retirement balance that funds the drawdown plan without
    depleting before life expectancy, given any other assets as extra buckets."""
    ret_year = start_year + (int(a["retirement_age"]) - int(a["current_age"]))
    hi = max(a["annual_spending"], a["post_ss_withdrawal"], a["bridge_withdrawal"], 1.0) * 30
    for _ in range(60):
        if not _drawdown_depletes(a, hi, ret_year, start_year, events, brackets, assets, loans):
            break
        hi *= 2
    lo = 0.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if _drawdown_depletes(a, mid, ret_year, start_year, events, brackets, assets, loans):
            lo = mid
        else:
            hi = mid
    return hi


def _balance_at_retirement_if_stop(
    a: dict, start_balance: float, stop_age: int, start_year: int,
    events: list[dict] | None = None,
) -> float:
    """Retirement balance if contributions continue until `stop_age`, then stop
    (the balance 'coasts' on growth alone the rest of the way)."""
    balance = start_balance
    salary = a["current_salary"]
    r = a["nominal_return"]
    age = int(a["current_age"])
    ret_age = int(a["retirement_age"])
    year = start_year
    emp_pct = a["employee_contrib_pct"]
    by_age = _events_by_age(events)
    while age < ret_age:
        if age < stop_age:
            employee, employer = _contributions(a, salary, age, emp_pct, year, start_year)
            contrib = employee + employer
        else:
            contrib = 0.0
        growth = balance * r + contrib * (math.sqrt(1 + r) - 1)
        balance = max(balance + contrib + growth + _event_amount(by_age, age, a, year, start_year), 0.0)
        salary *= 1 + a["salary_growth"]
        emp_pct = _escalate(a, emp_pct)
        age += 1
        year += 1
    return balance


def coast_fire(
    assumptions: dict | None,
    start_balance: float,
    start_year: int | None = None,
    real_dollars: bool = False,
    events: list[dict] | None = None,
    brackets: list[dict] | None = None,
    assets: list[dict] | None = None,
    loans: list[dict] | None = None,
) -> dict:
    """Coast FIRE: when (if ever) you can stop contributing and still hit the goal.

    The goal is either auto-derived (the retirement nest egg that funds your
    drawdown plan to life expectancy) or a custom target you set in today's
    dollars via `retirement_goal_today`. `coast_number_today` is the balance
    you'd need *right now* for growth alone to reach that goal by retirement.
    `coast_age` is the earliest age you can stop contributing and still get
    there. With `real_dollars`, the retirement-year amounts (goal, projected
    balance, curve) are shown in today's purchasing power; the coast decision
    (coast_age) is unchanged since it compares like-for-like.
    """
    a = merged(assumptions)
    start_year = start_year or date.today().year
    cur_age, ret_age = int(a["current_age"]), int(a["retirement_age"])
    r = a["nominal_return"]
    n = ret_age - cur_age
    ret_year = start_year + n
    infl_factor = (1 + a["inflation"]) ** n  # future retirement $ -> today's $
    assets_at_ret = _assets_at_retirement(a, assets, start_year, ret_year)

    # Goal is the TOTAL retirement pot (401k + other assets). Other assets grow
    # regardless of contributions, so the coast decision hinges on the 401k part.
    custom = a.get("retirement_goal_today", 0) or 0
    if custom > 0:
        required = custom * infl_factor  # total, entered in today's $
        goal_source = "custom"
    else:
        required = _required_nest_egg(a, start_year, events, brackets, assets, loans) + assets_at_ret
        goal_source = "auto"

    required_401k = max(required - assets_at_ret, 0.0)  # 401k portion of the goal
    coast_number_today = required_401k / ((1 + r) ** n) if n > 0 else required_401k
    projected_401k = _balance_at_retirement_if_stop(a, start_balance, ret_age, start_year, events)
    projected_nest_egg = projected_401k + assets_at_ret

    curve = []
    coast_age = None
    for stop_age in range(cur_age, ret_age + 1):
        bal = _balance_at_retirement_if_stop(a, start_balance, stop_age, start_year, events) + assets_at_ret
        curve.append({"stop_age": stop_age, "retirement_balance": round(bal, 2)})
        if coast_age is None and bal >= required:
            coast_age = stop_age

    fully_funded = projected_nest_egg >= required

    # Item 3: carry both paths through retirement so you can see the drawdowns.
    def _lifetime(stop_age: int) -> list[dict]:
        port = _balance_at_retirement_if_stop(a, start_balance, stop_age, start_year, events)
        dd = run_drawdown(a, port, ret_year, base_year=start_year,
                          events=events, brackets=brackets, assets=assets, loans=loans)
        out = []
        for row in dd:
            bal = row["end_balance"]
            if real_dollars:
                bal = bal / ((1 + a["inflation"]) ** (row["year"] - start_year))
            out.append({"age": row["age"], "balance": round(bal, 2)})
        return out

    coast_drawdown = _lifetime(coast_age) if coast_age is not None else None
    keep_drawdown = _lifetime(ret_age)

    # Optionally restate retirement-year figures in today's dollars. The coast
    # decision and "today" values (coast number, current balance) are untouched.
    if real_dollars:
        required_out = required / infl_factor
        projected_out = projected_nest_egg / infl_factor
        curve = [
            {"stop_age": p["stop_age"], "retirement_balance": round(p["retirement_balance"] / infl_factor, 2)}
            for p in curve
        ]
    else:
        required_out = required
        projected_out = projected_nest_egg

    return {
        "start_year": start_year,
        "current_age": cur_age,
        "retirement_age": ret_age,
        "real_dollars": real_dollars,
        "goal_source": goal_source,
        "retirement_goal_today": round(required / infl_factor, 2),  # goal in today's $ (for the editor)
        "current_balance": round(start_balance, 2),
        "required_nest_egg": round(required_out, 2),
        "projected_nest_egg": round(projected_out, 2),
        "coast_number_today": round(coast_number_today, 2),
        "is_coasting_now": coast_age == cur_age,
        "coast_age": coast_age,
        "coast_year": (start_year + (coast_age - cur_age)) if coast_age is not None else None,
        "years_until_coast": (coast_age - cur_age) if coast_age is not None else None,
        "fully_funded": fully_funded,
        "annual_employee_contribution": round(a["current_salary"] * a["employee_contrib_pct"], 2),
        "curve": curve,
        "coast_drawdown": coast_drawdown,
        "keep_drawdown": keep_drawdown,
        "life_expectancy": int(a["life_expectancy"]),
    }


def monte_carlo(
    assumptions: dict | None,
    start_balance: float,
    start_year: int | None = None,
    n_sims: int = 1000,
    seed: int | None = 42,
    events: list[dict] | None = None,
    brackets: list[dict] | None = None,
    assets: list[dict] | None = None,
    loans: list[dict] | None = None,
) -> dict:
    """Simulate random-return paths; report probability the money lasts.

    The 401(k)'s market return is drawn randomly each year (accumulation and
    drawdown); market-type asset buckets share that draw, while fixed buckets
    (cash) grow at their set rate. The full bucket drawdown — taxes, RMDs,
    loans, spending — runs inside each simulation.
    """
    a = merged(assumptions)
    start_year = start_year or date.today().year
    rng = random.Random(seed)
    mu, sigma = a["nominal_return"], a["return_volatility"]
    cur_age, ret_age, life = int(a["current_age"]), int(a["retirement_age"]), int(a["life_expectancy"])
    ret_year = start_year + (ret_age - cur_age)

    successes = 0
    ending_balances: list[float] = []
    retirement_balances: list[float] = []

    for _ in range(n_sims):
        balance = start_balance
        salary = a["current_salary"]
        emp_pct = a["employee_contrib_pct"]
        year = start_year
        for age in range(cur_age, ret_age):  # 401k accumulation, random returns
            r = rng.gauss(mu, sigma)
            employee, employer = _contributions(a, salary, age, emp_pct, year, start_year)
            contrib = employee + employer
            balance = max(balance * (1 + r) + contrib * math.sqrt(max(1 + r, 0.0)), 0.0)
            salary *= 1 + a["salary_growth"]
            emp_pct = _escalate(a, emp_pct)
            year += 1
        market_returns = [rng.gauss(mu, sigma) for _ in range(ret_age, life + 1)]
        dd = run_drawdown(a, balance, ret_year, base_year=start_year, events=events,
                          brackets=brackets, assets=assets, loans=loans,
                          market_returns=market_returns)
        retirement_balances.append(dd[0]["start_balance"] if dd else balance)
        depleted = any(row["end_balance"] <= 0 for row in dd)
        if not depleted:
            successes += 1
        ending_balances.append(dd[-1]["end_balance"] if dd else balance)

    ending_balances.sort()
    retirement_balances.sort()

    def pct(sorted_vals: list[float], p: float) -> float:
        if not sorted_vals:
            return 0.0
        idx = min(int(p * len(sorted_vals)), len(sorted_vals) - 1)
        return round(sorted_vals[idx], 2)

    return {
        "n_sims": n_sims,
        "success_rate": round(successes / n_sims, 4),
        "retirement_balance_percentiles": {
            "p10": pct(retirement_balances, 0.10),
            "p50": pct(retirement_balances, 0.50),
            "p90": pct(retirement_balances, 0.90),
        },
        "ending_balance_percentiles": {
            "p10": pct(ending_balances, 0.10),
            "p50": pct(ending_balances, 0.50),
            "p90": pct(ending_balances, 0.90),
        },
    }
