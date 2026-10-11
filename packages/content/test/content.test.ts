import { describe, expect, it } from 'vitest';
import { EmailDoc, fillMergeTags, inboxWarnings, PLAYS, problems, renderEmail, starterDoc, unknownMergeTags, type EmailTheme } from '../src/index.ts';

const theme: EmailTheme = { accent: '#D9481F', onAccent: '#FFFFFF', businessName: 'Linden Studio', address: '4 Linden Row, Bristol BS1 4AA', headingFont: 'cal-sans' };

describe('rendering', () => {
  it('renders blocks, the footer and an unsubscribe placeholder', async () => {
    const doc = EmailDoc.parse({
      preview: 'Three slots left',
      blocks: [
        { id: 'a', type: 'heading', text: 'Thursday has space' },
        { id: 'b', type: 'text', text: 'Hi {{first_name|there}},\n\nWe have **three** slots. [See them](https://linden.example/book)' },
        { id: 'c', type: 'button', label: 'Book now', url: 'https://linden.example/book' },
      ],
    });
    const { html, text } = await renderEmail(doc, theme);
    expect(html).toContain('Thursday has space');
    expect(html).toContain('<strong>three</strong>');
    expect(html).toContain('href="https://linden.example/book"');
    expect(html).toContain('href="{{unsubscribe_url}}"');
    expect(html).toContain('4 Linden Row');
    expect(html).toContain('{{first_name|there}}');
    expect(text).toContain('Thursday has space');
    expect(text).toContain('{{first_name|there}}');
    expect(text).toContain('Book now');
  });

  it('escapes what people type', async () => {
    const doc = EmailDoc.parse({ blocks: [{ id: 'a', type: 'text', text: '<script>alert(1)</script> [x](javascript:alert(1))' }] });
    const { html } = await renderEmail(doc, theme);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript');
  });

  it('refuses unsafe links in buttons', () => {
    expect(EmailDoc.safeParse({ blocks: [{ id: 'a', type: 'button', label: 'x', url: 'javascript:alert(1)' }] }).success).toBe(false);
  });

  it('lists what to fix before sending', () => {
    const doc = starterDoc('Linden Studio');
    expect(problems(doc)).toEqual(['The “Book a time” button needs a link.']);
    expect(problems(starterDoc('Linden Studio', 'https://linden.example/book'))).toEqual([]);
    expect(problems(EmailDoc.parse({ blocks: [] }))).toEqual(['The email is empty.']);
  });
});

describe('merge tags', () => {
  it('fills known tags with fallbacks and escapes values', () => {
    expect(fillMergeTags('Hi {{first_name|there}}!', { first_name: 'Ama' })).toBe('Hi Ama!');
    expect(fillMergeTags('Hi {{ first_name | there }}!', { first_name: '' })).toBe('Hi there!');
    expect(fillMergeTags('Hi {{first_name}}', { first_name: '<b>' })).toBe('Hi &#60;b&#62;');
    expect(fillMergeTags('Hi {{first_name}}', { first_name: '<b>' }, { html: false })).toBe('Hi <b>');
    expect(fillMergeTags('<a href="{{unsubscribe_url}}">', { first_name: 'Ama' })).toBe('<a href="{{unsubscribe_url}}">');
  });

  it('spots typos', () => {
    expect(unknownMergeTags('Hi {{frist_name}} {{first_name}} {{unsubscribe_url}}')).toEqual(['frist_name']);
  });
});

describe('theme', () => {
  it('follows the brand and keeps button text readable', async () => {
    const { themeFromBrand } = await import('../src/index.ts');
    expect(themeFromBrand('Linden', { accent: '#4b4fd8' })).toMatchObject({ accent: '#4B4FD8', onAccent: '#FFFFFF', headingFont: 'cal-sans' });
    expect(themeFromBrand('Linden', { accent: '#FFD400' }).onAccent).toBe('#121214');
    expect(themeFromBrand('Linden', { accent: 'red' }).accent).toBe('#D9481F');
  });

  it('shows free times as links, and keeps link merge tags readable', async () => {
    const doc = EmailDoc.parse({
      blocks: [
        { id: 's', type: 'slots' },
        { id: 'b', type: 'button', label: 'Book', url: '{{booking_url}}' },
      ],
    });
    const { html } = await renderEmail(doc, theme, { slots: [{ label: 'Thu 10:00', url: 'https://linden.example/book?at=2026-10-15T09:00:00Z' }] });
    expect(html).toContain('Thu 10:00');
    expect(html).toContain('href="{{booking_url}}"');
    expect((await renderEmail(doc, theme)).html).not.toContain('Thu 10:00');
  });

  it('offers the booking page instead when no free times are known', async () => {
    const doc = EmailDoc.parse({ blocks: [{ id: 's', type: 'slots' }] });
    const withPage = { ...theme, bookingUrl: 'https://linden.example/book' };
    const { html } = await renderEmail(doc, withPage);
    expect(html).toContain('Choose a time');
    expect(html).toContain('href="https://linden.example/book"');
    expect((await renderEmail(doc, { ...theme, bookingUrl: undefined })).html).not.toContain('Choose a time');
  });
});

describe('inbox checks', () => {
  const doc = (blocks: unknown[], preview = 'A few spaces') => EmailDoc.parse({ preview, blocks });
  it('stays quiet for a plain, well-made email', () => {
    const good = doc([
      { id: 'h', type: 'heading', text: 'This week has space for you' },
      { id: 't', type: 'text', text: 'Hi {{first_name|there}}, a few times have opened up this week. [See them](https://linden.test/book).' },
      { id: 'b', type: 'button', label: 'Book a time', url: '{{booking_url}}' },
    ]);
    expect(inboxWarnings({ subject: 'A few spaces this week, {{first_name|there}}', doc: good })).toEqual([]);
  });

  it('flags shouting, spam phrases, missing alt text, picture-only emails and odd links', () => {
    const bad = doc(
      [
        { id: 'i', type: 'image', src: 'https://cdn.test/a.png', alt: '' },
        { id: 'b', type: 'button', label: 'Click here', url: 'http://bit.ly/abc' },
      ],
      '',
    );
    const found = inboxWarnings({ subject: 'HUGE SALE NOW ON!!', doc: bad });
    expect(found.join('\n')).toMatch(/capitals/);
    expect(found.join('\n')).toMatch(/exclamation/);
    expect(found.join('\n')).toMatch(/preview text/);
    expect(found.join('\n')).toMatch(/click here/);
    expect(found.join('\n')).toMatch(/alt text/);
    expect(found.join('\n')).toMatch(/mostly pictures/);
    expect(found.join('\n')).toMatch(/Shortened links/);
    expect(found.join('\n')).toMatch(/https:\/\//);
  });
});

describe('plays', () => {
  it('are valid emails with known merge tags, a preview and nothing for inboxes to dislike', () => {
    expect(new Set(PLAYS.map((p) => p.id)).size).toBe(PLAYS.length);
    for (const play of PLAYS) {
      const doc = EmailDoc.parse(play.doc());
      expect(unknownMergeTags(`${play.subject} ${JSON.stringify(doc.blocks)}`), play.id).toEqual([]);
      expect(doc.preview, play.id).not.toBe('');
      expect(inboxWarnings({ subject: play.subject, doc }), play.id).toEqual([]);
      expect(doc.blocks.some((b) => b.type === 'slots'), play.id).toBe(play.diary);
      expect(`${play.subject} ${JSON.stringify(doc)}`, play.id).not.toMatch(/—/);
    }
  });
});
