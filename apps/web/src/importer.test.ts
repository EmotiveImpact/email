import { describe, expect, it } from 'vitest';
import { ukDate } from './components/importer.tsx';

describe('reading dates from spreadsheets', () => {
  it('reads UK dates day first, with or without a time', () => {
    expect(ukDate('02/06/2026 10:00')).toBe('2026-06-02T10:00:00');
    expect(ukDate('2/6/2026')).toBe('2026-06-02T12:00:00');
    expect(ukDate('02.06.26 9:30')).toBe('2026-06-02T09:30:00');
    expect(ukDate('30-06-2026, 14:15')).toBe('2026-06-30T14:15:00');
  });

  it('leaves ISO dates for the server', () => {
    expect(ukDate('2026-06-02T10:00:00Z')).toBe('2026-06-02T10:00:00Z');
    expect(ukDate(' 2026-06-02 ')).toBe('2026-06-02');
  });
});
