import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, ChevronDown, CodeXml, CreditCard, Globe, House, Image as ImageIcon, Megaphone, Palette, Plus, Search, Send, Sparkles, SquarePen, type LucideIcon, Users, Workflow, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { auth, meQuery, tenantsQuery, useCreateCampaign, type Tenant } from '../api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { inStudio, studioSession, tellHost } from '../studio.ts';
import { brandVars, type Brand } from '../theme.ts';
import { cx } from './ui.tsx';

type Area = { to: string; label: string; icon: LucideIcon; exact?: boolean };

const RAIL: Area[][] = [
  [
    { to: '/$tenant', label: 'Home', icon: House, exact: true },
    { to: '/$tenant/campaigns', label: 'Campaigns', icon: Megaphone },
    { to: '/$tenant/flows', label: 'Flows', icon: Workflow },
  ],
  [
    { to: '/$tenant/audience', label: 'Audience', icon: Users },
    { to: '/$tenant/images', label: 'Images', icon: ImageIcon },
    { to: '/$tenant/sending', label: 'Sending', icon: Send },
  ],
];

const BOTTOM: Area[] = [
  { to: '/$tenant/settings/domain', label: 'Sending domain', icon: Globe },
  { to: '/$tenant/developers', label: 'Developers', icon: CodeXml },
  { to: '/$tenant/settings/appearance', label: 'Appearance', icon: Palette },
  { to: '/$tenant/billing', label: 'Billing', icon: CreditCard },
];

/** Lets a page (Appearance) show a brand across the whole app before it is saved. */
const PreviewContext = createContext<{ setPreview: (brand: Brand | null) => void }>({ setPreview: () => {} });
export const useBrandPreview = () => useContext(PreviewContext);

const TenantContext = createContext<Tenant | null>(null);
export function useTenant() {
  const tenant = useContext(TenantContext);
  if (!tenant) throw new Error('useTenant outside the shell');
  return tenant;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

export function Shell() {
  const { tenant: tenantId } = useParams({ from: '/$tenant' });
  const { data: tenants } = useSuspenseQuery(tenantsQuery);
  const tenant = tenants.find((t) => t.id === tenantId);
  const [preview, setPreview] = useState<Brand | null>(null);
  const [assistant, setAssistant] = useState(() => readFlag('assistant', false));
  const [searching, setSearching] = useState(false);
  const style = useMemo(() => brandVars(preview ?? tenant?.brand) as CSSProperties, [preview, tenant?.brand]);

  useEffect(() => writeFlag('assistant', assistant), [assistant]);
  // ⌘K (Ctrl+K elsewhere) opens search from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    setPreview(null);
    writeLastTenant(tenantId);
  }, [tenantId]);

  if (!tenant) return <NotFound tenants={tenants} />;
  if (inStudio()) return <StudioShell tenant={tenant} />;

  return (
    <TenantContext.Provider value={tenant}>
      <PreviewContext.Provider value={{ setPreview }}>
        <div style={style} className="flex h-full min-h-[600px] bg-canvas">
          <Rail tenant={tenant} assistant={assistant} onAssistant={() => setAssistant((a) => !a)} />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="@container mx-auto flex max-w-[1240px] flex-col gap-5 px-8 pt-5 pb-12">
                <TopBar tenant={tenant} tenants={tenants} onSearch={() => setSearching(true)} />
                <Outlet />
              </div>
            </div>
          </main>
          {assistant && <Assistant tenant={tenant} onClose={() => setAssistant(false)} />}
          <CommandPalette tenant={tenant} open={searching} onClose={() => setSearching(false)} />
        </div>
      </PreviewContext.Provider>
    </TenantContext.Provider>
  );
}

function RailLink({ area, tenant }: { area: Area; tenant: string }) {
  const Icon = area.icon;
  return (
    <Link
      to={area.to}
      params={{ tenant }}
      activeOptions={{ exact: area.exact }}
      aria-label={area.label}
      title={area.label}
      className="flex h-10 w-[42px] items-center justify-center rounded-[11px] text-(--rail-icon) transition hover:bg-(--rail-active-bg) data-[status=active]:bg-(--rail-active-bg) data-[status=active]:text-(--rail-active-ink) data-[status=active]:shadow-(--rail-active-shadow)"
    >
      <Icon size={20} strokeWidth={1.6} />
    </Link>
  );
}

function Rail({ tenant, assistant, onAssistant }: { tenant: Tenant; assistant: boolean; onAssistant: () => void }) {
  return (
    <nav
      aria-label="Main"
      className="rail relative isolate flex w-16 shrink-0 flex-col items-center gap-1.5 overflow-hidden rounded-r-[22px] py-[18px]"
      style={{ background: 'var(--rail-bg)' }}
    >
      <Link
        to="/$tenant"
        params={{ tenant: tenant.id }}
        aria-label="Home"
        className="display mb-[18px] flex size-8 items-center justify-center rounded-[10px] bg-(--logo-bg) text-[17px] text-(--logo-ink)"
      >
        {tenant.brand.logoUrl ? <img src={tenant.brand.logoUrl} alt="" className="size-8 rounded-[10px] object-cover" /> : 'N'}
      </Link>
      {RAIL.map((group, i) => (
        <div key={i} className={cx('flex flex-col items-center gap-1.5', i > 0 && 'mt-[18px]')}>
          {group.map((area) => (
            <RailLink key={area.to} area={area} tenant={tenant.id} />
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={onAssistant}
        aria-label="Assistant"
        aria-pressed={assistant}
        title="Assistant"
        className={cx(
          'mt-[18px] flex h-10 w-[42px] cursor-pointer items-center justify-center rounded-[11px] border-0 transition',
          assistant ? 'bg-(--rail-active-bg) text-(--rail-active-ink) shadow-(--rail-active-shadow)' : 'bg-transparent text-(--rail-icon) hover:bg-(--rail-active-bg)',
        )}
      >
        <Sparkles size={20} strokeWidth={1.6} />
      </button>
      <div className="mt-auto flex flex-col items-center gap-1.5">
        {BOTTOM.map((area) => (
          <RailLink key={area.to} area={area} tenant={tenant.id} />
        ))}
        <AccountMenu />
      </div>
    </nav>
  );
}

function AccountMenu() {
  const { data: me } = useQuery(meQuery);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const name = me?.user.name ?? '';
  return (
    <div className="relative mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Your account"
        aria-expanded={open}
        title={me?.user.email ?? undefined}
        className="flex size-8 cursor-pointer items-center justify-center rounded-full border-0 bg-(--avatar-bg) text-[11px] font-semibold text-(--avatar-ink)"
      >
        {initials(name) || '·'}
      </button>
      {open && (
        <div className="absolute bottom-0 left-11 z-30 w-60 rounded-xl border border-rule bg-paper p-1.5 text-[13px] text-ink shadow-[0_8px_30px_#0000001F]">
          <div className="px-2.5 py-2">
            <div className="font-semibold">{name}</div>
            <div className="truncate text-muted">{me?.user.email}</div>
          </div>
          <button
            type="button"
            onClick={async () => {
              await auth.signOut();
              client.clear();
              await navigate({ to: '/sign-in' });
            }}
            className="w-full cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-2 text-left font-[inherit] hover:bg-soft"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function TopBar({ tenant, tenants, onSearch }: { tenant: Tenant; tenants: Tenant[]; onSearch: () => void }) {
  const navigate = useNavigate();
  const create = useCreateCampaign(tenant.id);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  async function newEmail() {
    const draft = await create.mutateAsync({});
    await navigate({ to: '/$tenant/campaigns/$campaign', params: { tenant: tenant.id, campaign: draft.id } });
  }
  return (
    <header className="flex flex-wrap items-center gap-3">
      <label className="relative flex h-10 items-center gap-2.5 rounded-full bg-paper pr-3.5 pl-1.5 text-sm font-semibold shadow-ring">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-accent text-[11px] text-on-accent">
          {initials(tenant.name)}
        </span>
        <span className="max-w-[220px] truncate">{tenant.name}</span>
        {tenant.app && tenant.app !== 'Direct' && <span className="font-normal text-faint">{tenant.app}</span>}
        <ChevronDown aria-hidden size={15} className="text-faint" />
        <select
          aria-label="Business"
          value={tenant.id}
          onChange={(e) => (e.target.value === '+' ? navigate({ to: '/setup' }) : navigate({ to: '/$tenant', params: { tenant: e.target.value } }))}
          className="absolute inset-0 cursor-pointer appearance-none rounded-full opacity-0"
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.app && t.app !== 'Direct' ? ` · ${t.app}` : ''}
            </option>
          ))}
          <option value="+">Add a business…</option>
        </select>
      </label>
      <button
        type="button"
        onClick={onSearch}
        className="flex h-10 min-w-[220px] flex-[1_1_260px] cursor-pointer items-center gap-2.5 rounded-full border-0 bg-white/60 px-3.5 text-left font-[inherit] text-[13.5px] text-faint shadow-ring transition hover:bg-white"
      >
        <Search aria-hidden size={16} />
        <span className="grow truncate">Search clients, emails and flows</span>
        <kbd className="rounded-md bg-paper px-1.5 py-0.5 font-mono text-[11px] text-muted shadow-ring">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {tenant.status === 'paused' && (
        <Link to="/$tenant/sending" params={{ tenant: tenant.id }} className="rounded-full bg-bad-bg px-3 py-1.5 text-xs font-semibold text-bad">
          Sending paused
        </Link>
      )}
      <button
        type="button"
        onClick={newEmail}
        disabled={create.isPending}
        className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border-0 bg-ink px-4 font-[inherit] text-[13px] font-medium text-white transition hover:bg-black disabled:opacity-60"
      >
        <Plus aria-hidden size={15} /> New email
      </button>
    </header>
  );
}

const ASKS = ['Fill Thursday’s empty slots', 'Who is due a visit this week?', 'Draft the October newsletter', 'Build a flow for quiet Tuesdays'];

function Assistant({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  return (
    <aside
      aria-label="Assistant"
      className="m-3 ml-0 hidden w-[340px] shrink-0 flex-col overflow-hidden rounded-[18px] bg-paper shadow-card xl:flex"
    >
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-rule pr-3 pl-5">
        <span className="text-sm font-semibold">New chat</span>
        <span className="flex gap-0.5 text-muted">
          <button type="button" aria-label="Start a new chat" className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-inherit hover:bg-soft">
            <SquarePen size={17} strokeWidth={1.6} />
          </button>
          <button type="button" onClick={onClose} aria-label="Close the assistant" className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-inherit hover:bg-soft">
            <X size={17} strokeWidth={1.6} />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-4 px-5 py-[22px]">
        <div className="flex flex-col items-center gap-3 text-center">
          <svg aria-hidden width="40" height="40" viewBox="0 0 24 24">
            <defs>
              <linearGradient id="spark" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--accent-light)" />
                <stop offset="1" stopColor="var(--accent)" />
              </linearGradient>
            </defs>
            <path fill="url(#spark)" d="M12 2c.7 5.3 2.3 7.4 7.5 8.9-5.2 1.5-6.8 3.6-7.5 8.9-.7-5.3-2.3-7.4-7.5-8.9C9.7 9.4 11.3 7.3 12 2z" />
          </svg>
          <div className="display max-w-[300px] text-[22px] leading-[1.2]">What shall we fill this week?</div>
          <div className="max-w-[270px] text-[13px] leading-normal text-muted">
            I will see {tenant.name}’s diary, clients and every email result. These are the first questions I will answer.
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {ASKS.map((q) => (
            <button
              key={q}
              type="button"
              disabled
              className="flex items-center gap-2.5 rounded-xl border border-rule bg-paper px-[13px] py-[11px] text-left font-[inherit] text-[13px] text-ink disabled:cursor-default"
            >
              <span className="grow">{q}</span>
              <ArrowRight aria-hidden size={14} className="text-faint" />
            </button>
          ))}
        </div>
      </div>
      <div className="p-3.5">
        <div className="rounded-[14px] p-px" style={{ background: 'linear-gradient(135deg, var(--accent-light), var(--rule) 60%)' }}>
          <div className="flex items-center gap-2.5 rounded-[13px] bg-paper py-3 pr-2.5 pl-3.5">
            <span className="grow text-[13px] text-faint">The assistant arrives with flows</span>
            <span aria-hidden className="flex size-[30px] items-center justify-center rounded-full bg-soft text-faint">
              <ArrowUp size={15} />
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NotFound({ tenants }: { tenants: Tenant[] }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="display text-2xl">No business with that name</h1>
        {tenants[0] && (
          <Link to="/$tenant" params={{ tenant: tenants[0].id }} className="mt-3 inline-block text-sm font-semibold underline">
            Go to {tenants[0].name}
          </Link>
        )}
      </div>
    </div>
  );
}

export function readFlag(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Private mode: the panel just reopens next time.
  }
}

/** The business someone last opened, so signing in returns them to it. */
export function readLastTenant() {
  try {
    return localStorage.getItem('lastTenant');
  } catch {
    return null;
  }
}

function writeLastTenant(id: string) {
  try {
    localStorage.setItem('lastTenant', id);
  } catch {
    // Private mode: sign-in opens the first business instead.
  }
}

const STUDIO_TABS = [
  { to: '/$tenant/campaigns', label: 'Campaigns' },
  { to: '/$tenant/flows', label: 'Flows' },
  { to: '/$tenant/audience', label: 'Audience' },
  { to: '/$tenant/images', label: 'Images' },
] as const;

/**
 * The studio inside a host app: no rail, business switcher or assistant, since the host has its own
 * navigation. It takes the host's accent, heading font and background so it reads as part of the host.
 */
function StudioShell({ tenant }: { tenant: Tenant }) {
  const theme = studioSession()?.theme ?? {};
  const style = useMemo(
    () => ({ ...brandVars({ accent: theme.accent, headingFont: theme.headingFont, rail: 'light' }), ...(theme.canvas && { '--canvas': theme.canvas }) }) as CSSProperties,
    [theme.accent, theme.headingFont, theme.canvas],
  );

  // Tell the host how tall the content is, so it can size the frame and avoid a scroll inside a scroll.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tellHost({ type: 'ready' });
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => tellHost({ type: 'resize', height: Math.ceil(el.offsetHeight) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <TenantContext.Provider value={tenant}>
      <div style={style} className="min-h-full bg-canvas">
        <div ref={content}>
          <nav aria-label="Studio" className="flex items-center gap-1 px-5 pt-4">
            {STUDIO_TABS.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                params={{ tenant: tenant.id }}
                className="rounded-full px-3.5 py-1.5 text-[13px] text-muted transition hover:text-ink data-[status=active]:bg-paper data-[status=active]:font-semibold data-[status=active]:text-ink data-[status=active]:shadow-[0_1px_2px_#0000001A]"
              >
                {tab.label}
              </Link>
            ))}
          </nav>
          <div className="@container mx-auto flex max-w-[1180px] flex-col gap-5 px-5 py-5">
            <Outlet />
          </div>
        </div>
      </div>
    </TenantContext.Provider>
  );
}
