import { describe, expect, it } from 'vitest';
import { EmailDoc, fillMergeTags, problems, renderEmail, starterDoc, unknownMergeTags, type EmailTheme } from '../src/index.ts';

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
});
