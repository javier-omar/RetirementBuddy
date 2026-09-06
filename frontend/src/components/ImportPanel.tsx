import { useRef, useState } from "react";
import { api } from "../api";
import type { ImportBatch } from "../types";
import InfoTip from "./InfoTip";

interface Props {
  imports: ImportBatch[];
  onChanged: () => void;
}

export default function ImportPanel({ imports, onChanged }: Props) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [backupMsg, setBackupMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

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
      </div>
    </div>
  );
}
