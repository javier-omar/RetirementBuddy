import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useTheme } from "./theme";
import ImportPanel from "./components/ImportPanel";
import Dashboard from "./components/Dashboard";
import Projections from "./components/Projections";
import DrawdownScenarios from "./components/DrawdownScenarios";
import CoastFire from "./components/CoastFire";
import SocialSecurity from "./components/SocialSecurity";
import EventsTaxes from "./components/EventsTaxes";
import AssetsDebts from "./components/AssetsDebts";
import Transactions from "./components/Transactions";
import type {
  BalancePoint,
  DataQualityWarning,
  Holding,
  ImportBatch,
  Summary,
  Transaction,
  YearContribution,
} from "./types";

type Tab = "dashboard" | "projections" | "drawdown" | "coast" | "social" | "assets" | "events" | "transactions" | "import";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "projections", label: "Projections" },
  { id: "drawdown", label: "Drawdown" },
  { id: "coast", label: "Coast FIRE" },
  { id: "social", label: "Social Security" },
  { id: "assets", label: "Assets & Debts" },
  { id: "events", label: "Events & Taxes" },
  { id: "transactions", label: "Transactions" },
  { id: "import", label: "Import" },
];

export default function App() {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [balance, setBalance] = useState<BalancePoint[]>([]);
  const [contributions, setContributions] = useState<YearContribution[]>([]);
  const [warnings, setWarnings] = useState<DataQualityWarning[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, h, b, c, w, im, t] = await Promise.all([
        api.summary(),
        api.holdings(),
        api.balanceSeries(),
        api.contributions(),
        api.dataQuality(),
        api.imports(),
        api.transactions(),
      ]);
      setSummary(s);
      setHoldings(h);
      setBalance(b);
      setContributions(c);
      setWarnings(w);
      setImports(im);
      setTxns(t.transactions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const hasData = !!summary && summary.market_value !== 0;
  const empty = !loading && txns.length === 0;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <div className="logo">🐷</div>
          <div>
            <h1>RetirementBuddy</h1>
            <p>Your 401(k) history &amp; retirement projections — all local, all private.</p>
          </div>
          <button
            className="theme-toggle"
            onClick={toggle}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {loading ? (
        <div className="center-load"><div className="spinner" /> Loading your data…</div>
      ) : (
        <>
          {empty && tab !== "import" && tab !== "projections" && (
            <div className="banner ok" style={{ marginBottom: 16 }}>
              <span>👋</span>
              <span>
                Welcome! Head to the <button className="btn ghost sm" onClick={() => setTab("import")}>Import</button> tab
                to load a 401(k) report and see your history come to life.
              </span>
            </div>
          )}

          {tab === "dashboard" && summary && (
            hasData ? (
              <Dashboard
                summary={summary}
                holdings={holdings}
                balance={balance}
                contributions={contributions}
                warnings={warnings}
              />
            ) : (
              <div className="center-load">No data yet — import a report to get started.</div>
            )
          )}

          {tab === "projections" && <Projections hasData={hasData} />}

          {tab === "drawdown" && <DrawdownScenarios hasData={hasData} />}

          {tab === "coast" && <CoastFire hasData={hasData} />}

          {tab === "social" && <SocialSecurity />}

          {tab === "assets" && <AssetsDebts />}

          {tab === "events" && <EventsTaxes />}

          {tab === "transactions" && (
            txns.length ? <Transactions txns={txns} /> : <div className="center-load">No transactions yet.</div>
          )}

          {tab === "import" && <ImportPanel imports={imports} onChanged={load} />}
        </>
      )}
    </div>
  );
}
