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
};

export function createAuth({ db, engine, secret, baseURL, webOrigin }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/auth',
    trustedOrigins: [webOrigin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: logins, verification: verifications, organization: accounts, member: members, invitation: invitations },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: { database: { generateId: ({ model }) => newId(PREFIX[model] ?? model.slice(0, 3)) } },
    plugins: [
      organization({
        organizationHooks: {
          // Every account can send for its own businesses straight away, with or without an app of its own.
          afterCreateOrganization: async ({ organization: account }) => {
            await engine.createApp(account.id, 'Direct');
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
