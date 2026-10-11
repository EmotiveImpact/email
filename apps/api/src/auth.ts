/**
 * Sign-in for the web app (Better Auth). People sign in with email and password; each belongs to
 * one or more accounts (Better Auth's "organisations", stored in our `accounts` table).
 */
import { accounts, invitations, logins, members, newId, sessions, users, verifications, type Db } from '@platform/db';
import type { Engine } from '@platform/engine';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';

const PREFIX: Record<string, string> = {
  user: 'usr',
  session: 'ses',
  account: 'lgn',
  verification: 'ver',
  organization: 'acc',
  member: 'mem',
  invitation: 'inv',
};

export type AuthOptions = {
  db: Db;
  engine: Engine;
  /** Signs cookies and tokens. Required in production. */
  secret: string;
  /** Where the API is reachable, e.g. https://app.example.com (the web app proxies /auth to it). */
  baseURL: string;
  webOrigin: string;
  /** Sends the platform's own emails (password resets). Without it, reset links are only logged. */
  mail?: (email: { to: string; subject: string; html: string; text: string }) => Promise<void>;
};

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The password reset email: plain, short, one button. */
export function resetEmail(name: string, url: string) {
  const hello = name ? `Hi ${name.split(' ')[0]},` : 'Hello,';
  const text = `${hello}\n\nSomeone asked to reset the password for your login. If it was you, choose a new one here (the link works for an hour):\n\n${url}\n\nIf it was not you, ignore this email and nothing changes.`;
  const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.5;color:#121214;max-width:480px">
<p>${escape(hello)}</p>
<p>Someone asked to reset the password for your login. If it was you, choose a new one (the link works for an hour).</p>
<p><a href="${escape(url)}" style="display:inline-block;background:#121214;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px">Choose a new password</a></p>
<p style="color:#6b6b72">If it was not you, ignore this email and nothing changes.</p></div>`;
  return { subject: 'Reset your password', html, text };
}

export function createAuth({ db, engine, secret, baseURL, webOrigin, mail }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/auth',
    trustedOrigins: [webOrigin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: logins, verification: verifications, organization: accounts, member: members, invitation: invitations },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      resetPasswordTokenExpiresIn: 60 * 60,
      // Signs out every other device once the password changes.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const email = resetEmail(user.name, url);
        if (mail) await mail({ to: user.email, ...email });
        else console.info(`Password reset for ${user.email}: ${url}`);
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: { database: { generateId: ({ model }) => newId(PREFIX[model] ?? model.slice(0, 3)) } },
    plugins: [
      organization({
        organizationHooks: {
          // Every account can send for its own businesses straight away, with or without an app of its own.
          afterCreateOrganization: async ({ organization: account }) => {
            await engine.createApp(account.id, 'Direct', { direct: true });
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
