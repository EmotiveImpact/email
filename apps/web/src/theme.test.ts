import { describe, expect, it } from 'vitest';
import { ACCENTS, brandVars, contrast, shadesFor } from './theme.ts';

describe('brand', () => {
  it('uses the standard look when nothing is set', () => {
    const vars = brandVars();
    expect(vars['--accent']).toBe('#5B49D6');
    expect(vars['--display']).toContain('Cal Sans');
    expect(vars['--rail-bg']).toMatch(/^linear-gradient\(180deg, #[0-9A-F]{6} 0%, #2D2470 42%, #[0-9A-F]{6} 100%\)$/);
  });

  it('keeps the tuned shades for presets', () => {
    expect(shadesFor('#4f7f67')).toEqual(ACCENTS.find((a) => a.name === 'Sage'));
  });

  it('derives readable shades for any other colour', () => {
    for (const accent of ['#FFD400', '#00C2A8', '#E91E63', '#7FDBFF']) {
      const shades = shadesFor(accent);
      expect(contrast(shades.ink, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
      expect(shades.tint).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('puts dark text on pale accents', () => {
    expect(brandVars({ accent: '#FFD400' })['--on-accent']).toBe('#121214');
    expect(brandVars({ accent: '#4B4FD8' })['--on-accent']).toBe('#FFFFFF');
  });

  it('ignores a malformed accent', () => {
    expect(brandVars({ accent: 'red' })['--accent']).toBe('#5B49D6');
  });

  it('keeps the icons at the pale foot of the rail readable', () => {
    for (const accent of ACCENTS.map((a) => a.accent)) {
      const vars = brandVars({ accent });
      const foot = vars['--rail-bg']!.match(/(#[0-9A-F]{6}) 100%/)![1]!;
      expect(contrast(vars['--rail-foot-icon']!, foot)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('switches the rail and the heading font', () => {
    const vars = brandVars({ rail: 'light', headingFont: 'serif' });
    expect(vars['--rail-bg']).toBe('transparent');
    expect(vars['--display']).toContain('Newsreader');
  });
});
