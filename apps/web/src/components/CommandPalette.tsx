import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { campaignsQuery, contactsQuery, flowsQuery, type Tenant } from '../api.ts';
import { cx } from './ui.tsx';

type Item = { id: string; group: string; label: string; hint?: string; go: () => unknown };

const PAGES = [
  { label: 'Home', to: '/$tenant' },
  { label: 'Campaigns', to: '/$tenant/campaigns' },
  { label: 'Flows', to: '/$tenant/flows' },
  { label: 'Audience', to: '/$tenant/audience' },
  { label: 'Images', to: '/$tenant/images' },
  { label: 'Segments', to: '/$tenant/audience', search: { view: 'segments' as const } },
  { label: 'Sending', to: '/$tenant/sending' },
  { label: 'Sending domain', to: '/$tenant/settings/domain' },
  { label: 'Appearance', to: '/$tenant/settings/appearance' },
  { label: 'Billing', to: '/$tenant/billing' },
  { label: 'Import clients', to: '/$tenant/audience', search: { import: 'clients' as const } },
  { label: 'Developers', to: '/$tenant/developers' },
] as const;

/** Waits until typing settles, so search does not ask the API on every key. */
function useSettled(value: string, ms = 160) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Search and jump: pages, flows, campaigns and clients, all from the keyboard. */
export function CommandPalette({ tenant, open, onClose }: { tenant: Tenant; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const q = text.trim().toLowerCase();
  const search = useSettled(q);
  const { data: flows = [] } = useQuery({ ...flowsQuery(tenant.id), enabled: open });
  const { data: campaigns = [] } = useQuery({ ...campaignsQuery(tenant.id), enabled: open });
  const { data: people } = useQuery({ ...contactsQuery(tenant.id, { search }), enabled: open && search.length > 1, placeholderData: keepPreviousData });

  useEffect(() => {
    if (!open) return;
    setText('');
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const items = useMemo(() => {
    const t = tenant.id;
    const done = (go: () => unknown) => () => {
      onClose();
      return go();
    };
    const all: Item[] = [
      ...PAGES.map((p) => ({ id: `page-${p.label}`, group: 'Go to', label: p.label, go: done(() => navigate({ to: p.to, params: { tenant: t }, search: 'search' in p ? p.search : {} })) })),
      ...flows.map((f) => ({
        id: f.id,
        group: 'Flows',
        label: f.name,
        hint: f.live ? 'Live' : 'Off',
        go: done(() => navigate({ to: '/$tenant/flows/$flow', params: { tenant: t, flow: f.id } })),
      })),
      ...campaigns.slice(0, 40).map((c) => ({
        id: c.id,
        group: 'Campaigns',
        label: c.name,
        hint: c.status === 'draft' ? 'Draft' : c.status === 'scheduled' ? 'Scheduled' : 'Sent',
        go: done(() => navigate({ to: '/$tenant/campaigns/$campaign', params: { tenant: t, campaign: c.id } })),
      })),
    ];
    const matches = q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all.filter((i) => i.group === 'Go to');
    const clients =
      search.length > 1
        ? (people?.contacts ?? []).slice(0, 6).map((c) => ({
            id: c.id,
            group: 'Clients',
            label: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email,
            hint: c.email,
            go: done(() => navigate({ to: '/$tenant/audience', params: { tenant: t }, search: { contact: c.id } })),
          }))
        : [];
    return [...matches.slice(0, 12), ...clients];
  }, [q, search, flows, campaigns, people, tenant.id, navigate, onClose]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void items[active]?.go();
    }
  }

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#12121433] px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex max-h-[min(560px,70vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-[18px] bg-paper shadow-[0_0_0_1px_#12121414,0_30px_80px_-20px_#12121466]"
      >
        <label className="flex items-center gap-3 border-b border-rule px-4">
          <Search aria-hidden size={18} className="text-faint" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
            placeholder="Search clients, emails and flows"
            className="h-14 grow border-0 bg-transparent font-[inherit] text-[15px] text-ink outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md bg-soft px-1.5 py-0.5 font-mono text-[11px] text-muted">Esc</kbd>
        </label>
        <ul ref={list} id="palette-list" role="listbox" className="m-0 list-none overflow-y-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches “{text}”.</li>}
          {items.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={`${item.group}-${item.id}`} role="presentation">
                {heading && <div className="eyebrow px-3 pt-3 pb-1.5">{heading}</div>}
                <div
                  id={`palette-${item.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => void item.go()}
                  className={cx('flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm', i === active && 'bg-tint')}
                >
                  <span className="grow truncate font-medium">{item.label}</span>
                  {item.hint && <span className="truncate text-xs text-muted">{item.hint}</span>}
                  {i === active && <CornerDownLeft aria-hidden size={14} className="shrink-0 text-accent-ink" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
