# 🐷 RetirementBuddy

A **private, browser-only** app to import your 401(k) transaction reports, explore
your historical balances, and run long-term retirement projections. There is **no
server** — every calculation runs in your browser and all your data is stored on
your own device. Nothing is ever uploaded.

Started as a spreadsheet retirement model, rebuilt as a web app, and now runs
entirely client-side so it can be hosted as a plain static site or even opened
from a local file — while keeping your financial data on your machine.

## Features

- **Import** — drop in a CSV export. Columns are auto-mapped and negatives written
  in accounting parentheses (`$(2.10)`) are handled. Re-importing the same file is
  safe: duplicate transactions are detected and skipped, and each import can be
  undone. (Have an Excel file? Export it to CSV first.)
- **Dashboard** — current balance, total gain, contributions (you vs. employer),
  dividends, a balance-over-time chart, current holdings, and contributions by year.
  Flags **incomplete history** when a fund shows more shares sold than were bought.
- **Projections** — every assumption is editable. Portfolio at retirement, initial
  withdrawal rate, whether the money lasts, an accumulation→drawdown balance curve,
  and a Monte Carlo probability of success across randomized market paths. An
  **inflation-index toggle** grows withdrawals, Social Security, and spending with
  inflation so a today's-dollars view is a true "is this enough?" test.
- **Drawdown scenarios** — compare several drawdown paths on one chart (optimistic /
  expected / conservative / stress), each from the same nest egg to isolate
  sequence-of-returns risk, with an outcome table and an income-sources chart.
- **Coast FIRE** — the point where you can stop contributing and let growth carry you
  to your goal, with a stop-age curve and a stop-vs-keep-contributing comparison.
- **Assets & Debts** — investable money outside the 401(k) (IRA, Roth, taxable,
  cash) as separate, per-type-taxed withdrawal buckets, plus amortizing loans with
  early-payoff scenarios.
- **Social Security** — enter your SSA benefit estimates per claim age; projections
  interpolate the benefit for your chosen claim age automatically.
- **Events & Taxes** — one-off life events (inheritance, college, new roof) and
  optional progressive tax brackets that replace the flat rate.
- **Transactions** — a searchable, filterable ledger of every imported line.
- **Light & dark mode**, and a responsive layout that works on phones and tablets.

## Your data & privacy

Everything you import and configure is stored **only in your browser, on your
device** (via IndexedDB) — it is never sent anywhere. That has one trade-off worth
knowing: browser storage is per-browser and per-device, and can be cleared by
"clear browsing data" or private mode.

So the **Import** tab has a **Backup & restore** section:

- **Download my data** saves a small `.json` file with your transactions and all
  your settings.
- **Restore from a backup** loads it back.

Use it to back up, to recover after clearing your browser, or to move to another
device/browser (download here, send the file to yourself, restore there).

## Quick start (run it locally)

**Mac / Linux:**

```bash
./run.sh
```

**Windows:** double-click `run.bat` (or run `.\run.ps1` from PowerShell).

Then open **http://localhost:5173**. The first run installs dependencies (Node
18+ required). Or run it directly:

```bash
cd frontend
npm install
npm run dev
```

## Sharing it with other people (no install for them)

Because the app is fully static, you can build it once and host it anywhere — the
people you share with just open a link; there's nothing to install, and their data
stays in their own browser.

```bash
cd frontend
npm run build
```

That produces `frontend/dist/` — a folder of static files. To distribute:

- **Host it (send a link):** upload `dist/` to any static host — GitHub Pages,
  Netlify, Cloudflare Pages, Vercel (all have free tiers). The host only serves the
  app; it never sees anyone's data.
- **Open it locally:** the build uses relative paths, so `dist/` also works when
  served from a subfolder. (Opening `index.html` straight off disk mostly works, but
  a tiny local server — e.g. `npx serve dist` — is more reliable across browsers.)

Since there's no backend and no accounts, hosting it costs nothing and carries no
one else's financial data.

## How the numbers are computed

- **Historical balances** are reconstructed from the raw ledger: shares accumulate
  per fund and are valued at the most recent price seen. A position that nets to ≤ 0
  shares is treated as closed, and a data-quality check warns when that implies
  missing early history.
- **Contributions** count only real money in (employee / employer match / profit
  sharing); reinvested dividends and internal reallocations are excluded. They're
  capped by editable annual limits that can grow with inflation.
- **Drawdown is spending-driven**: each retirement year the withdrawal funds spending
  (base living + healthcare + loan payments) after Social Security and other income,
  grossed up for taxes, with the bridge/after-SS figures as a living floor and RMDs
  as a hard floor from tax-deferred buckets. Multiple buckets are drawn in your chosen
  order, each taxed by type; any surplus is kept as cash.
- **Projections** compound the balance a full year and new contributions ~half a
  year, then draw down with Social Security, taxes, and optional RMDs from 73. Monte
  Carlo draws each year's return from a normal distribution around your expected
  return and volatility.

> Not financial advice. This is a personal modeling tool; assumptions are yours to set.

## Requirements

- **Node 18+** (for `npm run dev` / `npm run build`). No Python, no database, no
  server to run.
- Works on macOS, Linux, and Windows, and in any modern browser.

## Project layout

```
frontend/
  src/
    lib/           engine.ts · parser.ts · analytics.ts · db.ts   (the whole app logic, in the browser)
    components/    ImportPanel · Dashboard · Projections · DrawdownScenarios · CoastFire
                   SocialSecurity · AssetsDebts · EventsTaxes · Transactions
    api.ts         local data layer (IndexedDB + engine) — same surface the UI always used
    theme.tsx types.ts format.ts styles.css App.tsx
.github/workflows/ deploy.yml — builds and publishes to GitHub Pages
```

RetirementBuddy started as a FastAPI + SQLite server with a React front end;
`frontend/src/lib/` is a faithful TypeScript port of that engine, parser, and
analytics, so the app now runs entirely in the browser with no server. (The old
backend lives in the project's earlier git history if you ever want to see it.)
