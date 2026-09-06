"""Database models for RetirementBuddy."""
from datetime import date, datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class ImportBatch(SQLModel, table=True):
    """One import of a report file. Lets the user review/undo an import."""

    id: Optional[int] = Field(default=None, primary_key=True)
    filename: str
    imported_at: datetime = Field(default_factory=datetime.utcnow)
    row_count: int = 0
    new_count: int = 0
    duplicate_count: int = 0


class Transaction(SQLModel, table=True):
    """A single 401k transaction line, normalized from an imported report."""

    id: Optional[int] = Field(default=None, primary_key=True)
    # Deterministic hash of the natural key -> lets re-imports skip duplicates.
    row_hash: str = Field(index=True, unique=True)
    batch_id: Optional[int] = Field(default=None, foreign_key="importbatch.id", index=True)

    txn_date: date = Field(index=True)
    category: str = ""            # e.g. Employee Pre-Tax Contributions
    portfolio: str = ""          # "Portfolio(if applicable)"; often N/A
    security: str = Field(default="", index=True)  # ticker, e.g. VIIIX
    fund_name: str = ""
    action: str = ""            # Buy / Sell / REINVDIV
    transaction_type: str = ""   # free-text description
    quantity: float = 0.0        # signed shares (negative = sold)
    price: float = 0.0           # per-share price on that date
    amount: float = 0.0          # signed cash amount (negative = out)


class SSBenefit(SQLModel, table=True):
    """SSA benefit estimate for one claim age (from the user's SSA statement)."""

    claim_age: int = Field(primary_key=True)
    monthly_benefit: float


class LifeEvent(SQLModel, table=True):
    """A one-off inflow or outflow at a given age (today's dollars).

    Positive = money in (inheritance, home sale); negative = money out
    (college, new roof, car).
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    age: int = Field(index=True)
    amount: float
    label: str = ""


class TaxBracket(SQLModel, table=True):
    """One progressive tax bracket: `rate` applies to income above `threshold`
    (up to the next bracket's threshold). Thresholds are in today's dollars."""

    threshold: float = Field(primary_key=True)
    rate: float


class OtherAsset(SQLModel, table=True):
    """An investable asset held outside the 401(k) — an IRA, Roth, taxable
    brokerage, HYSA, etc. Each grows at its own rate and, in retirement, is a
    separate withdrawal bucket taxed by its `tax_type`.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = ""
    value: float = 0.0                 # current balance, today's dollars
    growth_rate: float = 0.0           # nominal annual growth (e.g. 0.08)
    contribution_annual: float = 0.0   # added each year until retirement, today's $
    # deferred = taxed as income on withdrawal; roth = tax-free;
    # taxable = only gains taxed at the capital-gains rate; cash = untaxed.
    tax_type: str = "taxable"
    cost_basis: float = 0.0            # taxable only: portion that isn't a gain
    is_market: int = 1                 # 1 = returns vary in Monte Carlo; 0 = fixed


class Loan(SQLModel, table=True):
    """A mortgage or other amortizing loan. While active it adds its payment to
    retirement spending; it drops off at payoff. Extra payments shorten it, and
    an optional lump-sum payoff age clears it from the portfolio in that year.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = ""
    balance: float = 0.0               # current principal
    annual_rate: float = 0.0           # e.g. 0.045
    months_remaining: int = 0
    extra_payment_monthly: float = 0.0
    lump_sum_payoff_age: int = 0       # 0 = none; else pay remaining balance at this age


class Assumption(SQLModel, table=True):
    """Key/value store for the single set of projection assumptions.

    Kept as key/value so the model can grow without migrations.
    """

    key: str = Field(primary_key=True)
    value: float
