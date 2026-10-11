/**
 * Merge tags: `{{first_name}}` or `{{first_name|there}}` (with a fallback). They are filled in per
 * recipient after rendering, so a campaign is rendered once, not once per person.
 */

export const MERGE_TAGS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'business_name', label: 'Business name' },
  { key: 'booking_url', label: 'Booking link' },
  { key: 'last_service', label: 'Their last treatment' },
  { key: 'weeks_since_visit', label: 'Weeks since their visit' },
  { key: 'slot_day', label: 'The day with space (fill-slots emails)' },
] as const;

const TAG = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Replaces merge tags. Unknown tags are left as they are, so a later step (the unsubscribe link,
 * added at send time) can fill them. Values are escaped for HTML unless `html` is false.
 */
export function fillMergeTags(template: string, values: Record<string, string | null | undefined>, options: { html?: boolean } = {}) {
  const escape = options.html === false ? (s: string) => s : escapeHtml;
  return template.replace(TAG, (whole, key: string, fallback: string | undefined) => {
    if (!(key in values)) return whole;
    const value = values[key]?.trim();
    return escape(value || fallback?.trim() || '');
  });
}

/** Tags used in a template that we do not know how to fill (likely typos). */
export function unknownMergeTags(template: string, known: readonly string[] = [...MERGE_TAGS.map((t) => t.key), 'unsubscribe_url']) {
  return [...template.matchAll(TAG)].map((m) => m[1]!).filter((key) => !known.includes(key));
}
