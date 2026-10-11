/**
 * Inbox checks: things that make an email look like spam or read badly, found before it goes.
 * They are advice, not blockers; the hard rules (subject, address, links) live in `problems`.
 */
import type { EmailDoc } from './blocks.ts';

/** Words spam filters and readers both distrust. Kept short and specific to avoid false alarms. */
const SPAMMY = [
  '100% free',
  'act now',
  'apply now',
  'buy now',
  'cash bonus',
  'click here',
  'congratulations',
  'earn money',
  'guaranteed',
  'limited time only',
  'no obligation',
  'risk-free',
  'risk free',
  'urgent',
  'winner',
  '£££',
  '$$$',
];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly)\//i;

const linksIn = (doc: EmailDoc) =>
  doc.blocks.flatMap((b) => {
    if (b.type === 'button') return [b.url];
    if (b.type === 'image' && b.url) return [b.url];
    if (b.type === 'text') return [...b.text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
    return [];
  });

const wordsIn = (doc: EmailDoc) =>
  doc.blocks
    .map((b) => (b.type === 'heading' || b.type === 'text' ? b.text : b.type === 'button' ? b.label : ''))
    .join(' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-z]/i.test(w)).length;

export function inboxWarnings({ subject, doc }: { subject: string; doc: EmailDoc }): string[] {
  const out: string[] = [];
  const plainSubject = subject.replace(/\{\{[^}]*\}\}/g, '').trim();
  const letters = plainSubject.replace(/[^a-z]/gi, '');
  if (letters.length >= 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) {
    out.push('The subject is mostly capitals, which reads as shouting and is a common spam sign.');
  }
  if ((subject.match(/!/g) ?? []).length > 1) out.push('Use one exclamation mark at most in the subject.');
  if (plainSubject.length > 60) out.push('Phones cut subjects off at about 40 to 60 characters; put the important words first.');
  if (!doc.preview.trim()) out.push('Add preview text. Without it, inboxes show whatever words come first.');

  const words = `${subject} ${doc.blocks.map((b) => (b.type === 'heading' || b.type === 'text' ? b.text : b.type === 'button' ? b.label : '')).join(' ')}`.toLowerCase();
  const spammy = SPAMMY.find((p) => words.includes(p));
  if (spammy) out.push(`“${spammy}” is a phrase spam filters watch for. Plainer words land better.`);

  const images = doc.blocks.filter((b) => b.type === 'image');
  if (images.some((b) => b.type === 'image' && !b.alt.trim())) {
    out.push('Describe every picture (alt text). Screen readers read it, and many inboxes show it while pictures are hidden.');
  }
  if (images.length && wordsIn(doc) < 25) out.push('This is mostly pictures. Add a few lines of text, or inboxes that hide pictures show an empty email.');

  const links = linksIn(doc);
  if (links.some((u) => SHORTENERS.test(u))) out.push('Use full web addresses. Shortened links are a common spam sign.');
  if (links.some((u) => u.startsWith('http://'))) out.push('Use https:// links. Some inboxes warn about plain http.');
  if (links.length > 15) out.push(`There are ${links.length} links. Fewer, clearer links do better and look less like spam.`);
  return out;
}
