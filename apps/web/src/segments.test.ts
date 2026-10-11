import { describe, expect, it } from 'vitest';
import { blankCondition, describeSegment, isComplete } from './segments.ts';

describe('segment wording', () => {
  it('reads like a sentence', () => {
    expect(
      describeSegment({
        match: 'all',
        conditions: [
          { type: 'consent', is: 'granted' },
          { type: 'event', name: 'booking.created', op: 'at_least', count: 3, withinDays: 180 },
        ],
      }),
    ).toBe('Happy to hear news, and booked at least 3 times in the last 180 days');
    expect(describeSegment({ match: 'any', conditions: [{ type: 'last_event', name: 'booking.created', op: 'more_than_days_ago', days: 42 }] })).toBe(
      'Last booked more than 42 days ago',
    );
    expect(describeSegment({ match: 'all', conditions: [] })).toBe('Everyone');
  });

  it('starts new rules complete where it can', () => {
    const vocab = { events: ['booking.created'], attributes: ['treatment'] };
    expect(isComplete(blankCondition('event', vocab))).toBe(true);
    expect(isComplete(blankCondition('attribute', vocab))).toBe(false);
    expect(isComplete({ type: 'attribute', key: 'treatment', op: 'exists' })).toBe(true);
  });
});
