import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import type { CSSProperties, ReactNode } from 'react';
import type { Block, EmailDoc, EmailTheme } from './blocks.ts';

const BODY_FONT = "'Inter', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
// Email clients rarely load web fonts; these fall back to good system faces.
const HEADING_FONT: Record<EmailTheme['headingFont'], string> = {
  'cal-sans': "'Cal Sans', 'Inter', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  geist: "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  serif: "'Newsreader', Georgia, 'Times New Roman', serif",
};

const INK = '#121214';
const MUTED = '#6B6B72';

/** **bold**, *italic*, [text](url) and line breaks, as React nodes (so everything else is escaped). */
export function inline(text: string, linkColour: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(((?:https?:|mailto:|tel:|\{\{)[^)\s]*)\)|\n/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={key++}>{m[2]}</em>);
    else if (m[3]) out.push(<Link key={key++} href={m[4]} style={{ color: linkColour, textDecoration: 'underline' }}>{m[3]}</Link>);
    else out.push(<br key={key++} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BlockView({ block, theme }: { block: Block; theme: EmailTheme }) {
  switch (block.type) {
    case 'heading':
      return (
        <Heading
          as={block.level === 1 ? 'h1' : 'h2'}
          style={{
            margin: '0 0 14px',
            color: INK,
            fontFamily: HEADING_FONT[theme.headingFont],
            fontWeight: theme.headingFont === 'geist' ? 600 : 400,
            fontSize: block.level === 1 ? '30px' : '22px',
            lineHeight: 1.15,
            textAlign: block.align,
          }}
        >
          {block.text}
        </Heading>
      );
    case 'text': {
      // Blank lines start new paragraphs.
      const paragraphs = block.text.split(/\n{2,}/);
      return (
        <>
          {paragraphs.map((p, i) => (
            <Text key={i} style={{ margin: '0 0 14px', color: INK, fontSize: '16px', lineHeight: 1.6, textAlign: block.align }}>
              {inline(p, theme.accent)}
            </Text>
          ))}
        </>
      );
    }
    case 'button':
      return (
        <Section style={{ margin: '6px 0 18px', textAlign: block.align }}>
          <Button
            href={block.url}
            style={{ display: 'inline-block', padding: '13px 24px', borderRadius: '999px', background: theme.accent, color: theme.onAccent, fontSize: '15px', fontWeight: 600, textDecoration: 'none' }}
          >
            {block.label}
          </Button>
        </Section>
      );
    case 'image': {
      if (!block.src) return null;
      const img = <Img src={block.src} alt={block.alt} width={Math.min(block.width, 528)} style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: '12px', margin: '0 auto' }} />;
      return <Section style={{ margin: '6px 0 18px' }}>{block.url ? <Link href={block.url}>{img}</Link> : img}</Section>;
    }
    case 'divider':
      return <Hr style={{ border: 'none', borderTop: '1px solid #ECEBE8', margin: '22px 0' }} />;
    case 'spacer':
      return <div style={{ height: { s: 12, m: 24, l: 44 }[block.size] }} />;
  }
}

export function EmailView({ doc, theme }: { doc: EmailDoc; theme: EmailTheme }) {
  const footer: CSSProperties = { margin: '0 0 6px', color: MUTED, fontSize: '12px', lineHeight: 1.6, textAlign: 'center' };
  return (
    <Html lang="en-GB">
      <Head>
        <meta name="color-scheme" content="light only" />
      </Head>
      {doc.preview && <Preview>{doc.preview}</Preview>}
      <Body style={{ margin: 0, padding: '24px 12px', background: '#F2F1EE', fontFamily: BODY_FONT }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto' }}>
          <Section style={{ padding: '0 8px 16px' }}>
            {theme.logoUrl ? (
              <Img src={theme.logoUrl} alt={theme.businessName} height={36} style={{ height: '36px', width: 'auto' }} />
            ) : (
              <Text style={{ margin: 0, color: INK, fontSize: '17px', fontFamily: HEADING_FONT[theme.headingFont] }}>{theme.businessName}</Text>
            )}
          </Section>
          <Section style={{ background: '#FFFFFF', borderRadius: '16px', border: '1px solid #ECEBE8', padding: '32px 36px 18px' }}>
            {doc.blocks.map((block) => (
              <BlockView key={block.id} block={block} theme={theme} />
            ))}
          </Section>
          <Section style={{ padding: '20px 16px 0' }}>
            <Text style={footer}>
              You are getting this because you said yes to news from {theme.businessName}.{' '}
              <Link href="{{unsubscribe_url}}" style={{ color: MUTED, textDecoration: 'underline' }}>
                Unsubscribe
              </Link>
            </Text>
            {theme.address && <Text style={footer}>{theme.address}</Text>}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * HTML and plain text for an email. Merge tags such as {{first_name}} and {{unsubscribe_url}}
 * stay in the output; they are filled per recipient (see merge.ts and the engine's send step).
 */
export async function renderEmail(doc: EmailDoc, theme: EmailTheme) {
  const element = <EmailView doc={doc} theme={theme} />;
  const [html, text] = await Promise.all([render(element), render(element, {
      plainText: true,
      // Keep headings as written: upper-casing would also break merge tags like {{first_name}}.
      htmlToTextOptions: { selectors: [1, 2, 3].map((n) => ({ selector: `h${n}`, options: { uppercase: false } })) },
    })]);
  // Some link components URL-encode hrefs; keep the placeholder readable for the send step.
  return { html: html.replaceAll('%7B%7Bunsubscribe_url%7D%7D', '{{unsubscribe_url}}'), text };
}

/** Things to fix before sending. Empty means ready. */
export function problems(doc: EmailDoc) {
  const found: string[] = [];
  if (doc.blocks.length === 0) found.push('The email is empty.');
  for (const b of doc.blocks) {
    if (b.type === 'button' && !/^(https?:\/\/[^/\s]+\.[^\s]+|mailto:.+|tel:.+|\{\{.+\}\})$/.test(b.url)) found.push(`The “${b.label}” button needs a link.`);
    if (b.type === 'image' && !b.src) found.push('An image has no picture yet.');
    if (b.type === 'image' && b.src && !b.alt) found.push('Add a short description to each image, for people who cannot see it.');
  }
  return found;
}
