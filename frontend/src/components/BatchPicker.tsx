import React, { useRef, useState } from "react";
import { FileText, Layers, Plus, Upload, X } from "lucide-react";

const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Pick all the files of a ledger first, then decide: merge them into one batch (one ledger) or upload each on its own.
 * Nothing is sent until the upload button is pressed.
 */
export function BatchPicker({
  accept, busy, noun, onUpload, extra,
}: {
  accept: string;
  busy: boolean;
  noun: string;
  onUpload: (files: File[], merge: boolean) => Promise<boolean | void>;
  extra?: React.ReactNode;
}) {
  const [staged, setStaged] = useState<File[]>([]);
  const [merge, setMerge] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const add = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!picked.length) return;
    setStaged((cur) => {
      const have = new Set(cur.map((f) => `${f.name}|${f.size}`));
      return [...cur, ...picked.filter((f) => !have.has(`${f.name}|${f.size}`))];
    });
  };

  const go = async () => {
    if (!staged.length) return;
    const ok = await onUpload(staged, merge && staged.length > 1);
    if (ok !== false) setStaged([]);
  };

  return (
    <div className="space-y-3">
      <input ref={input} type="file" className="hidden" accept={accept} multiple onChange={add} />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40">
          {staged.length ? <Plus className="w-4 h-4" /> : <Upload className="w-4 h-4" />} {staged.length ? "Add more files" : `Select ${noun} files`}
        </button>
        {extra}
      </div>

      {staged.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <p className="text-sm font-medium">{staged.length} file{staged.length > 1 ? "s" : ""} selected</p>
          <ul className="space-y-1.5">
            {staged.map((f) => (
              <li key={`${f.name}|${f.size}`} className="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <span className="flex items-center gap-2 min-w-0"><FileText className="w-4 h-4 text-slate-400 shrink-0" /><span className="truncate">{f.name}</span><span className="text-xs text-slate-400 shrink-0">{size(f.size)}</span></span>
                <button type="button" disabled={busy} onClick={() => setStaged((cur) => cur.filter((x) => x !== f))} aria-label={`Remove ${f.name}`} className="text-slate-400 hover:text-rose-600"><X className="w-4 h-4" /></button>
              </li>
            ))}
          </ul>

          {staged.length > 1 && (
            <fieldset className="grid sm:grid-cols-2 gap-2" aria-label="How to upload these files">
              <label className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer text-sm ${merge ? "border-black bg-white" : "border-slate-200 bg-white"}`}>
                <input type="radio" name="batch-mode" checked={merge} onChange={() => setMerge(true)} className="mt-0.5 accent-black" />
                <span><span className="font-medium flex items-center gap-1.5"><Layers className="w-4 h-4" /> Merge into one batch</span><span className="block text-xs text-slate-500 mt-0.5">All files become one {noun}. Rows that appear in more than one file are counted once.</span></span>
              </label>
              <label className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer text-sm ${!merge ? "border-black bg-white" : "border-slate-200 bg-white"}`}>
                <input type="radio" name="batch-mode" checked={!merge} onChange={() => setMerge(false)} className="mt-0.5 accent-black" />
                <span><span className="font-medium">Upload separately</span><span className="block text-xs text-slate-500 mt-0.5">Each file is kept as its own ledger.</span></span>
              </label>
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={go} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
              <Upload className="w-4 h-4" /> {busy ? "Reading the files..." : staged.length > 1 && merge ? `Merge and upload ${staged.length} files` : `Upload ${staged.length} file${staged.length > 1 ? "s" : ""}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setStaged([])} className="text-sm text-slate-500 underline underline-offset-4">Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
