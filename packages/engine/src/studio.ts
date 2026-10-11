/**
 * The embedded studio: a host app (Saleane, Caleane, a partner) opens our campaign screens inside
 * its own interface for one of its businesses.
 *
 * 1. The host's server asks for a launch token (`createStudioSession`), naming the business, the
 *    person and the page origin that will show the studio.
 * 2. The host puts our studio URL in an iframe with the launch token in the URL fragment.
 * 3. The studio swaps it, once, for a session token kept in the tab (`exchangeStudioToken`). No
 *    cookies are involved, so browsers that block third-party cookies still work.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, apps, eq, gt, isNull, newId, studioSessions, tenants, type Db, type StudioTheme } from '@platform/db';
import { z } from 'zod';
import { PlatformError } from './types.ts';

const LAUNCH_SECONDS = 5 * 60;
const SESSION_HOURS = 8;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

const origin = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const url = new URL(v);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error();
      return url.origin;
    } catch {
      ctx.addIssue({ code: 'custom', message: `"${v}" is not an https origin, such as https://app.example.com.` });
      return z.NEVER;
    }
  });

export const StudioOrigins = z.object({ origins: z.array(origin).max(20) });

export const StudioSessionInput = z.object({
  tenant: z.string().min(1),
  /** The page origin that will show the studio. It must be one of the app's embed origins. */
  origin,
  user: z.object({
    id: z.string().min(1).max(256),
    name: z.string().max(256).optional(),
    email: z.email().optional(),
  }),
  theme: z
    .object({
      accent: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
      headingFont: z.enum(['cal-sans', 'geist', 'serif']).optional(),
      canvas: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
    })
    .default({}),
});
export type StudioSessionInput = z.input<typeof StudioSessionInput>;

export type StudioViewer = {
  sessionId: string;
  appId: string;
  accountId: string;
  tenantId: string;
  user: { id: string; name: string; email: string | null };
  origin: string;
  theme: StudioTheme;
  expiresAt: Date;
};

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new PlatformError('invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`, 422);
  }
  return result.data;
}

export function createStudio(db: Db) {
  async function setEmbedOrigins(appId: string, raw: unknown) {
    const { origins } = parse(StudioOrigins, raw);
    const [row] = await db.update(apps).set({ embedOrigins: [...new Set(origins)] }).where(eq(apps.id, appId)).returning();
    return row!.embedOrigins;
  }

  /** Called by the host app's server with its API key. Returns a launch token for the iframe. */
  async function createStudioSession(app: { id: string; embedOrigins: string[] }, raw: unknown) {
    const input = parse(StudioSessionInput, raw);
    if (!app.embedOrigins.includes(input.origin)) {
      throw new PlatformError(
        'origin_not_allowed',
        `${input.origin} may not show the studio. Add it with PUT /v1/studio/origins first.`,
        403,
      );
    }
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.appId, app.id), eq(tenants.externalId, input.tenant)));
    if (!tenant) throw new PlatformError('tenant_not_found', `No tenant "${input.tenant}".`, 404);
    const launchToken = token('stl');
    const launchExpiresAt = new Date(Date.now() + LAUNCH_SECONDS * 1000);
    await db.insert(studioSessions).values({
      id: newId('sts'),
      appId: app.id,
      tenantId: tenant.id,
      userRef: input.user.id,
      userName: input.user.name ?? null,
      userEmail: input.user.email?.toLowerCase() ?? null,
      origin: input.origin,
      theme: input.theme,
      launchHash: sha256(launchToken),
      launchExpiresAt,
    });
    return { launchToken, expiresAt: launchExpiresAt };
  }

  /** Swaps a launch token for a session token. Each launch token works once, within five minutes. */
  async function exchangeStudioToken(launchToken: unknown) {
    if (typeof launchToken !== 'string' || !launchToken) throw new PlatformError('invalid_token', 'This studio link has expired. Open it again from your app.', 401);
    const sessionToken = token('sts');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
    const [row] = await db
      .update(studioSessions)
      .set({ sessionHash: sha256(sessionToken), expiresAt })
      .where(
        and(eq(studioSessions.launchHash, sha256(launchToken)), isNull(studioSessions.sessionHash), gt(studioSessions.launchExpiresAt, new Date())),
      )
      .returning();
    if (!row) throw new PlatformError('invalid_token', 'This studio link has expired. Open it again from your app.', 401);
    return { sessionToken, expiresAt, tenantId: row.tenantId, origin: row.origin, theme: row.theme };
  }

  /** Who a session token belongs to, or null when it is unknown or has expired. */
  async function studioViewer(sessionToken: string): Promise<StudioViewer | null> {
    const [row] = await db
      .select({ session: studioSessions, accountId: apps.accountId })
      .from(studioSessions)
      .innerJoin(apps, eq(apps.id, studioSessions.appId))
      .where(and(eq(studioSessions.sessionHash, sha256(sessionToken)), gt(studioSessions.expiresAt, new Date())));
    if (!row) return null;
    const s = row.session;
    return {
      sessionId: s.id,
      appId: s.appId,
      accountId: row.accountId,
      tenantId: s.tenantId,
      user: { id: `${s.appId}:${s.userRef}`, name: s.userName ?? 'Studio user', email: s.userEmail },
      origin: s.origin,
      theme: s.theme,
      expiresAt: s.expiresAt!,
    };
  }

  /** Ends a session early, for example when the person signs out of the host app. */
  async function endStudioSession(sessionToken: string) {
    await db.update(studioSessions).set({ expiresAt: new Date() }).where(eq(studioSessions.sessionHash, sha256(sessionToken)));
  }

  return { setEmbedOrigins, createStudioSession, exchangeStudioToken, studioViewer, endStudioSession };
}
