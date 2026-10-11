import type { ComponentProps, ReactNode } from 'react';
import type { MessageStatus } from '../api.ts';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cx('rounded-2xl border border-rule bg-paper', className)} {...props} />;
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="display m-0 text-[17px]">{children}</h2>
      {aside && <span className="text-[13px] text-muted">{aside}</span>}
    </div>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="display m-0 text-[34px] leading-[1.05]">{title}</h1>
        {subtitle && <div className="text-sm text-muted">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

export function Button({ variant = 'primary', className, ...props }: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'accent' }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium whitespace-nowrap transition disabled:cursor-default disabled:opacity-50',
        variant === 'primary' && 'bg-ink text-white hover:bg-black',
        variant === 'accent' && 'bg-accent text-on-accent hover:opacity-90',
        variant === 'secondary' && 'border border-rule-strong bg-paper text-ink hover:bg-soft',
        className,
      )}
      {...props}
    />
  );
}

/** A row of pill buttons where one is chosen. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-soft p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              'cursor-pointer rounded-full border-0 font-[inherit] transition',
              size === 'sm' ? 'h-[26px] px-2.5 text-xs' : 'h-8 px-3.5 text-[13px]',
              on ? 'bg-paper font-semibold text-ink shadow-[0_1px_2px_#0000001A]' : 'bg-transparent text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const STATUS: Record<MessageStatus, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'neutral' },
  delivered: { label: 'Delivered', tone: 'good' },
  delivery_delayed: { label: 'Delayed', tone: 'warn' },
  bounced: { label: 'Bounced', tone: 'bad' },
  complained: { label: 'Marked as spam', tone: 'bad' },
  rejected: { label: 'Rejected', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  suppressed: { label: 'Not sent', tone: 'warn' },
};

export function StatusBadge({ status }: { status: MessageStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-medium whitespace-nowrap',
        tone === 'good' && 'bg-good-bg text-good',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'bad' && 'bg-bad-bg text-bad',
        tone === 'neutral' && 'bg-soft text-muted',
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Plain-English reasons for an email that was held back or failed. */
export function reasonText(reason: string | null) {
  if (!reason) return null;
  const known: Record<string, string> = {
    unsubscribe: 'They unsubscribed from news',
    complaint: 'They marked an earlier email as spam',
    hard_bounce: 'The address does not exist',
    no_marketing_consent: 'No recorded consent for news',
    manual: 'Blocked by the business',
  };
  return known[reason] ?? reason;
}

export function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'bad'; children: ReactNode }) {
  return (
    <div className={cx('rounded-xl px-4 py-3 text-[13px] leading-relaxed', tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-tint text-ink')}>
      {children}
    </div>
  );
}
