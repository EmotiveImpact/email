import type { Condition, SegmentDefinition } from './api.ts';

/** Friendly names for app events. Unknown ones are shown as sent ("booking.created" → "booking created"). */
export function eventLabel(name: string) {
  const known: Record<string, string> = { 'booking.created': 'booked', 'booking.cancelled': 'cancelled', 'booking.no_show': 'missed a booking' };
  return known[name] ?? name.replace(/[._]/g, ' ');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One rule in plain English, e.g. "booked at least 3 times in the last 180 days". */
export function describeCondition(c: Condition): string {
  switch (c.type) {
    case 'consent':
      return c.is === 'granted' ? 'happy to hear news' : c.is === 'withdrawn' ? 'said no to news' : 'never asked about news';
    case 'attribute': {
      const v = c.value ?? '';
      const ops = { equals: `is ${v}`, not_equals: `is not ${v}`, contains: `contains “${v}”`, exists: 'is filled in', not_exists: 'is empty', more_than: `is more than ${v}`, less_than: `is less than ${v}` };
      return `${c.key} ${ops[c.op]}`;
    }
    case 'event': {
      const within = c.withinDays ? ` in the last ${plural(c.withinDays, 'day')}` : '';
      return c.op === 'none' ? `never ${eventLabel(c.name)}${within}` : `${eventLabel(c.name)} at least ${c.count === 1 || !c.count ? 'once' : `${c.count} times`}${within}`;
    }
    case 'last_event':
      return c.op === 'more_than_days_ago'
        ? `last ${eventLabel(c.name)} more than ${plural(c.days, 'day')} ago`
        : `${eventLabel(c.name)} in the last ${plural(c.days, 'day')}`;
    case 'added':
      return c.op === 'within_days' ? `added in the last ${plural(c.days, 'day')}` : `added more than ${plural(c.days, 'day')} ago`;
    case 'email':
      return c.op === 'contains' ? `email contains “${c.value}”` : `email ends with “${c.value}”`;
  }
}

export function describeSegment(d: SegmentDefinition) {
  if (d.conditions.length === 0) return 'Everyone';
  const parts = d.conditions.map(describeCondition);
  const text = parts.join(d.match === 'all' ? ', and ' : ', or ');
  return text[0]!.toUpperCase() + text.slice(1);
}

/** A sensible new rule of each kind, so switching the kind never leaves a half-filled rule. */
export function blankCondition(type: Condition['type'], vocab: { events: string[]; attributes: string[] }): Condition {
  const event = vocab.events.includes('booking.created') || vocab.events.length === 0 ? 'booking.created' : vocab.events[0]!;
  switch (type) {
    case 'consent':
      return { type, is: 'granted' };
    case 'attribute':
      return { type, key: vocab.attributes[0] ?? 'treatment', op: 'equals', value: '' };
    case 'event':
      return { type, name: event, op: 'at_least', count: 2, withinDays: 90 };
    case 'last_event':
      return { type, name: event, op: 'more_than_days_ago', days: 42 };
    case 'added':
      return { type, op: 'within_days', days: 30 };
    case 'email':
      return { type, op: 'ends_with', value: '' };
  }
}

/** True when a rule has everything it needs to run. */
export function isComplete(c: Condition) {
  if (c.type === 'attribute') return Boolean(c.key) && (c.op === 'exists' || c.op === 'not_exists' || `${c.value ?? ''}`.trim() !== '');
  if (c.type === 'email') return c.value.trim() !== '';
  if (c.type === 'event' || c.type === 'last_event') return Boolean(c.name);
  return true;
}
