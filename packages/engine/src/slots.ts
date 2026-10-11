/** Free times as booking links, in the business's time zone. */
import type { SlotLink } from '@platform/content';

const DAY = 86_400_000;

const fmt = (tz: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options });
export const localHour = (tz: string, at: Date) => Number(fmt(tz, { hour: 'numeric', hourCycle: 'h23' }).format(at));
export const isoDay = (at: Date) => at.toISOString().slice(0, 10);
/** Noon UTC on a YYYY-MM-DD day: safe to compare with dates and to name the weekday. */
export const noon = (day: string) => new Date(`${day}T12:00:00Z`);
export const weekday = (day: string) => fmt('UTC', { weekday: 'long' }).format(noon(day));
/** "9am", "10:30am": how people in the UK write times. */
const time = (tz: string, at: Date) =>
  fmt(tz, { hour: 'numeric', minute: '2-digit', hour12: true }).format(at).replace(/\s/g, '').replace(':00', '').toLowerCase();
const dayKey = (tz: string, at: Date) => fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const shortDay = (tz: string, at: Date) => fmt(tz, { weekday: 'short' }).format(at);

/** A link that opens the booking page at one time. Booking pages that ignore `at` still open. */
export function slotUrl(bookingUrl: string | undefined, at: Date) {
  if (!bookingUrl) return '#';
  try {
    const url = new URL(bookingUrl);
    url.searchParams.set('at', at.toISOString());
    return url.toString();
  } catch {
    return bookingUrl;
  }
}

/**
 * Free times as buttons, earliest first, one per start time. Across several days it takes at most
 * two a day first, so clients see a choice of days rather than one day's whole morning.
 */
export function slotLinks(rows: { startsAt: Date }[], tz: string, bookingUrl: string | undefined, options: { withDay: boolean }, limit = 6): SlotLink[] {
  const times = [...new Set(rows.map((r) => r.startsAt.getTime()))].sort((a, b) => a - b).map((t) => new Date(t));
  const chosen = new Set<number>();
  if (options.withDay) {
    const perDay = new Map<string, number>();
    for (const at of times) {
      if (chosen.size === limit) break;
      const key = dayKey(tz, at);
      if ((perDay.get(key) ?? 0) >= 2) continue;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
      chosen.add(at.getTime());
    }
  }
  for (const at of times) {
    if (chosen.size === limit) break;
    chosen.add(at.getTime());
  }
  return times
    .filter((at) => chosen.has(at.getTime()))
    .map((at) => ({ label: options.withDay ? `${shortDay(tz, at)} ${time(tz, at)}` : time(tz, at), url: slotUrl(bookingUrl, at) }));
}

/** Made-up free times for previews when the diary has none. */
export function sampleSlots(tz: string, bookingUrl: string | undefined, now: Date, withDay: boolean): SlotLink[] {
  const base = new Date(now.getTime() + 2 * DAY);
  base.setUTCHours(10, 0, 0, 0);
  return slotLinks(
    [0, 90, 210, 330].map((m) => ({ startsAt: new Date(base.getTime() + m * 60_000) })),
    tz,
    bookingUrl,
    { withDay },
  );
}
