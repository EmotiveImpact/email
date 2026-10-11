import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { request } from '../api.ts';
import { endStudio, startStudio, studioSession, tellHost, type StudioSession } from '../studio.ts';

/**
 * Where a host app's iframe lands: `/embed?page=campaigns#token=…`. The token sits in the fragment
 * so it never reaches server logs; it is swapped once for a session and wiped from the address.
 */
/** Opens once per page load, even when React runs effects twice (development) or re-renders. */
let opening: Promise<{ tenantId: string; page: 'campaigns' | 'audience' }> | null = null;

function open() {
  opening ??= (async () => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const page = new URLSearchParams(window.location.search).get('page') === 'audience' ? 'audience' : 'campaigns';
    if (token) history.replaceState(null, '', window.location.pathname + window.location.search);
    if (window.parent === window) throw new Error('The studio opens inside your app. Go back to it and open Email from there.');
    if (token) {
      endStudio();
      startStudio(await request<StudioSession>('/app/studio/exchange', { method: 'POST', body: JSON.stringify({ token }) }));
    }
    const session = studioSession();
    if (!session) throw new Error('This studio session has ended. Open it again from your app.');
    return { tenantId: session.tenantId, page };
  })();
  return opening;
}

export function Embed() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    open()
      .then(({ tenantId, page }) => {
        if (!live) return;
        queryClient.removeQueries({ queryKey: ['me'] });
        return navigate({ to: page === 'audience' ? '/$tenant/audience' : '/$tenant/campaigns', params: { tenant: tenantId }, replace: true });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setProblem(error instanceof Error ? error.message : String(error));
        if (window.parent !== window) tellHost({ type: 'session-expired' }, '*');
      });
    return () => {
      live = false;
    };
  }, [navigate, queryClient]);

  return (
    <div className="grid h-full min-h-[320px] place-items-center p-6 text-center">
      {problem ? (
        <div className="flex max-w-sm flex-col gap-2">
          <h1 className="display m-0 text-[22px]">Email is not open yet</h1>
          <p className="m-0 text-sm leading-relaxed text-muted">{problem}</p>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted">Opening…</p>
      )}
    </div>
  );
}
