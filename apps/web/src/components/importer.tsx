/**
 * Bringing clients and past visits in from a spreadsheet: drop a CSV, check which column is which,
 * and import in batches. Column names are guessed from what booking systems usually export.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Check, FileUp, Upload } from 'lucide-react';
import Papa from 'papaparse';
import { useRef, useState, type DragEvent } from 'react';
import { importRows, type ClientRow, type ImportResult, type VisitRow } from '../api.ts';
import { Button, Notice, cx } from './ui.tsx';

export type ImportKind = 'clients' | 'visits';

type Field = { key: string; label: string; required?: boolean; guess: RegExp };

const FIELDS: Record<ImportKind, Field[]> = {
  clients: [
    { key: 'email', label: 'Email', required: true, guess: /e-?mail/i },
    { key: 'firstName', label: 'First name', guess: /^(first|given|fore)\s*name|^first$/i },
    { key: 'lastName', label: 'Last name', guess: /^(last|family|sur)\s*name|^surname$|^last$/i },
    { key: 'fullName', label: 'Full name', guess: /^(full\s*)?name$|^client(\s*name)?$|^customer(\s*name)?$/i },
    { key: 'phone', label: 'Phone', guess: /phone|mobile|tel/i },
    { key: 'consent', label: 'Said yes to news', guess: /marketing|consent|opt.?in|newsletter|subscri|news/i },
    { key: 'birthday', label: 'Birthday', guess: /birth|dob|bday/i },
  ],
  visits: [
    { key: 'email', label: 'Client email', required: true, guess: /e-?mail/i },
    { key: 'date', label: 'Date', required: true, guess: /date|when|start|appointment|time/i },
    { key: 'service', label: 'Service', guess: /service|treatment|item|appointment\s*type/i },
    { key: 'price', label: 'Price', guess: /price|amount|total|value|paid|£/i },
    { key: 'staff', label: 'With', guess: /staff|stylist|therapist|employee|team|with|practitioner/i },
    { key: 'fullName', label: 'Client name', guess: /^(client|customer)(\s*name)?$|^name$/i },
  ],
};

const SAMPLE: Record<ImportKind, string> = {
  clients: 'Email,First name,Last name,Phone\nama@example.com,Ama,Mensah,07700 900123\nkofi@example.com,Kofi,Boateng,\n',
  visits: 'Client email,Date,Service,Price,With\nama@example.com,02/06/2026 10:00,Facial,45.00,Maya\nama@example.com,01/07/2026 10:00,Facial,45.00,Maya\n',
};

const BATCH = 500;

/** What booking systems write in an opt-in column for "yes". */
const YES = /^(y|yes|true|1|opted.?in|subscribed|granted|agreed|✓|x)$/i;

/** UK dates (day first) to ISO; anything else is left for the server to read. */
export function ukDate(value: string) {
  const v = value.trim();
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ ,T]+(\d{1,2}):(\d{2}))?/);
  if (!m) return v;
  const [, d, mo, y, h = '12', mi = '00'] = m;
  const year = y!.length === 2 ? `20${y}` : y!;
  return `${year}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00`;
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] || undefined, lastName: parts.slice(1).join(' ') || undefined };
}

type Parsed = { name: string; headers: string[]; rows: Record<string, string>[] };

export function Importer({ tenant, kind, onDone }: { tenant: string; kind: ImportKind; onDone?: (result: ImportResult) => void }) {
  const fields = FIELDS[kind];
  const [file, setFile] = useState<Parsed | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState<'granted' | 'unknown' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const client = useQueryClient();

  function read(f: File) {
    setError(null);
    setResult(null);
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: ({ data, meta }) => {
        const headers = (meta.fields ?? []).filter(Boolean);
        if (!headers.length || !data.length) {
          setError('That file has no rows we can read. Save it from your spreadsheet as CSV and try again.');
          return;
        }
        const guessed: Record<string, string> = {};
        for (const field of fields) {
          const hit = headers.find((h) => field.guess.test(h) && !Object.values(guessed).includes(h));
          if (hit) guessed[field.key] = hit;
        }
        setFile({ name: f.name, headers, rows: data });
        setMap(guessed);
      },
      error: () => setError('We could not read that file. Save it as CSV and try again.'),
    });
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) read(f);
  }

  const value = (row: Record<string, string>, key: string) => (map[key] ? (row[map[key]!] ?? '').trim() : '');

  function toRow(row: Record<string, string>): ClientRow | VisitRow {
    const names = !value(row, 'firstName') && value(row, 'fullName') ? splitName(value(row, 'fullName')) : { firstName: value(row, 'firstName') || undefined, lastName: value(row, 'lastName') || undefined };
    if (kind === 'clients') return { email: value(row, 'email'), ...names, phone: value(row, 'phone') || undefined, birthday: value(row, 'birthday') || undefined };
    return {
      email: value(row, 'email'),
      ...names,
      date: ukDate(value(row, 'date')),
      service: value(row, 'service') || undefined,
      staff: value(row, 'staff') || undefined,
      price: value(row, 'price') || undefined,
    };
  }

  /**
   * One batch. With an opt-in column, the people it marks yes are sent as agreed and everyone else
   * as not known, keeping their row numbers so skipped rows still point at the right line.
   */
  async function importBatch(batch: Record<string, string>[]): Promise<ImportResult> {
    if (kind === 'visits') return importRows(tenant, 'visits', { visits: batch.map(toRow) as VisitRow[] });
    if (!map.consent) return importRows(tenant, 'clients', { clients: batch.map(toRow) as ClientRow[], consent: consent ?? 'unknown' });
    const sum: ImportResult = { added: 0, updated: 0, consented: 0, skipped: [] };
    for (const yes of [true, false]) {
      const picked = batch.map((row, n) => ({ row, n })).filter(({ row }) => YES.test(value(row, 'consent')) === yes);
      if (!picked.length) continue;
      const r = await importRows(tenant, 'clients', { clients: picked.map(({ row }) => toRow(row)) as ClientRow[], consent: yes ? 'granted' : 'unknown' });
      sum.added! += r.added ?? 0;
      sum.updated! += r.updated ?? 0;
      sum.consented! += r.consented ?? 0;
      sum.skipped.push(...r.skipped.map((s) => ({ ...s, row: picked[s.row - 1]!.n + 1 })));
    }
    sum.skipped.sort((a, b) => a.row - b.row);
    return sum;
  }

  async function run() {
    if (!file) return;
    setError(null);
    setProgress(0);
    const total: ImportResult = { added: 0, updated: 0, consented: 0, saved: 0, skipped: [] };
    try {
      for (let i = 0; i < file.rows.length; i += BATCH) {
        const batch = file.rows.slice(i, i + BATCH);
        const r = await importBatch(batch);
        total.added! += r.added ?? 0;
        total.updated! += r.updated ?? 0;
        total.consented! += r.consented ?? 0;
        total.saved! += r.saved ?? 0;
        // Row numbers as people see them in their spreadsheet: one header row, counting from 1.
        total.skipped.push(...r.skipped.map((s) => ({ ...s, row: i + s.row + 1 })));
        setProgress(Math.min(file.rows.length, i + BATCH) / file.rows.length);
      }
      setResult(total);
      void client.invalidateQueries();
      onDone?.(total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import stopped part way. Try again; rows already in are not doubled.');
    } finally {
      setProgress(null);
    }
  }

  const missing = fields.filter((f) => f.required && !map[f.key]);
  const ready = file && !missing.length && (kind === 'visits' || consent || map.consent);

  if (result) {
    const good = kind === 'clients' ? (result.added ?? 0) + (result.updated ?? 0) : (result.saved ?? 0);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3 rounded-[14px] bg-[var(--good-bg)] px-4 py-3.5 text-[var(--good)]">
          <Check size={18} className="mt-0.5 shrink-0" />
          <div className="text-[13.5px] leading-relaxed">
            <strong>
              {good.toLocaleString('en-GB')} {kind === 'clients' ? (good === 1 ? 'client' : 'clients') : good === 1 ? 'visit' : 'visits'} in.
            </strong>{' '}
            {kind === 'clients' &&
              `${(result.added ?? 0).toLocaleString('en-GB')} new, ${(result.updated ?? 0).toLocaleString('en-GB')} already here. ${(result.consented ?? 0).toLocaleString('en-GB')} can get your news.`}
            {kind === 'visits' && 'Each client’s usual gap between visits is worked out from these.'}
          </div>
        </div>
        {result.skipped.length > 0 && (
          <details className="text-[13px] text-muted">
            <summary className="cursor-pointer">
              {result.skipped.length.toLocaleString('en-GB')} {result.skipped.length === 1 ? 'row' : 'rows'} left out
            </summary>
            <ul className="mt-2 mb-0 flex flex-col gap-1 pl-4">
              {result.skipped.slice(0, 8).map((s) => (
                <li key={s.row}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <button type="button" onClick={() => (setFile(null), setResult(null))} className="self-start cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-ink underline">
          Import another file
        </button>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-col gap-2.5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          className={cx(
            'flex cursor-pointer flex-col items-center gap-2 rounded-[16px] border-[1.5px] border-dashed px-6 py-9 text-center transition',
            over ? 'border-accent bg-tint' : 'border-rule-strong bg-soft hover:border-ink',
          )}
        >
          <span className="grid size-10 place-items-center rounded-full bg-paper text-accent-ink shadow-ring">
            <FileUp size={18} />
          </span>
          <span className="text-[14px] font-medium">Drop a CSV file here, or choose one</span>
          <span className="max-w-[360px] text-xs leading-relaxed text-muted">
            {kind === 'clients'
              ? 'Export your client list from your booking system or spreadsheet. Only an email column is needed.'
              : 'Export past appointments with the client’s email and the date. Service and price make it smarter.'}
          </span>
          <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} aria-label="CSV file" />
        </div>
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE[kind])}`} download={`${kind}-example.csv`} className="self-start text-xs text-muted underline">
          Download an example file
        </a>
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    );
  }

  const preview = file.rows.slice(0, 3);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span>
          <strong>{file.name}</strong> <span className="text-muted">· {file.rows.length.toLocaleString('en-GB')} rows</span>
        </span>
        <button type="button" onClick={() => setFile(null)} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted underline">
          Choose another
        </button>
      </div>

      <div className="overflow-hidden rounded-[14px] shadow-ring">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-soft text-left text-xs text-muted">
              <th className="px-3.5 py-2 font-medium">We need</th>
              <th className="px-3.5 py-2 font-medium">From your column</th>
              <th className="px-3.5 py-2 font-medium">First row</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.key} className="border-t border-rule">
                <td className="px-3.5 py-2">
                  {field.label}
                  {field.required && <span className="text-[var(--bad)]"> *</span>}
                </td>
                <td className="px-3.5 py-1.5">
                  <select
                    aria-label={`Column for ${field.label}`}
                    value={map[field.key] ?? ''}
                    onChange={(e) => setMap((m) => ({ ...m, [field.key]: e.target.value }))}
                    className="h-8 w-full max-w-[220px] rounded-[8px] border border-rule-strong bg-paper px-2 font-[inherit] text-[13px]"
                  >
                    <option value="">Not in this file</option>
                    {file.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="max-w-[180px] truncate px-3.5 py-2 text-muted">{preview[0] ? value(preview[0], field.key) || '·' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && <Notice tone="bad">Choose the column for {missing.map((f) => f.label.toLowerCase()).join(' and ')}.</Notice>}

      {kind === 'clients' && map.consent && (
        <Notice>
          People marked yes in “{map.consent}” are added as agreeing to your news, and we record that you confirmed it. Everyone else still gets booking emails.
        </Notice>
      )}
      {kind === 'clients' && !map.consent && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-[13px] font-medium">Did these people agree to hear news and offers from you?</legend>
          {(
            [
              ['granted', 'Yes, they agreed', 'For example, they ticked a box when booking. We record that you confirmed it.'],
              ['unknown', 'Not sure', 'They still get booking emails. Ask them to join your list before sending them news.'],
            ] as const
          ).map(([v, title, hint]) => (
            <label key={v} className={cx('flex cursor-pointer items-start gap-3 rounded-[12px] px-3.5 py-3 shadow-ring', consent === v && 'bg-tint')}>
              <input type="radio" name="consent" checked={consent === v} onChange={() => setConsent(v)} className="mt-1 accent-[var(--accent)]" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13.5px] font-medium">{title}</span>
                <span className="text-xs leading-relaxed text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {error && <Notice tone="bad">{error}</Notice>}
      {progress !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="h-2 overflow-hidden rounded-full bg-well">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, progress * 100)}%` }} />
          </div>
          <span className="text-xs text-muted">Importing…</span>
        </div>
      ) : (
        <Button variant="accent" disabled={!ready} onClick={run} className="self-start">
          <Upload size={15} /> Import {file.rows.length.toLocaleString('en-GB')} {kind === 'clients' ? 'clients' : 'visits'}
        </Button>
      )}
    </div>
  );
}
