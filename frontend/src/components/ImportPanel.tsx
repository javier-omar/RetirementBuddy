import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ImportBatch } from "../types";
import InfoTip from "./InfoTip";
import * as fileSync from "../lib/fileSync";
import type { SyncStatus } from "../lib/fileSync";

interface Props {
  imports: ImportBatch[];
  onChanged: () => void;
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ImportPanel({ imports, onChanged }: Props) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [backupMsg, setBackupMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fileSync.isSupported()) fileSync.getStatus().then(setSync);
  }, []);

  async function runSync(fn: () => Promise<SyncStatus | void>, ok: string) {
    setSyncMsg(null);
    try {
      const s = await fn();
      if (s) setSync(s); else setSync(await fileSync.getStatus());
      setSyncMsg({ kind: "ok", text: ok });
    } catch (e) {
      const m = (e as Error).message || "";
      if (/abort/i.test(m)) return; // user cancelled the picker — no error
      setSyncMsg({ kind: "error", text: m });
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.importFile(file);
      setMsg({
        kind: "ok",
        text: `${r.filename}: ${r.new} new transaction${r.new === 1 ? "" : "s"} imported${
          r.duplicates ? `, ${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"} skipped` : ""
        }.`,
      });
      onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function downloadBackup() {
    setBackupMsg(null);
    try {
      const json = await api.exportBackup();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `retirementbuddy-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupMsg({ kind: "ok", text: "Backup downloaded. Keep it somewhere safe (or in iCloud/Dropbox to use on another device)." });
    } catch (e) {
      setBackupMsg({ kind: "error", text: (e as Error).message });
    }
  }

  async function restoreBackup(file: File) {
    if (!confirm("Restoring replaces everything currently in this browser with the backup. Continue?")) return;
    setBackupMsg(null);
    try {
      await api.importBackup(await file.text());
      setBackupMsg({ kind: "ok", text: "Restored. Reloading…" });
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      setBackupMsg({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>Import a 401(k) report</h3>
          <div
            className={`dropzone ${drag ? "drag" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
            }}
          >
            <div className="big">{busy ? "⏳" : "📥"}</div>
            <p>
              {busy ? "Importing…" : (
                <>
                  <strong>Drop a CSV export here</strong>
                  <br />
                  or click to browse
                </>
              )}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </div>
          {msg && (
            <div className={`banner ${msg.kind}`} style={{ marginTop: 14 }}>
              <span>{msg.kind === "ok" ? "✅" : "⚠️"}</span>
              <span>{msg.text}</span>
            </div>
          )}
          <p className="sub" style={{ marginTop: 14 }}>
            Re-importing the same file is safe — duplicate transactions are detected and skipped.
            Columns are auto-mapped (date, category, security, fund, action, type, quantity, price, amount).
            Everything is parsed and stored in your browser; nothing is uploaded. If you have an Excel
            file, export it to CSV first.
          </p>
        </div>

        <div className="card">
          <h3>Import history</h3>
          {imports.length === 0 ? (
            <p className="muted">No imports yet.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>File</th>
                  <th className="num">New</th>
                  <th className="num">Dupes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {imports.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.filename}
                      <div className="sub">{new Date(b.imported_at).toLocaleString()}</div>
                    </td>
                    <td className="num">{b.new_count}</td>
                    <td className="num">{b.duplicate_count}</td>
                    <td className="num">
                      <button
                        className="btn danger sm"
                        onClick={async () => {
                          await api.deleteImport(b.id);
                          onChanged();
                        }}
                      >
                        Undo
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* -------- Backup & restore -------- */}
      <div className="card">
        <h3>
          Your data — backup &amp; restore
          <InfoTip align="left" text="All your data lives only in this browser on this device. Download a backup to keep it safe or move it to another device/browser, then Restore it there." />
        </h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Your imported transactions and all your settings are stored privately in <strong>this browser</strong>,
          on <strong>this device</strong> — never uploaded. Because of that they can be lost if you clear your
          browser data or switch devices, so download a backup now and then.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
          <button className="btn" onClick={downloadBackup}>⬇ Download my data</button>
          <button className="btn ghost" onClick={() => restoreRef.current?.click()}>⬆ Restore from a backup</button>
          <input
            ref={restoreRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && restoreBackup(e.target.files[0])}
          />
        </div>
        {backupMsg && (
          <div className={`banner ${backupMsg.kind}`} style={{ marginTop: 14 }}>
            <span>{backupMsg.kind === "ok" ? "✅" : "⚠️"}</span>
            <span>{backupMsg.text}</span>
          </div>
        )}
        <p className="sub" style={{ marginTop: 12 }}>
          <strong>Moving to a new phone or computer?</strong> Download the backup here, send the file to
          yourself (email, iCloud, Dropbox…), open this app there, and use <em>Restore</em>.
        </p>

        {fileSync.isSupported() && (
          <>
            <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
            <h3 style={{ fontSize: 14 }}>
              Sync to a file
              <InfoTip align="left" text="Connect one backup file on your computer and keep it up to date with a click — or automatically. Put that file in a Google Drive, Dropbox, iCloud Drive, or OneDrive folder and your computer syncs it to the cloud for you; the app itself still uploads nothing." />
            </h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Keep a backup file that stays current automatically. Save it inside a Google Drive / Dropbox /
              iCloud Drive folder and your computer syncs it to the cloud — nothing is uploaded by the app.
              Available in Chrome &amp; Edge on desktop.
            </p>

            {!sync?.connected ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => runSync(fileSync.connect, "Backup file connected — it'll stay in sync.")}>
                  🔗 Connect a backup file
                </button>
                <button
                  className="btn ghost"
                  onClick={() => runSync(async () => {
                    const json = await fileSync.openFrom();
                    if (!confirm("Restore replaces everything in this browser with the chosen file. Continue?")) return fileSync.getStatus();
                    await api.importBackup(json);
                    setTimeout(() => window.location.reload(), 500);
                  }, "Restored from file. Reloading…")}
                >
                  Restore from a file…
                </button>
              </div>
            ) : (
              <>
                <div className="banner ok" style={{ marginBottom: 10 }}>
                  <span>🔗</span>
                  <span>
                    Connected: <strong>{sync.name}</strong>
                    {sync.lastSaved ? ` · saved ${relTime(sync.lastSaved)}` : ""}
                    {sync.autoSave ? " · auto-saving on" : ""}
                  </span>
                </div>
                {sync.permission !== "granted" && (
                  <div className="banner warn" style={{ marginBottom: 10 }}>
                    <span>⚠️</span>
                    <span>
                      Reconnect to let this browser write the file again.{" "}
                      <button className="btn sm" style={{ marginLeft: 6 }}
                        onClick={() => runSync(fileSync.reconnect, "Reconnected — auto-save is active again.")}>
                        Reconnect
                      </button>
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="btn" onClick={() => runSync(fileSync.saveNow, "Saved to your backup file.")}>Save now</button>
                  <label className="toggle">
                    <input type="checkbox" checked={sync.autoSave}
                      onChange={async (e) => { await fileSync.setAutoSave(e.target.checked); setSync(await fileSync.getStatus()); }} />
                    Auto-save on every change
                  </label>
                  <button className="btn ghost sm" onClick={() => runSync(async () => { await fileSync.disconnect(); }, "Disconnected. Your file is untouched.")}>
                    Disconnect
                  </button>
                </div>
              </>
            )}
            {syncMsg && (
              <div className={`banner ${syncMsg.kind}`} style={{ marginTop: 12 }}>
                <span>{syncMsg.kind === "ok" ? "✅" : "⚠️"}</span><span>{syncMsg.text}</span>
              </div>
            )}
          </>
        )}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm("This permanently clears all data in this browser (transactions, settings, sample data) and starts over. This can't be undone. Continue?")) return;
            await api.resetAll();
            window.location.reload();
          }}
        >
          Clear all data &amp; start over
        </button>
        <p className="sub" style={{ marginTop: 8 }}>
          Wipes everything on this device and returns to setup. Download a backup first if you might want it back.
        </p>
      </div>
    </div>
  );
}
