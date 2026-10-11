/**
 * The embedded studio: the same app inside a host app's iframe (Saleane, Caleane, a partner).
 * It signs in with a studio session token, kept only in this tab, and talks to the host page with
 * postMessage so the host can size the frame and react to what happens.
 */
import type { Brand } from './theme.ts';

export type StudioTheme = { accent?: string; headingFont?: Brand['headingFont']; canvas?: string };
export type StudioSession = { sessionToken: string; expiresAt: string; tenantId: string; origin: string; theme: StudioTheme };

const KEY = 'studio-session';

function read(): StudioSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StudioSession) : null;
  } catch {
    return null;
  }
}

let session: StudioSession | null = typeof window !== 'undefined' && window.parent !== window ? read() : null;

export const studioSession = () => session;
export const inStudio = () => session !== null;

export function startStudio(next: StudioSession) {
  session = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked in third-party frames; the session still lives in memory.
  }
}

export function endStudio() {
  session = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}

export type StudioEvent =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'session-expired' }
  | { type: 'campaign.scheduled'; campaignId: string; sendAt: string }
  | { type: 'navigate'; page: string };

/** Tells the host page something happened. Only the origin that opened the studio hears it. */
export function tellHost(event: StudioEvent, origin = session?.origin) {
  if (!origin || window.parent === window) return;
  window.parent.postMessage({ source: 'platform-studio', ...event }, origin);
}
