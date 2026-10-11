import { describe, expect, it } from 'vitest';
import { ACCENTS, brandVars, contrast, shadesFor } from './theme.ts';

describe('brand', () => {
  it('uses the standard look when nothing is set', () => {
    const vars = brandVars();
    expect(vars['--accent']).toBe('#D9481F');
    expect(vars['--display']).toContain('Cal Sans');
    expect(vars['--rail-bg']).toContain('radial-gradient');
  });

  it('keeps the tuned shades for presets', () => {
    expect(shadesFor('#4f7f67')).toEqual(ACCENTS[1]);
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
    expect(brandVars({ accent: 'red' })['--accent']).toBe('#D9481F');
  });

  it('switches the rail and the heading font', () => {
    const vars = brandVars({ rail: 'light', headingFont: 'serif' });
    expect(vars['--rail-bg']).toBe('transparent');
    expect(vars['--display']).toContain('Newsreader');
  });
});
