/**
 * Local persistence for the browser-only app. All of the user's data (imported
 * transactions, assumptions, and the small side tables) lives in a single
 * IndexedDB document on their device — nothing is ever sent to a server. The
 * dataset is tiny, so we load it whole into memory, mutate it, and persist the
 * whole thing on each change. Export/import round-trips that same document as a
 * JSON file for backup and moving between devices/browsers.
 */
import type { TxnRecord } from "./analytics";
import type { Assumptions } from "./engine";

export interface BatchRecord {
  id: number;
  filename: string;
  imported_at: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
}
export interface SSBenefitRow { claim_age: number; monthly_benefit: number }
export interface LifeEventRow { id?: number; age: number; amount: number; label: string }
export interface TaxBracketRow { threshold: number; rate: number }
export interface OtherAssetRow {
  id?: number; name: string; value: number; growth_rate: number; contribution_annual: number;
  tax_type: "deferred" | "roth" | "taxable" | "cash"; cost_basis: number; is_market: number;
}
export interface LoanRow {
  id?: number; name: string; balance: number; annual_rate: number; months_remaining: number;
  extra_payment_monthly: number; lump_sum_payoff_age: number; start_age: number;
}
/** A named "what-if" variant of the plan: only the assumptions that differ from
 * the live base plan are stored, so unchanged fields track the base. */
export interface SavedScenario { id: number; name: string; overrides: Record<string, number> }

export interface AppData {
  version: number;
  onboarded: boolean;             // has the first-run wizard been completed/skipped
  transactions: TxnRecord[];
  batches: BatchRecord[];
  assumptions: Assumptions;       // only stored (non-default) values
  ssBenefits: SSBenefitRow[];
  lifeEvents: LifeEventRow[];
  taxBrackets: TaxBracketRow[];
  otherAssets: OtherAssetRow[];
  loans: LoanRow[];
  scenarios: SavedScenario[];     // saved "what-if" plan variants (Compare tab)
  seq: number;                    // monotonic id source
}

export const DATA_VERSION = 1;

export function emptyData(): AppData {
  return {
    version: DATA_VERSION,
    onboarded: false,
    transactions: [], batches: [], assumptions: {},
    ssBenefits: [], lifeEvents: [], taxBrackets: [], otherAssets: [], loans: [], scenarios: [],
    seq: 1,
  };
}

const DB_NAME = "retirementbuddy";
const STORE = "app";
const KEY = "state";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadData(): Promise<AppData> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return emptyData(); // storage unavailable (e.g. hardened private mode)
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const raw = req.result as AppData | undefined;
      resolve(raw ? { ...emptyData(), ...raw } : emptyData());
    };
    req.onerror = () => resolve(emptyData());
  });
}

export async function saveData(data: AppData): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(data, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Serialize the whole dataset to a JSON string for download/backup. */
export function exportData(data: AppData): string {
  return JSON.stringify({ ...data, _app: "RetirementBuddy", _exported_at: new Date().toISOString() }, null, 2);
}

/** Parse and validate an imported backup file into AppData. */
export function importData(json: string): AppData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file isn't valid JSON — pick a RetirementBuddy backup file.");
  }
  const p = parsed as Partial<AppData> & { _app?: string };
  if (!p || typeof p !== "object" || !Array.isArray(p.transactions)) {
    throw new Error("That doesn't look like a RetirementBuddy backup.");
  }
  return { ...emptyData(), ...p, version: DATA_VERSION } as AppData;
}
