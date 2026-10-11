/**
 * An email is a list of blocks. The same document drives the editor, the preview and the email
 * that is sent, so what you see is what arrives.
 */
import { z } from 'zod';

const id = z.string().min(1).max(40);
const align = z.enum(['left', 'center']).default('left');
const url = z.string().max(2000).refine((u) => /^(https?:|mailto:|tel:|\{\{)/.test(u), 'Links must start with https://, mailto: or tel:');

export const Block = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('heading'), text: z.string().max(300), level: z.union([z.literal(1), z.literal(2)]).default(1), align }),
  /** Text with light formatting: **bold**, *italic*, [link](https://…), and line breaks. */
  z.object({ id, type: z.literal('text'), text: z.string().max(10_000), align }),
  z.object({ id, type: z.literal('button'), label: z.string().max(80), url, align }),
  z.object({ id, type: z.literal('image'), src: z.string().max(2000), alt: z.string().max(300).default(''), url: url.optional(), width: z.number().int().min(80).max(600).default(600) }),
  z.object({ id, type: z.literal('divider') }),
  z.object({ id, type: z.literal('spacer'), size: z.enum(['s', 'm', 'l']).default('m') }),
]);
export type Block = z.output<typeof Block>;
export type BlockType = Block['type'];

export const EmailDoc = z.object({
  version: z.literal(1).default(1),
  /** Shown after the subject in most inboxes. */
  preview: z.string().max(200).default(''),
  blocks: z.array(Block).max(100).default([]),
});
export type EmailDoc = z.output<typeof EmailDoc>;
export type EmailDocInput = z.input<typeof EmailDoc>;

/** How the email looks, from the business's brand. */
export type EmailTheme = {
  accent: string;
  /** Text on the accent (white, or dark for pale accents). */
  onAccent: string;
  businessName: string;
  logoUrl?: string;
  /** Postal address; UK and US law expect it in marketing email. */
  address?: string;
  headingFont: 'cal-sans' | 'geist' | 'serif';
};

let counter = 0;
export const blockId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A sensible new block of each type, for the editor's insert menu. */
export function newBlock(type: BlockType): Block {
  const base = { id: blockId() };
  switch (type) {
    case 'heading':
      return { ...base, type, text: 'A heading', level: 1, align: 'left' };
    case 'text':
      return { ...base, type, text: 'Hi {{first_name|there}},\n\nWrite your message here.', align: 'left' };
    case 'button':
      return { ...base, type, label: 'Book now', url: 'https://', align: 'left' };
    case 'image':
      return { ...base, type, src: '', alt: '', width: 600 };
    case 'divider':
      return { ...base, type };
    case 'spacer':
      return { ...base, type, size: 'm' };
  }
}

/** A first draft for a new campaign, so nobody starts from a blank page. */
export function starterDoc(businessName: string): EmailDoc {
  return {
    version: 1,
    preview: 'A few spaces have opened up this week.',
    blocks: [
      { id: blockId(), type: 'heading', text: 'This week has space for you', level: 1, align: 'left' },
      {
        id: blockId(),
        type: 'text',
        text: `Hi {{first_name|there}},\n\nA few appointments have opened up at ${businessName} this week. If you have been meaning to book, now is a good time.`,
        align: 'left',
      },
      { id: blockId(), type: 'button', label: 'Book a time', url: 'https://', align: 'left' },
      { id: blockId(), type: 'spacer', size: 's' },
      { id: blockId(), type: 'text', text: `See you soon,\n${businessName}`, align: 'left' },
    ],
  };
}
