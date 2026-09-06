"""HTTP API for RetirementBuddy."""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, delete, func, select

from ..db import get_session
from ..models import (
    Assumption, ImportBatch, LifeEvent, Loan, OtherAsset, SSBenefit, TaxBracket, Transaction,
)
from ..services import analytics, projections
from ..services.parser import ParseError, parse_file

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Import / transactions
# --------------------------------------------------------------------------- #
@router.post("/import")
async def import_report(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    content = await file.read()
    try:
        rows = parse_file(content, file.filename or "upload.csv")
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not rows:
        raise HTTPException(status_code=422, detail="No transactions found in file.")

    batch = ImportBatch(filename=file.filename or "upload.csv", row_count=len(rows))
    session.add(batch)
    session.flush()  # assign batch.id

    existing = set(session.exec(select(Transaction.row_hash)).all())
    new_count = 0
    for r in rows:
        h = r.row_hash()
        if h in existing:
            continue
        existing.add(h)
        session.add(Transaction(row_hash=h, batch_id=batch.id, **r.as_dict()))
        new_count += 1

    batch.new_count = new_count
    batch.duplicate_count = len(rows) - new_count
    session.add(batch)
    session.commit()
    session.refresh(batch)
    return {
        "batch_id": batch.id,
        "filename": batch.filename,
        "rows_parsed": batch.row_count,
        "new": batch.new_count,
        "duplicates": batch.duplicate_count,
    }


@router.get("/imports")
def list_imports(session: Session = Depends(get_session)):
    batches = session.exec(select(ImportBatch).order_by(ImportBatch.imported_at.desc())).all()
    return batches


@router.delete("/imports/{batch_id}")
def delete_import(batch_id: int, session: Session = Depends(get_session)):
    batch = session.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found.")
    session.exec(delete(Transaction).where(Transaction.batch_id == batch_id))
    session.delete(batch)
    session.commit()
    return {"deleted_batch": batch_id}


@router.get("/transactions")
def list_transactions(
    session: Session = Depends(get_session),
    security: Optional[str] = None,
    flow: Optional[str] = None,
    start: Optional[date] = None,
    end: Optional[date] = None,
    limit: int = Query(500, le=5000),
    offset: int = 0,
):
    stmt = select(Transaction)
    if security:
        stmt = stmt.where(Transaction.security == security)
    if start:
        stmt = stmt.where(Transaction.txn_date >= start)
    if end:
        stmt = stmt.where(Transaction.txn_date <= end)
    stmt = stmt.order_by(Transaction.txn_date.desc())
    total = session.exec(select(func.count()).select_from(stmt.subquery())).one()
    txns = session.exec(stmt.offset(offset).limit(limit)).all()
    # `flow` is derived, so filter after fetch if requested.
    result = [t.model_dump() for t in txns]
    return {"total": total, "count": len(result), "transactions": result}


# --------------------------------------------------------------------------- #
# Analytics
# --------------------------------------------------------------------------- #
@router.get("/analytics/summary")
def analytics_summary(session: Session = Depends(get_session)):
    return analytics.summary(analytics.load_df(session))


@router.get("/analytics/holdings")
def analytics_holdings(session: Session = Depends(get_session)):
    return analytics.holdings(analytics.load_df(session))


@router.get("/analytics/balance-series")
def analytics_balance_series(
    freq: str = "ME", session: Session = Depends(get_session)
):
    return analytics.balance_series(analytics.load_df(session), freq=freq)


@router.get("/analytics/contributions")
def analytics_contributions(session: Session = Depends(get_session)):
    return analytics.contributions_by_year(analytics.load_df(session))


@router.get("/analytics/data-quality")
def analytics_data_quality(session: Session = Depends(get_session)):
    return analytics.data_quality(analytics.load_df(session))


# --------------------------------------------------------------------------- #
# Assumptions
# --------------------------------------------------------------------------- #
def _load_assumptions(session: Session) -> dict:
    stored = {a.key: a.value for a in session.exec(select(Assumption)).all()}
    merged = dict(projections.DEFAULT_ASSUMPTIONS)
    merged.update(stored)
    return merged


# --------------------------------------------------------------------------- #
# Social Security benefit table (claim age -> monthly benefit)
# --------------------------------------------------------------------------- #
def _ss_annual_from_table(session: Session, claim_age: float) -> Optional[float]:
    """Annual benefit for a claim age, linearly interpolated between the
    user's SSA statement entries. None when the table is empty."""
    rows = session.exec(select(SSBenefit).order_by(SSBenefit.claim_age)).all()
    if not rows:
        return None
    if claim_age <= rows[0].claim_age:
        monthly = rows[0].monthly_benefit
    elif claim_age >= rows[-1].claim_age:
        monthly = rows[-1].monthly_benefit
    else:
        monthly = rows[-1].monthly_benefit
        for lo, hi in zip(rows, rows[1:]):
            if lo.claim_age <= claim_age <= hi.claim_age:
                t = (claim_age - lo.claim_age) / (hi.claim_age - lo.claim_age)
                monthly = lo.monthly_benefit + t * (hi.monthly_benefit - lo.monthly_benefit)
                break
    return round(monthly * 12, 2)


def _apply_ss_table(session: Session, assumptions: dict) -> dict:
    """If the SS table has entries, it wins over the manual benefit field."""
    annual = _ss_annual_from_table(session, assumptions.get("ss_claim_age", 67))
    if annual is not None:
        assumptions["ss_annual_benefit"] = annual
    return assumptions


@router.get("/ss-benefits")
def get_ss_benefits(session: Session = Depends(get_session)):
    return session.exec(select(SSBenefit).order_by(SSBenefit.claim_age)).all()


class SSBenefitIn(BaseModel):
    claim_age: int
    monthly_benefit: float


class SSBenefitsUpdate(BaseModel):
    benefits: list[SSBenefitIn]


@router.put("/ss-benefits")
def put_ss_benefits(payload: SSBenefitsUpdate, session: Session = Depends(get_session)):
    session.exec(delete(SSBenefit))
    for b in payload.benefits:
        if b.claim_age > 0 and b.monthly_benefit > 0:
            session.merge(SSBenefit(claim_age=b.claim_age, monthly_benefit=b.monthly_benefit))
    session.commit()
    return session.exec(select(SSBenefit).order_by(SSBenefit.claim_age)).all()


# --------------------------------------------------------------------------- #
# Life events & tax brackets
# --------------------------------------------------------------------------- #
def _load_events(session: Session) -> list[dict]:
    rows = session.exec(select(LifeEvent).order_by(LifeEvent.age)).all()
    return [{"age": r.age, "amount": r.amount, "label": r.label} for r in rows]


def _load_brackets(session: Session) -> list[dict]:
    rows = session.exec(select(TaxBracket).order_by(TaxBracket.threshold)).all()
    return [{"threshold": r.threshold, "rate": r.rate} for r in rows]


@router.get("/life-events")
def get_life_events(session: Session = Depends(get_session)):
    return session.exec(select(LifeEvent).order_by(LifeEvent.age)).all()


class LifeEventIn(BaseModel):
    age: int
    amount: float
    label: str = ""


class LifeEventsUpdate(BaseModel):
    events: list[LifeEventIn]


@router.put("/life-events")
def put_life_events(payload: LifeEventsUpdate, session: Session = Depends(get_session)):
    session.exec(delete(LifeEvent))
    for e in payload.events:
        if e.age > 0 and e.amount != 0:
            session.add(LifeEvent(age=e.age, amount=e.amount, label=e.label.strip()))
    session.commit()
    return session.exec(select(LifeEvent).order_by(LifeEvent.age)).all()


# --------------------------------------------------------------------------- #
# Other assets & loans (Assets & Debts tab)
# --------------------------------------------------------------------------- #
def _load_assets(session: Session, assumptions: dict) -> list[dict]:
    rows = session.exec(select(OtherAsset).order_by(OtherAsset.id)).all()
    if rows:
        return [
            {
                "name": r.name, "value": r.value, "growth_rate": r.growth_rate,
                "contribution_annual": r.contribution_annual, "tax_type": r.tax_type,
                "cost_basis": r.cost_basis, "is_market": r.is_market,
            }
            for r in rows
        ]
    # Legacy fallback: the single "other_assets_today" field becomes one taxable
    # asset growing at the main return, so nothing breaks for existing users.
    legacy = assumptions.get("other_assets_today", 0.0)
    if legacy and legacy > 0:
        return [{
            "name": "Other assets", "value": legacy, "growth_rate": assumptions["nominal_return"],
            "contribution_annual": 0.0, "tax_type": "taxable", "cost_basis": legacy, "is_market": 1,
        }]
    return []


def _load_loans(session: Session) -> list[dict]:
    rows = session.exec(select(Loan).order_by(Loan.id)).all()
    return [
        {
            "name": r.name, "balance": r.balance, "annual_rate": r.annual_rate,
            "months_remaining": r.months_remaining, "extra_payment_monthly": r.extra_payment_monthly,
            "lump_sum_payoff_age": r.lump_sum_payoff_age,
        }
        for r in rows
    ]


@router.get("/other-assets")
def get_other_assets(session: Session = Depends(get_session)):
    return session.exec(select(OtherAsset).order_by(OtherAsset.id)).all()


class OtherAssetIn(BaseModel):
    name: str = ""
    value: float = 0.0
    growth_rate: float = 0.0
    contribution_annual: float = 0.0
    tax_type: str = "taxable"
    cost_basis: float = 0.0
    is_market: int = 1


class OtherAssetsUpdate(BaseModel):
    assets: list[OtherAssetIn]


@router.put("/other-assets")
def put_other_assets(payload: OtherAssetsUpdate, session: Session = Depends(get_session)):
    session.exec(delete(OtherAsset))
    valid = {"deferred", "roth", "taxable", "cash"}
    for x in payload.assets:
        if x.value <= 0:
            continue
        session.add(OtherAsset(
            name=x.name.strip(), value=x.value, growth_rate=x.growth_rate,
            contribution_annual=x.contribution_annual,
            tax_type=x.tax_type if x.tax_type in valid else "taxable",
            cost_basis=x.cost_basis or x.value, is_market=1 if x.is_market else 0,
        ))
    session.commit()
    return session.exec(select(OtherAsset).order_by(OtherAsset.id)).all()


@router.get("/loans")
def get_loans(session: Session = Depends(get_session)):
    return session.exec(select(Loan).order_by(Loan.id)).all()


class LoanIn(BaseModel):
    name: str = ""
    balance: float = 0.0
    annual_rate: float = 0.0
    months_remaining: int = 0
    extra_payment_monthly: float = 0.0
    lump_sum_payoff_age: int = 0


class LoansUpdate(BaseModel):
    loans: list[LoanIn]


@router.put("/loans")
def put_loans(payload: LoansUpdate, session: Session = Depends(get_session)):
    session.exec(delete(Loan))
    for x in payload.loans:
        if x.balance <= 0:
            continue
        session.add(Loan(
            name=x.name.strip(), balance=x.balance, annual_rate=x.annual_rate,
            months_remaining=x.months_remaining, extra_payment_monthly=x.extra_payment_monthly,
            lump_sum_payoff_age=x.lump_sum_payoff_age,
        ))
    session.commit()
    return session.exec(select(Loan).order_by(Loan.id)).all()


@router.get("/tax-brackets")
def get_tax_brackets(session: Session = Depends(get_session)):
    return session.exec(select(TaxBracket).order_by(TaxBracket.threshold)).all()


class TaxBracketIn(BaseModel):
    threshold: float
    rate: float


class TaxBracketsUpdate(BaseModel):
    brackets: list[TaxBracketIn]


@router.put("/tax-brackets")
def put_tax_brackets(payload: TaxBracketsUpdate, session: Session = Depends(get_session)):
    session.exec(delete(TaxBracket))
    seen: set[float] = set()
    for b in payload.brackets:
        if b.threshold >= 0 and b.rate >= 0 and b.threshold not in seen:
            seen.add(b.threshold)
            session.merge(TaxBracket(threshold=b.threshold, rate=b.rate))
    session.commit()
    return session.exec(select(TaxBracket).order_by(TaxBracket.threshold)).all()


@router.get("/assumptions")
def get_assumptions(session: Session = Depends(get_session)):
    assumptions = _load_assumptions(session)
    return {
        "assumptions": assumptions,
        "defaults": projections.DEFAULT_ASSUMPTIONS,
        # Effective annual benefit implied by the SS table (null = table empty,
        # manual ss_annual_benefit applies).
        "ss_benefit_from_table": _ss_annual_from_table(
            session, assumptions.get("ss_claim_age", 67)
        ),
    }


class AssumptionsUpdate(BaseModel):
    assumptions: dict[str, float]


@router.put("/assumptions")
def put_assumptions(payload: AssumptionsUpdate, session: Session = Depends(get_session)):
    for key, value in payload.assumptions.items():
        if key not in projections.DEFAULT_ASSUMPTIONS:
            continue  # ignore unknown keys
        existing = session.get(Assumption, key)
        if existing:
            existing.value = float(value)
            session.add(existing)
        else:
            session.add(Assumption(key=key, value=float(value)))
    session.commit()
    return {"assumptions": _load_assumptions(session)}


# --------------------------------------------------------------------------- #
# Projections
# --------------------------------------------------------------------------- #
class ProjectionRequest(BaseModel):
    overrides: dict[str, float] = {}
    start_balance: Optional[float] = None  # defaults to actual current market value
    real_dollars: bool = False


def _current_balance(session: Session, override: Optional[float]) -> float:
    if override is not None:
        return override
    s = analytics.summary(analytics.load_df(session))
    return s["market_value"] or 0.0


@router.post("/projection")
def run_projection(req: ProjectionRequest, session: Session = Depends(get_session)):
    assumptions = _load_assumptions(session)
    assumptions.update(req.overrides or {})
    _apply_ss_table(session, assumptions)
    start_balance = _current_balance(session, req.start_balance)
    return projections.run_projection(
        assumptions, start_balance, real_dollars=req.real_dollars,
        events=_load_events(session), brackets=_load_brackets(session),
        assets=_load_assets(session, assumptions), loans=_load_loans(session),
    )


class ScenarioDef(BaseModel):
    name: str
    overrides: dict[str, float] = {}


class DrawdownScenariosRequest(BaseModel):
    overrides: dict[str, float] = {}
    scenarios: list[ScenarioDef]
    start_balance: Optional[float] = None
    real_dollars: bool = False
    fixed_start: bool = True


@router.post("/drawdown-scenarios")
def run_drawdown_scenarios(req: DrawdownScenariosRequest, session: Session = Depends(get_session)):
    assumptions = _load_assumptions(session)
    assumptions.update(req.overrides or {})
    _apply_ss_table(session, assumptions)
    start_balance = _current_balance(session, req.start_balance)
    scenarios = [{"name": s.name, "overrides": s.overrides} for s in req.scenarios]
    return projections.run_drawdown_scenarios(
        assumptions,
        start_balance,
        scenarios,
        real_dollars=req.real_dollars,
        fixed_start=req.fixed_start,
        events=_load_events(session),
        brackets=_load_brackets(session),
        assets=_load_assets(session, assumptions),
        loans=_load_loans(session),
    )


class MonteCarloRequest(BaseModel):
    overrides: dict[str, float] = {}
    start_balance: Optional[float] = None
    n_sims: int = 1000


@router.post("/monte-carlo")
def run_monte_carlo(req: MonteCarloRequest, session: Session = Depends(get_session)):
    assumptions = _load_assumptions(session)
    assumptions.update(req.overrides or {})
    _apply_ss_table(session, assumptions)
    start_balance = _current_balance(session, req.start_balance)
    n = max(100, min(req.n_sims, 20000))
    return projections.monte_carlo(
        assumptions, start_balance, n_sims=n,
        events=_load_events(session), brackets=_load_brackets(session),
        assets=_load_assets(session, assumptions), loans=_load_loans(session),
    )


class CoastFireRequest(BaseModel):
    overrides: dict[str, float] = {}
    start_balance: Optional[float] = None
    real_dollars: bool = False


@router.post("/coast-fire")
def run_coast_fire(req: CoastFireRequest, session: Session = Depends(get_session)):
    assumptions = _load_assumptions(session)
    assumptions.update(req.overrides or {})
    _apply_ss_table(session, assumptions)
    start_balance = _current_balance(session, req.start_balance)
    return projections.coast_fire(
        assumptions, start_balance, real_dollars=req.real_dollars,
        events=_load_events(session), brackets=_load_brackets(session),
        assets=_load_assets(session, assumptions), loans=_load_loans(session),
    )
