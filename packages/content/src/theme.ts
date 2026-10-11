import type { EmailTheme } from './blocks.ts';

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The email look from a business's brand: its accent, heading font, logo and address. */
export function themeFromBrand(
  businessName: string,
  brand: { accent?: string; headingFont?: EmailTheme['headingFont']; logoUrl?: string; address?: string; bookingUrl?: string } = {},
): EmailTheme {
  const accent = brand.accent && HEX.test(brand.accent) ? brand.accent.toUpperCase() : '#5B49D6';
  // White text on the accent when it reads at 3:1 or better (WCAG for large text), else near-black.
  const onAccent = 1.05 / (luminance(accent) + 0.05) >= 3 ? '#FFFFFF' : '#121214';
  return {
    accent,
    onAccent,
    businessName,
    logoUrl: brand.logoUrl,
    address: brand.address,
    bookingUrl: brand.bookingUrl,
    headingFont: brand.headingFont ?? 'cal-sans',
  };
}

/** Mixes `hex` towards `target` by `amount` (0 keeps it, 1 becomes the target). */
export function mixHex(hex: string, target: string, amount: number) {
  const parse = (h: string) => {
    const n = Number.parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [a, b] = [parse(hex), parse(target)];
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * amount).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** The accent with a dark shade and a pale tint, for designs and generated pictures. */
export function brandShades(businessName: string, accent?: string) {
  const theme = themeFromBrand(businessName, { accent });
  return { businessName, accent: theme.accent, onAccent: theme.onAccent, deep: mixHex(theme.accent, '#000000', 0.6), tint: mixHex(theme.accent, '#FFFFFF', 0.88) };
}
