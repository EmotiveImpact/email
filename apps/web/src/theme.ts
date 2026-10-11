/**
 * The standard look and the three things a business can change: accent, rail and heading font.
 * Everything visual reads CSS variables, so a tenant's brand is one object turned into variables.
 */

export type Brand = {
  accent?: string;
  rail?: 'light' | 'pigment';
  headingFont?: 'cal-sans' | 'geist' | 'serif';
  logoUrl?: string;
  /** Postal address for the footer of marketing email. */
  address?: string;
};

type Shades = { name: string; accent: string; light: string; deep: string; ink: string; tint: string };

/** Hand-tuned presets. Any other colour is derived with `shadesFor`. */
export const ACCENTS: Shades[] = [
  { name: 'Ember', accent: '#D9481F', light: '#F39A74', deep: '#6E220C', ink: '#A8350F', tint: '#FDF1EC' },
  { name: 'Sage', accent: '#4F7F67', light: '#9CC4AE', deep: '#20372B', ink: '#3B654F', tint: '#EEF5F1' },
  { name: 'Indigo', accent: '#4B4FD8', light: '#A5A8F5', deep: '#1D1F63', ink: '#3A3DB5', tint: '#EFEFFD' },
  { name: 'Plum', accent: '#8C3B72', light: '#D79AC4', deep: '#3A1630', ink: '#7A2F62', tint: '#F8EEF5' },
  { name: 'Graphite', accent: '#26272B', light: '#8C8D94', deep: '#111114', ink: '#26272B', tint: '#F1F1F0' },
];

export const FONTS = {
  'cal-sans': { label: 'Cal Sans', display: "'Cal Sans', 'Inter Variable', sans-serif", weight: '400', track: '0.005em' },
  geist: { label: 'Geist', display: "'Geist Variable', sans-serif", weight: '600', track: '-0.025em' },
  serif: { label: 'Serif', display: "'Newsreader Variable', Georgia, serif", weight: '400', track: '-0.01em' },
} as const;

export const DEFAULT_BRAND: Required<Omit<Brand, 'logoUrl' | 'address'>> = { accent: '#D9481F', rail: 'pigment', headingFont: 'cal-sans' };

const HEX = /^#[0-9a-f]{6}$/i;

function toRgb(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}

function toHex(rgb: readonly number[]) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Mixes `hex` towards `target` by `amount` (0 keeps it, 1 becomes the target). */
export function mix(hex: string, target: string, amount: number) {
  const a = toRgb(hex);
  const b = toRgb(target);
  return toHex(a.map((v, i) => v + (b[i]! - v) * amount));
}

/** Relative luminance (WCAG). */
export function luminance(hex: string) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Shades for any accent. Presets return their tuned values; anything else is mixed from the
 * accent, and the text shade is darkened until it reads on white (WCAG AA, 4.5:1).
 */
export function shadesFor(accent: string | undefined): Shades {
  const hex = accent && HEX.test(accent) ? accent.toUpperCase() : DEFAULT_BRAND.accent;
  const preset = ACCENTS.find((a) => a.accent === hex);
  if (preset) return preset;
  let ink = hex;
  for (let step = 0.1; contrast(ink, '#FFFFFF') < 4.5 && step <= 1; step += 0.1) ink = mix(hex, '#000000', step);
  return { name: 'Custom', accent: hex, light: mix(hex, '#FFFFFF', 0.45), deep: mix(hex, '#000000', 0.55), ink, tint: mix(hex, '#FFFFFF', 0.92) };
}

/** The CSS variables for a brand. Set them on any element and everything inside takes the look. */
export function brandVars(brand: Brand = {}): Record<string, string> {
  const shades = shadesFor(brand.accent);
  const font = FONTS[brand.headingFont ?? DEFAULT_BRAND.headingFont] ?? FONTS['cal-sans'];
  const pigment = (brand.rail ?? DEFAULT_BRAND.rail) === 'pigment';
  return {
    '--accent': shades.accent,
    '--accent-light': shades.light,
    '--accent-deep': shades.deep,
    '--accent-ink': shades.ink,
    '--tint': shades.tint,
    // Text on a solid accent button: white unless the accent is too pale for it.
    '--on-accent': contrast(shades.accent, '#FFFFFF') >= 3 ? '#FFFFFF' : '#121214',
    '--display': font.display,
    '--display-weight': font.weight,
    '--display-track': font.track,
    '--rail-bg': pigment
      ? `radial-gradient(ellipse 160px 360px at 115% 0, ${shades.light} 0%, ${shades.accent} 26%, ${shades.deep} 55%, #0C0C0E 85%)`
      : 'transparent',
    '--rail-icon': pigment ? '#E7E4DE' : '#55555C',
    '--rail-active-bg': pigment ? '#FFFFFF26' : '#FFFFFF',
    '--rail-active-ink': pigment ? '#FFFFFF' : '#121214',
    '--rail-active-shadow': pigment ? 'none' : '0 1px 2px #0000001A',
    '--logo-bg': pigment ? '#FFFFFF' : shades.accent,
    '--logo-ink': pigment ? '#121214' : '#FFFFFF',
    '--avatar-bg': pigment ? '#F2EFEA' : '#121214',
    '--avatar-ink': pigment ? '#121214' : '#FFFFFF',
    '--grain': pigment ? '0.28' : '0',
  };
}
