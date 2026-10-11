import { Check, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSaveBrand } from '../api.ts';
import { useBrandPreview, useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, PageTitle, Segmented, cx } from '../components/ui.tsx';
import { ACCENTS, DEFAULT_BRAND, FONTS, shadesFor, type Brand } from '../theme.ts';

type Font = keyof typeof FONTS;

const TIME_ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/London'];
  }
})();

export function Appearance() {
  const tenant = useTenant();
  const { setPreview } = useBrandPreview();
  const saved = { ...DEFAULT_BRAND, ...tenant.brand };
  const [draft, setDraft] = useState<Brand>(saved);
  const [timezone, setTimezone] = useState(tenant.timezone);
  const save = useSaveBrand(tenant.id);
  const accent = shadesFor(draft.accent).accent;
  const dirty =
    accent !== shadesFor(saved.accent).accent ||
    draft.rail !== saved.rail ||
    draft.headingFont !== saved.headingFont ||
    (draft.logoUrl ?? '') !== (saved.logoUrl ?? '') ||
    (draft.address ?? '') !== (saved.address ?? '') ||
    (draft.bookingUrl ?? '') !== (saved.bookingUrl ?? '') ||
    (draft.reviewUrl ?? '') !== (saved.reviewUrl ?? '') ||
    timezone !== tenant.timezone;

  // The whole app shows the draft while this page is open; leaving the page drops it.
  useEffect(() => setPreview(draft), [draft, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);

  const update = (patch: Partial<Brand>) => {
    save.reset();
    setDraft((d) => ({ ...d, ...patch }));
  };

  return (
    <>
      <PageTitle
        title="Appearance"
        subtitle="The standard look suits most businesses. Change three things to make it yours; everything else follows."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => update({ ...DEFAULT_BRAND })} disabled={save.isPending}>
              <RotateCcw size={14} /> Standard look
            </Button>
            <Button
              onClick={() =>
                save.mutate({
                  accent,
                  rail: draft.rail,
                  headingFont: draft.headingFont,
                  logoUrl: draft.logoUrl?.trim() ?? '',
                  address: draft.address?.trim() ?? '',
                  bookingUrl: draft.bookingUrl?.trim() ?? '',
                  reviewUrl: draft.reviewUrl?.trim() ?? '',
                  timezone,
                })
              }
              disabled={!dirty || save.isPending}
            >
              {save.isSuccess && !dirty ? (
                <>
                  <Check size={14} /> Saved
                </>
              ) : save.isPending ? (
                'Saving…'
              ) : (
                'Save'
              )}
            </Button>
          </div>
        }
      />
      {save.isError && <Notice tone="bad">{save.error.message}</Notice>}

      <Card className="flex flex-col gap-6 px-6 py-6">
        <Field label="Accent" hint="Charts, highlights and the rail glow use it. Text shades are adjusted so they stay readable.">
          <div className="flex flex-wrap items-center gap-2.5">
            {ACCENTS.map((a) => {
              const on = a.accent === accent;
              return (
                <button
                  key={a.name}
                  type="button"
                  aria-label={a.name}
                  aria-pressed={on}
                  title={a.name}
                  onClick={() => update({ accent: a.accent })}
                  className="size-8 cursor-pointer rounded-full border-0 p-0"
                  style={{ background: a.accent, boxShadow: on ? `0 0 0 2px #fff, 0 0 0 4px ${a.accent}` : undefined }}
                />
              );
            })}
            <span aria-hidden className="mx-1 h-6 w-px bg-rule" />
            <label className={cx('flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px]', ACCENTS.some((a) => a.accent === accent) ? 'border-rule-strong' : 'border-ink')}>
              <input
                type="color"
                value={accent.toLowerCase()}
                onChange={(e) => update({ accent: e.target.value.toUpperCase() })}
                className="size-5 cursor-pointer rounded-full border-0 bg-transparent p-0"
              />
              Your own colour
              <span className="font-mono text-xs text-muted">{accent}</span>
            </label>
          </div>
        </Field>

        <Field label="Side rail" hint="Pigment is a soft glow of your accent; Light keeps it plain.">
          <Segmented
            label="Side rail"
            value={draft.rail ?? 'pigment'}
            onChange={(rail) => update({ rail })}
            options={[
              { value: 'pigment', label: 'Pigment' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </Field>

        <Field label="Headings" hint="Body text is always Inter, so tables and numbers stay easy to read.">
          <Segmented<Font>
            label="Headings"
            value={draft.headingFont ?? 'cal-sans'}
            onChange={(headingFont) => update({ headingFont })}
            options={(Object.keys(FONTS) as Font[]).map((k) => ({
              value: k,
              label: <span style={{ fontFamily: FONTS[k].display }}>{FONTS[k].label}</span>,
            }))}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-6 px-6 py-6">
        <Field label="Logo in emails" hint="A link to your logo (PNG or JPG, already online). Without one, emails show your business name.">
          <input
            value={draft.logoUrl ?? ''}
            onChange={(e) => update({ logoUrl: e.target.value })}
            placeholder="https://…/logo.png"
            className="h-9 w-full max-w-md rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] outline-none focus:border-ink"
          />
        </Field>
        <Field label="Postal address" hint="Shown at the foot of newsletters. UK and US rules expect one in marketing email.">
          <input
            value={draft.address ?? ''}
            onChange={(e) => update({ address: e.target.value })}
            placeholder="4 Linden Row, Leeds LS1 4AB"
            className="h-9 w-full max-w-md rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] outline-none focus:border-ink"
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-6 px-6 py-6">
        <Field label="Booking link" hint="Your online booking page. Flows and booking buttons send clients here, and free-time buttons open it at that time.">
          <input
            value={draft.bookingUrl ?? ''}
            onChange={(e) => update({ bookingUrl: e.target.value })}
            placeholder="https://lindenstudio.co.uk/book"
            className="h-9 w-full max-w-md rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] outline-none focus:border-ink"
          />
        </Field>
        <Field label="Review link" hint="Where happy clients leave a review, such as your Google profile. The review flow asks clients after a visit.">
          <input
            value={draft.reviewUrl ?? ''}
            onChange={(e) => update({ reviewUrl: e.target.value })}
            placeholder="https://g.page/r/…/review"
            className="h-9 w-full max-w-md rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] outline-none focus:border-ink"
          />
        </Field>
        <Field label="Time zone" hint="Flows only send between 9am and 7pm here, and free times are shown in it.">
          <select
            value={timezone}
            onChange={(e) => {
              save.reset();
              setTimezone(e.target.value);
            }}
            aria-label="Time zone"
            className="h-9 w-full max-w-md rounded-[10px] border border-rule-strong bg-paper px-2 font-[inherit] text-[13px] outline-none focus:border-ink"
          >
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <p className="m-0 text-xs leading-relaxed text-muted">
        You are seeing the change across the app now, and in your emails' accent and heading font. It is only kept when you save.
      </p>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-[220px_1fr] md:gap-8">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted">{hint}</div>
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}
