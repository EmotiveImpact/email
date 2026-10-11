/** Browser helper: puts the studio in your page and keeps the frame the height of its content. */

export type StudioEvent =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'session-expired' }
  | { type: 'campaign.scheduled'; campaignId: string; sendAt: string };

/**
 * Mounts the studio from a session `url` (made on your server with `client.studio.createSession`).
 * Returns a function that removes it. `onEvent` hears what happens inside, for example
 * `session-expired`, when you should create a new session and mount again.
 */
export function mountStudio(element: HTMLElement, url: string, options: { onEvent?: (event: StudioEvent) => void; minHeight?: number } = {}) {
  const doc = element.ownerDocument;
  const frame = doc.createElement('iframe');
  frame.src = url;
  frame.title = 'Email';
  frame.setAttribute('allow', 'clipboard-write');
  Object.assign(frame.style, { width: '100%', border: '0', display: 'block', minHeight: `${options.minHeight ?? 640}px` });
  element.appendChild(frame);

  const studioOrigin = new URL(url).origin;
  const onMessage = (message: MessageEvent) => {
    if (message.origin !== studioOrigin || message.source !== frame.contentWindow) return;
    const data = message.data as (StudioEvent & { source?: string }) | null;
    if (data?.source !== 'platform-studio') return;
    if (data.type === 'resize') frame.style.height = `${Math.max(data.height, options.minHeight ?? 640)}px`;
    options.onEvent?.(data);
  };
  window.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
  };
}
