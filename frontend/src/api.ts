/**
 * Local, in-browser API. This exposes exactly the same surface the components
 * already used when there was a Python/FastAPI backend, but every call now runs
 * against the on-device data (IndexedDB) and the TypeScript projection engine.
 * Nothing leaves the browser.
 */
import type {
  Assumptions,
  AssumptionsResponse,
  BalancePoint,
  CoastFireResult,
  DataQualityWarning,
  DrawdownScenariosResult,
  Holding,
  ImportBatch,
  MonteCarloResult,
  ProjectionResult,
  LifeEventRow,
  LoanRow,
  OtherAssetRow,
  ScenarioInput,
  SSBenefitRow,
  TaxBracketRow,
  Summary,
  Transaction,
  YearContribution,
} from "./types";
import * as engine from "./lib/engine";
import * as analytics from "./lib/analytics";
import { parseFile, ParseError } from "./lib/parser";
import {
  type AppData, type TaxBracketRow as DbBracket, DATA_VERSION,
  emptyData, loadData, saveData, exportData, importData,
} from "./lib/db";
import type { TxnRecord } from "./lib/analytics";

const { DEFAULT_ASSUMPTIONS } = engine;

// ---- in-memory state ------------------------------------------------------ //

let data: AppData = emptyData();
let ready: Promise<void> | null = null;

function ensure(): Promise<void> {
  if (!ready) ready = loadData().then((d) => { data = d; });
  return ready;
}
async function persist(): Promise<void> {
  await saveData(data);
}
const nextId = (): number => data.seq++;

// ---- assumptions / lookups (mirror the old FastAPI helpers) --------------- //

function mergedAssumptions(): Assumptions {
  return { ...DEFAULT_ASSUMPTIONS, ...data.assumptions };
}

/** Annual SS benefit for a claim age, linearly interpolated from the table. */
function ssAnnualFromTable(claimAge: number): number | null {
  const rows = [...data.ssBenefits].sort((a, b) => a.claim_age - b.claim_age);
  if (!rows.length) return null;
  let monthly: number;
  if (claimAge <= rows[0].claim_age) monthly = rows[0].monthly_benefit;
  else if (claimAge >= rows[rows.length - 1].claim_age) monthly = rows[rows.length - 1].monthly_benefit;
  else {
    monthly = rows[rows.length - 1].monthly_benefit;
    for (let i = 0; i < rows.length - 1; i++) {
      const lo = rows[i], hi = rows[i + 1];
      if (lo.claim_age <= claimAge && claimAge <= hi.claim_age) {
        const t = (claimAge - lo.claim_age) / (hi.claim_age - lo.claim_age);
        monthly = lo.monthly_benefit + t * (hi.monthly_benefit - lo.monthly_benefit);
        break;
      }
    }
  }
  return Math.round(monthly * 12 * 100) / 100;
}

function applySsTable(a: Assumptions): Assumptions {
  const annual = ssAnnualFromTable(a.ss_claim_age ?? 67);
  if (annual !== null) a.ss_annual_benefit = annual;
  return a;
}

function loadAssets(a: Assumptions): engine.AssetRow[] {
  if (data.otherAssets.length) {
    return data.otherAssets.map((r) => ({
      name: r.name, value: r.value, growth_rate: r.growth_rate,
      contribution_annual: r.contribution_annual, tax_type: r.tax_type,
      cost_basis: r.cost_basis, is_market: r.is_market,
    }));
  }
  // Legacy fallback: the single "other_assets_today" field becomes one taxable
  // asset growing at the main return, so nothing breaks for existing data.
  const legacy = a.other_assets_today ?? 0;
  if (legacy > 0) {
    return [{
      name: "Other assets", value: legacy, growth_rate: a.nominal_return,
      contribution_annual: 0, tax_type: "taxable", cost_basis: legacy, is_market: 1,
    }];
  }
  return [];
}
const loadLoans = (): engine.LoanInput[] => data.loans.map((r) => ({ ...r }));
const loadEvents = (): engine.EventRow[] =>
  [...data.lifeEvents].sort((a, b) => a.age - b.age).map((r) => ({ age: r.age, amount: r.amount, label: r.label }));
const loadBrackets = (): engine.BracketRow[] =>
  [...data.taxBrackets].sort((a, b) => a.threshold - b.threshold).map((r) => ({ threshold: r.threshold, rate: r.rate }));

function currentBalance(): number {
  // Prefer the balance reconstructed from imported transactions; fall back to a
  // manually-entered starting balance (from onboarding) when nothing's imported.
  const fromLedger = analytics.summary(data.transactions).market_value || 0;
  if (fromLedger > 0) return fromLedger;
  return mergedAssumptions().starting_balance || 0;
}

function computeAssumptions(overrides?: Assumptions): Assumptions {
  const a = { ...mergedAssumptions(), ...(overrides || {}) };
  applySsTable(a);
  return a;
}

// ---- public API ----------------------------------------------------------- //

export const api = {
  importFile: async (file: File) => {
    await ensure();
    let rows;
    try {
      rows = parseFile(await file.text());
    } catch (e) {
      throw new Error(e instanceof ParseError ? e.message : String((e as Error).message || e));
    }
    if (!rows.length) throw new Error("No transactions found in file.");

    const batchId = nextId();
    const existing = new Set(data.transactions.map((t) => t.row_hash));
    let newCount = 0;
    for (const r of rows) {
      if (existing.has(r.row_hash)) continue;
      existing.add(r.row_hash);
      data.transactions.push({ id: nextId(), batch_id: batchId, ...r } as TxnRecord);
      newCount += 1;
    }
    const batch = {
      id: batchId, filename: file.name || "upload.csv", imported_at: new Date().toISOString(),
      row_count: rows.length, new_count: newCount, duplicate_count: rows.length - newCount,
    };
    data.batches.push(batch);
    await persist();
    return {
      batch_id: batch.id, filename: batch.filename, rows_parsed: batch.row_count,
      new: batch.new_count, duplicates: batch.duplicate_count,
    };
  },

  imports: async (): Promise<ImportBatch[]> => {
    await ensure();
    return [...data.batches].sort((a, b) => (a.imported_at < b.imported_at ? 1 : -1));
  },

  deleteImport: async (id: number) => {
    await ensure();
    data.transactions = data.transactions.filter((t) => t.batch_id !== id);
    data.batches = data.batches.filter((b) => b.id !== id);
    await persist();
    return { deleted_batch: id };
  },

  summary: async (): Promise<Summary> => { await ensure(); return analytics.summary(data.transactions); },
  holdings: async (): Promise<Holding[]> => { await ensure(); return analytics.holdings(data.transactions); },
  balanceSeries: async (): Promise<BalancePoint[]> => { await ensure(); return analytics.balanceSeries(data.transactions); },
  contributions: async (): Promise<YearContribution[]> => { await ensure(); return analytics.contributionsByYear(data.transactions); },
  dataQuality: async (): Promise<DataQualityWarning[]> => { await ensure(); return analytics.dataQuality(data.transactions); },

  transactions: async () => {
    await ensure();
    const sorted = [...data.transactions].sort((a, b) => (a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : 0));
    const list = sorted.slice(0, 5000) as unknown as Transaction[];
    return { total: data.transactions.length, count: list.length, transactions: list };
  },

  assumptions: async (): Promise<AssumptionsResponse> => {
    await ensure();
    const merged = mergedAssumptions();
    return {
      assumptions: merged,
      defaults: DEFAULT_ASSUMPTIONS,
      ss_benefit_from_table: ssAnnualFromTable(merged.ss_claim_age ?? 67),
    };
  },

  saveAssumptions: async (assumptions: Assumptions) => {
    await ensure();
    for (const [k, v] of Object.entries(assumptions)) {
      if (k in DEFAULT_ASSUMPTIONS && v !== null && v !== undefined) data.assumptions[k] = Number(v);
    }
    await persist();
    return { assumptions: mergedAssumptions() };
  },

  ssBenefits: async (): Promise<SSBenefitRow[]> => {
    await ensure();
    return [...data.ssBenefits].sort((a, b) => a.claim_age - b.claim_age);
  },
  saveSSBenefits: async (benefits: SSBenefitRow[]) => {
    await ensure();
    data.ssBenefits = benefits
      .filter((b) => b.claim_age > 0 && b.monthly_benefit > 0)
      .map((b) => ({ claim_age: Math.trunc(b.claim_age), monthly_benefit: b.monthly_benefit }))
      .sort((a, b) => a.claim_age - b.claim_age);
    await persist();
    return [...data.ssBenefits];
  },

  lifeEvents: async (): Promise<LifeEventRow[]> => {
    await ensure();
    return [...data.lifeEvents].sort((a, b) => a.age - b.age);
  },
  saveLifeEvents: async (events: LifeEventRow[]) => {
    await ensure();
    data.lifeEvents = events
      .filter((e) => e.age > 0 && e.amount !== 0)
      .map((e) => ({ id: nextId(), age: Math.trunc(e.age), amount: e.amount, label: (e.label || "").trim() }))
      .sort((a, b) => a.age - b.age);
    await persist();
    return [...data.lifeEvents];
  },

  taxBrackets: async (): Promise<TaxBracketRow[]> => {
    await ensure();
    return [...data.taxBrackets].sort((a, b) => a.threshold - b.threshold);
  },
  saveTaxBrackets: async (brackets: TaxBracketRow[]) => {
    await ensure();
    const seen = new Set<number>();
    const out: DbBracket[] = [];
    for (const b of brackets) {
      if (b.threshold >= 0 && b.rate >= 0 && !seen.has(b.threshold)) {
        seen.add(b.threshold);
        out.push({ threshold: b.threshold, rate: b.rate });
      }
    }
    data.taxBrackets = out.sort((a, b) => a.threshold - b.threshold);
    await persist();
    return [...data.taxBrackets];
  },

  otherAssets: async (): Promise<OtherAssetRow[]> => { await ensure(); return [...data.otherAssets]; },
  saveOtherAssets: async (assets: OtherAssetRow[]) => {
    await ensure();
    const valid = new Set(["deferred", "roth", "taxable", "cash"]);
    data.otherAssets = assets
      .filter((x) => x.value > 0)
      .map((x) => ({
        id: nextId(), name: (x.name || "").trim(), value: x.value, growth_rate: x.growth_rate,
        contribution_annual: x.contribution_annual,
        tax_type: (valid.has(x.tax_type) ? x.tax_type : "taxable") as OtherAssetRow["tax_type"],
        cost_basis: x.cost_basis || x.value, is_market: x.is_market ? 1 : 0,
      }));
    await persist();
    return [...data.otherAssets];
  },

  loans: async (): Promise<LoanRow[]> => { await ensure(); return [...data.loans]; },
  saveLoans: async (loans: LoanRow[]) => {
    await ensure();
    data.loans = loans
      .filter((x) => x.balance > 0)
      .map((x) => ({
        id: nextId(), name: (x.name || "").trim(), balance: x.balance, annual_rate: x.annual_rate,
        months_remaining: Math.trunc(x.months_remaining), extra_payment_monthly: x.extra_payment_monthly,
        lump_sum_payoff_age: Math.trunc(x.lump_sum_payoff_age),
      }));
    await persist();
    return [...data.loans];
  },

  projection: async (overrides: Assumptions, realDollars: boolean): Promise<ProjectionResult> => {
    await ensure();
    const a = computeAssumptions(overrides);
    return engine.runProjection(
      a, currentBalance(), undefined, realDollars,
      loadEvents(), loadBrackets(), loadAssets(a), loadLoans(),
    ) as unknown as ProjectionResult;
  },

  monteCarlo: async (overrides: Assumptions, nSims = 2000): Promise<MonteCarloResult> => {
    await ensure();
    const a = computeAssumptions(overrides);
    const n = Math.max(100, Math.min(nSims, 20000));
    return engine.monteCarlo(
      a, currentBalance(), undefined, n, 42,
      loadEvents(), loadBrackets(), loadAssets(a), loadLoans(),
    ) as unknown as MonteCarloResult;
  },

  coastFire: async (overrides: Assumptions = {}, realDollars = false): Promise<CoastFireResult> => {
    await ensure();
    const a = computeAssumptions(overrides);
    return engine.coastFire(
      a, currentBalance(), undefined, realDollars,
      loadEvents(), loadBrackets(), loadAssets(a), loadLoans(),
    ) as unknown as CoastFireResult;
  },

  drawdownScenarios: async (
    scenarios: ScenarioInput[], overrides: Assumptions, realDollars: boolean, fixedStart: boolean,
  ): Promise<DrawdownScenariosResult> => {
    await ensure();
    const a = computeAssumptions(overrides);
    return engine.runDrawdownScenarios(
      a, currentBalance(), scenarios as engine.ScenarioDef[], undefined, realDollars, fixedStart,
      loadEvents(), loadBrackets(), loadAssets(a), loadLoans(),
    ) as unknown as DrawdownScenariosResult;
  },

  // ---- onboarding ---------------------------------------------------------- //
  isOnboarded: async (): Promise<boolean> => { await ensure(); return !!data.onboarded; },
  setOnboarded: async (v = true): Promise<void> => { await ensure(); data.onboarded = v; await persist(); },

  // ---- backup / restore (local file, for non-technical users) ------------- //
  exportBackup: async (): Promise<string> => { await ensure(); return exportData(data); },
  importBackup: async (json: string): Promise<void> => {
    await ensure();
    data = importData(json);
    data.version = DATA_VERSION;
    data.onboarded = true; // restoring means an existing setup — skip the wizard
    await persist();
  },
  hasData: async (): Promise<boolean> => { await ensure(); return data.transactions.length > 0; },
};
