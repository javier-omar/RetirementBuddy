import { useRef, useState } from "react";
import { api } from "../api";
import { DEFAULT_ASSUMPTIONS } from "../lib/engine";
import type { Assumptions } from "../types";
import MoneyInput from "./MoneyInput";

/**
 * First-run wizard. Shown once on a fresh install (no data yet). Collects the
 * handful of inputs needed for a meaningful first projection — everything is
 * editable later in the tabs — then hands off to the app. Returning users on a
 * new device can restore a backup straight from step 1.
 */

type Balance = { mode: "import" | "manual"; manual: number; imported: number | null };

const pctVal = (v: number) => String(+(v * 100).toFixed(4));
const toPct = (s: string) => (parseFloat(s) || 0) / 100;

export default function Onboarding({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [v, setV] = useState<Assumptions>({
    current_age: 35,
    retirement_age: 65,
    life_expectancy: 90,
    current_salary: 0,
    employee_contrib_pct: 0.1,
    employer_match_pct: DEFAULT_ASSUMPTIONS.employer_match_pct,
    match_cap_pct: DEFAULT_ASSUMPTIONS.match_cap_pct,
    annual_spending: 0,
    ss_annual_benefit: 0,
    ss_claim_age: 67,
    nominal_return: 0.07,
    inflation: 0.03,
    starting_balance: 0,
  });
  const [balance, setBalance] = useState<Balance>({ mode: "import", manual: 0, imported: null });
  const [skipSS, setSkipSS] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  const set = (patch: Assumptions) => setV((prev) => ({ ...prev, ...patch }));

  async function importCsv(file: File) {
    setBusy(true); setErr(null);
    try {
      const r = await api.importFile(file);
      setBalance((b) => ({ ...b, mode: "import", imported: r.new }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: File) {
    setBusy(true); setErr(null);
    try {
      await api.importBackup(await file.text());
      onFinish();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true); setErr(null);
    try {
      const toSave: Assumptions = {
        current_age: v.current_age, retirement_age: v.retirement_age, life_expectancy: v.life_expectancy,
        current_salary: v.current_salary, employee_contrib_pct: v.employee_contrib_pct,
        employer_match_pct: v.employer_match_pct, match_cap_pct: v.match_cap_pct,
        annual_spending: v.annual_spending, nominal_return: v.nominal_return, inflation: v.inflation,
      };
      if (balance.mode === "manual") toSave.starting_balance = balance.manual;
      if (!skipSS) {
        toSave.ss_annual_benefit = v.ss_annual_benefit;
        toSave.ss_claim_age = v.ss_claim_age;
      } else {
        toSave.ss_annual_benefit = 0; // no SS assumed until they add it on the SS tab
      }
      await api.saveAssumptions(toSave);
      await api.setOnboarded(true);
      onFinish();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const STEPS = ["Welcome", "About you", "Your 401(k)", "Saving", "Retirement", "Growth"];
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const numInput = (key: keyof Assumptions & string, opts?: { min?: number; max?: number; step?: number }) => (
    <input
      type="number"
      min={opts?.min}
      max={opts?.max}
      step={opts?.step ?? 1}
      value={v[key] ?? 0}
      onChange={(e) => set({ [key]: parseFloat(e.target.value) || 0 })}
    />
  );
  const pctInput = (key: keyof Assumptions & string, step = 0.5) => (
    <input
      type="number"
      step={step}
      value={pctVal(v[key] ?? 0)}
      onChange={(e) => set({ [key]: toPct(e.target.value) })}
    />
  );

  return (
    <div className="onb-overlay">
      <div className="onb-card card">
        <div className="onb-head">
          <div className="brand" style={{ gap: 10 }}>
            <div className="logo" style={{ width: 34, height: 34, fontSize: 17 }}>🐷</div>
            <strong>RetirementBuddy</strong>
          </div>
          {step > 0 && <div className="onb-progress">Step {step} of {STEPS.length - 1}</div>}
        </div>

        {step > 0 && (
          <div className="onb-dots">
            {STEPS.slice(1).map((_, i) => <span key={i} className={`onb-dot ${i + 1 <= step ? "on" : ""}`} />)}
          </div>
        )}

        {/* 0 — Welcome */}
        {step === 0 && (
          <div className="onb-body">
            <h2>Welcome 👋</h2>
            <p className="onb-lead">
              Let's set up your retirement plan. It takes about a minute, and you can change
              anything later.
            </p>
            <div className="banner ok" style={{ marginBottom: 4 }}>
              <span>🔒</span>
              <span>
                Everything you enter stays <strong>in this browser, on this device</strong> — it's never
                uploaded anywhere.
              </span>
            </div>
            <div className="onb-actions">
              <button className="btn" onClick={next}>Get started →</button>
              <button className="btn ghost" onClick={() => restoreRef.current?.click()} disabled={busy}>
                Restore a backup
              </button>
              <input ref={restoreRef} type="file" accept=".json,application/json" style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
            </div>
            <button className="onb-skip" onClick={() => { api.setOnboarded(true).then(onFinish); }}>
              Skip setup — I'll explore on my own
            </button>
          </div>
        )}

        {/* 1 — About you */}
        {step === 1 && (
          <div className="onb-body">
            <h2>About you</h2>
            <p className="onb-lead">When are you planning around?</p>
            <div className="field-grid">
              <div className="field"><label>Current age</label>{numInput("current_age", { min: 16, max: 90 })}</div>
              <div className="field"><label>Target retirement age</label>{numInput("retirement_age", { min: 30, max: 90 })}</div>
              <div className="field">
                <label>Plan through age</label>{numInput("life_expectancy", { min: 70, max: 110 })}
                <span className="hint">how long the money must last — 90–95 is a safe bet</span>
              </div>
            </div>
          </div>
        )}

        {/* 2 — Your 401(k) today */}
        {step === 2 && (
          <div className="onb-body">
            <h2>Your 401(k) today</h2>
            <p className="onb-lead">How should we get your current balance?</p>
            <div className="onb-choice">
              <button className={`onb-opt ${balance.mode === "import" ? "sel" : ""}`} onClick={() => setBalance((b) => ({ ...b, mode: "import" }))}>
                <strong>📥 Import my report</strong>
                <span>Upload a CSV export — gives your balance <em>and</em> full history.</span>
              </button>
              <button className={`onb-opt ${balance.mode === "manual" ? "sel" : ""}`} onClick={() => setBalance((b) => ({ ...b, mode: "manual" }))}>
                <strong>✏️ Enter it manually</strong>
                <span>Just type your current balance. You can import history later.</span>
              </button>
            </div>
            {balance.mode === "import" ? (
              <div style={{ marginTop: 14 }}>
                <button className="btn" disabled={busy} onClick={() => csvRef.current?.click()}>
                  {busy ? "Importing…" : "Choose CSV file"}
                </button>
                <input ref={csvRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
                  onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
                {balance.imported !== null && (
                  <div className="banner ok" style={{ marginTop: 12 }}>
                    <span>✅</span><span>{balance.imported} transactions imported.</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="field" style={{ marginTop: 14, maxWidth: 240 }}>
                <label>Current 401(k) balance ($)</label>
                <MoneyInput value={balance.manual} onValue={(n) => setBalance((b) => ({ ...b, manual: n }))} blankOnZero />
              </div>
            )}
          </div>
        )}

        {/* 3 — Saving */}
        {step === 3 && (
          <div className="onb-body">
            <h2>Saving each year</h2>
            <p className="onb-lead">What you and your employer put in.</p>
            <div className="field-grid">
              <div className="field"><label>Current salary ($)</label>
                <MoneyInput value={v.current_salary} onValue={(n) => set({ current_salary: n })} blankOnZero /></div>
              <div className="field"><label>Your contribution (%)</label>{pctInput("employee_contrib_pct")}
                <span className="hint">% of salary you contribute</span></div>
              <div className="field"><label>Employer match (%)</label>{pctInput("employer_match_pct")}
                <span className="hint">of your contribution</span></div>
              <div className="field"><label>Match cap (%)</label>{pctInput("match_cap_pct")}
                <span className="hint">up to this % of salary</span></div>
            </div>
          </div>
        )}

        {/* 4 — Retirement & SS */}
        {step === 4 && (
          <div className="onb-body">
            <h2>Retirement income</h2>
            <p className="onb-lead">What you'll spend, and your Social Security.</p>
            <div className="field" style={{ maxWidth: 260 }}>
              <label>Annual spending in retirement ($)</label>
              <MoneyInput value={v.annual_spending} onValue={(n) => set({ annual_spending: n })} blankOnZero />
              <span className="hint">in today's dollars</span>
            </div>
            <label className="toggle" style={{ margin: "16px 0 4px" }}>
              <input type="checkbox" checked={skipSS} onChange={(e) => setSkipSS(e.target.checked)} />
              I'll add Social Security later
            </label>
            {!skipSS && (
              <div className="field-grid" style={{ maxWidth: 420 }}>
                <div className="field"><label>SS annual benefit ($)</label>
                  <MoneyInput value={v.ss_annual_benefit} onValue={(n) => set({ ss_annual_benefit: n })} blankOnZero />
                  <span className="hint">estimate from ssa.gov</span></div>
                <div className="field"><label>Claim age</label>{numInput("ss_claim_age", { min: 62, max: 70 })}</div>
              </div>
            )}
          </div>
        )}

        {/* 5 — Growth */}
        {step === 5 && (
          <div className="onb-body">
            <h2>Growth assumptions</h2>
            <p className="onb-lead">Sensible defaults are filled in — adjust if you like.</p>
            <div className="field-grid" style={{ maxWidth: 420 }}>
              <div className="field"><label>Expected annual return (%)</label>{pctInput("nominal_return")}
                <span className="hint">before inflation</span></div>
              <div className="field"><label>Inflation (%)</label>{pctInput("inflation")}</div>
            </div>
          </div>
        )}

        {err && <div className="banner error" style={{ marginTop: 12 }}><span>⚠️</span><span>{err}</span></div>}

        {step > 0 && (
          <div className="onb-nav">
            <button className="btn ghost" onClick={back} disabled={busy}>← Back</button>
            {step < STEPS.length - 1 ? (
              <button className="btn" onClick={next} disabled={busy}>Next →</button>
            ) : (
              <button className="btn" onClick={finish} disabled={busy}>{busy ? "Saving…" : "Finish ✓"}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
