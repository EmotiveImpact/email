/**
 * Plays: ready-made campaigns for appointment businesses, written to be sent nearly as they are.
 * The ones marked `diary` fill themselves with free times from the booking system. The automatic
 * plays (due back, quiet days, we miss you, reviews, birthdays) are flows, not campaigns.
 */
import type { EmailDoc } from './blocks.ts';

export type PlayFor = 'salon' | 'studio' | 'any';

export type Play = {
  id: string;
  name: string;
  /** What it is for, in a line. */
  goal: string;
  for: PlayFor;
  /** Shows the business's free times, so it works best with a connected diary. */
  diary: boolean;
  subject: string;
  doc: () => EmailDoc;
};

const text = (id: string, value: string) => ({ id, type: 'text' as const, text: value, align: 'left' as const });
const heading = (id: string, value: string) => ({ id, type: 'heading' as const, text: value, level: 1 as const, align: 'left' as const });
const button = (id: string, label: string, url = '{{booking_url}}') => ({ id, type: 'button' as const, label, url, align: 'left' as const });
const slots = (id: string) => ({ id, type: 'slots' as const, align: 'left' as const });
const signOff = (id: string, line = 'See you soon,') => text(id, `${line}\n{{business_name}}`);

export const PLAYS: Play[] = [
  {
    id: 'spaces-this-week',
    name: 'Spaces this week',
    goal: 'Fill this week’s gaps with the times that are actually free.',
    for: 'any',
    diary: true,
    subject: 'A few spaces this week, {{first_name|there}}',
    doc: () => ({
      version: 1,
      preview: 'Tap a time to book it.',
      blocks: [
        heading('h', 'This week has space for you'),
        text('t', 'Hi {{first_name|there}},\n\nA few times have opened up this week. If you have been meaning to book, now is a good moment.'),
        slots('s'),
        signOff('e'),
      ],
    }),
  },
  {
    id: 'new-treatment',
    name: 'Introduce something new',
    goal: 'Tell clients about a new treatment or service, with times to try it.',
    for: 'salon',
    diary: true,
    subject: 'Something new at {{business_name}}',
    doc: () => ({
      version: 1,
      preview: 'We think you will like this one.',
      blocks: [
        heading('h', 'Say hello to something new'),
        text(
          't',
          'Hi {{first_name|there}},\n\nWe have added **[name of the treatment]** to the menu. It takes about [time] and costs [price]. It suits anyone who [who it is for].\n\nBe one of the first to try it:',
        ),
        slots('s'),
        signOff('e'),
      ],
    }),
  },
  {
    id: 'gift-vouchers',
    name: 'Gift vouchers',
    goal: 'Remind clients that a visit makes a good present, ahead of the busy season.',
    for: 'any',
    diary: false,
    subject: 'A present they will actually use',
    doc: () => ({
      version: 1,
      preview: 'Gift vouchers, sent the same day.',
      blocks: [
        heading('h', 'Stuck for a present?'),
        text('t', 'Hi {{first_name|there}},\n\nA gift voucher from {{business_name}} is easy to give and lovely to receive. Choose an amount or a treatment, and we send it the same day.'),
        button('b', 'Buy a gift voucher'),
        signOff('e', 'Thank you,'),
      ],
    }),
  },
  {
    id: 'bring-a-friend',
    name: 'Bring a friend',
    goal: 'Ask happy clients to recommend you, with something for both of them.',
    for: 'salon',
    diary: false,
    subject: 'Bring a friend, {{first_name|there}}',
    doc: () => ({
      version: 1,
      preview: 'Something for both of you.',
      blocks: [
        heading('h', 'Know someone who would love it here?'),
        text(
          't',
          'Hi {{first_name|there}},\n\nMost of our new clients come from people like you. Send a friend our way and you both get [the thank-you, such as £10 off] on your next visit. They just mention your name when they book.',
        ),
        button('b', 'Share our booking page'),
        signOff('e', 'Thank you for spreading the word,'),
      ],
    }),
  },
  {
    id: 'price-update',
    name: 'Price changes, told kindly',
    goal: 'Give clients plenty of notice of new prices, and a chance to book before.',
    for: 'any',
    diary: true,
    subject: 'A note about our prices from [date]',
    doc: () => ({
      version: 1,
      preview: 'Plenty of notice, and time to book before.',
      blocks: [
        heading('h', 'A note about our prices'),
        text(
          't',
          'Hi {{first_name|there}},\n\nFrom [date], some of our prices are changing. [One or two lines on why, such as products and wages going up.] You can see the new prices on our booking page.\n\nAnything booked before [date] stays at today’s price, even if the visit is later.',
        ),
        slots('s'),
        signOff('e', 'Thank you for being with us,'),
      ],
    }),
  },
  {
    id: 'holiday-hours',
    name: 'Holiday opening times',
    goal: 'Tell clients when you are closed, so they book before you go.',
    for: 'any',
    diary: true,
    subject: 'Our opening times over [the holiday]',
    doc: () => ({
      version: 1,
      preview: 'Book before we close.',
      blocks: [
        heading('h', 'Our times over [the holiday]'),
        text('t', 'Hi {{first_name|there}},\n\nWe are closed from [date] and back on [date]. If you would like to come in before then, these times are free:'),
        slots('s'),
        signOff('e', 'Have a lovely break,'),
      ],
    }),
  },
  {
    id: 'mini-sessions',
    name: 'Mini-session day',
    goal: 'Fill a day of short sessions, with the times shown so people pick one.',
    for: 'studio',
    diary: true,
    subject: 'Mini sessions on [date]',
    doc: () => ({
      version: 1,
      preview: 'Short sessions, a few times only.',
      blocks: [
        heading('h', 'Mini sessions on [date]'),
        text(
          't',
          'Hi {{first_name|there}},\n\nWe are running short sessions on [date]: [length] in the studio for [price], with [what they get, such as five edited images]. There are only a few, so pick a time while it is free.',
        ),
        slots('s'),
        signOff('e'),
      ],
    }),
  },
  {
    id: 'bookings-open',
    name: 'Bookings are open',
    goal: 'Open the diary for the next season and let past clients in first.',
    for: 'studio',
    diary: false,
    subject: 'Bookings are open for [season]',
    doc: () => ({
      version: 1,
      preview: 'You hear first, before we tell everyone.',
      blocks: [
        heading('h', 'Bookings for [season] are open'),
        text('t', 'Hi {{first_name|there}},\n\nBefore we tell everyone, we wanted past clients to have first choice of dates for [season]. [One line on what is new this year.]'),
        button('b', 'Choose your date'),
        signOff('e', 'Speak soon,'),
      ],
    }),
  },
  {
    id: 'recent-work',
    name: 'Recent work',
    goal: 'Show a few pieces you are proud of and invite the next booking.',
    for: 'studio',
    diary: false,
    subject: 'A few things we made lately',
    doc: () => ({
      version: 1,
      preview: 'And a date for yours.',
      blocks: [
        heading('h', 'A few things we made lately'),
        text('t', 'Hi {{first_name|there}},\n\n[Two or three lines about recent projects. Add a picture or two with the picture block, each with a short description.]'),
        button('b', 'Book your session'),
        signOff('e', 'Thank you for following along,'),
      ],
    }),
  },
];

export const playById = (id: string) => PLAYS.find((p) => p.id === id) ?? null;
