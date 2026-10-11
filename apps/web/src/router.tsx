import { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { activityQuery, messagesQuery, tenantsQuery } from './api.ts';
import { Shell } from './components/Shell.tsx';
import { Button } from './components/ui.tsx';
import { Appearance } from './pages/Appearance.tsx';
import { Developers } from './pages/Developers.tsx';
import { Home } from './pages/Home.tsx';
import { Sending } from './pages/Sending.tsx';
import { Soon } from './pages/Soon.tsx';

/*
 * Routes are declared in code rather than generated from files: there are few of them, and it
 * keeps the build free of a generated route tree.
 */

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  errorComponent: Failure,
  notFoundComponent: () => <Centred title="Page not found" />,
});

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  loader: async ({ context }) => {
    const tenants = await context.queryClient.ensureQueryData(tenantsQuery);
    if (tenants[0]) throw redirect({ to: '/$tenant', params: { tenant: tenants[0].id } });
  },
  component: () => (
    <Centred title="No businesses yet">
      Run <code className="rounded bg-soft px-1.5 py-0.5">pnpm db:seed</code>, or create one through the API with <code className="rounded bg-soft px-1.5 py-0.5">PUT /v1/tenants/:id</code>.
    </Centred>
  ),
});

const tenant = createRoute({
  getParentRoute: () => root,
  path: '$tenant',
  loader: ({ context }) => context.queryClient.ensureQueryData(tenantsQuery),
  component: Shell,
});

const withActivity = ({ context, params }: { context: { queryClient: QueryClient }; params: { tenant: string } }) =>
  context.queryClient.ensureQueryData(activityQuery(params.tenant));

const home = createRoute({ getParentRoute: () => tenant, path: '/', loader: withActivity, component: Home });
const sending = createRoute({
  getParentRoute: () => tenant,
  path: 'sending',
  loader: ({ context, params }) =>
    Promise.all([withActivity({ context, params }), context.queryClient.ensureQueryData(messagesQuery(params.tenant, 'all'))]),
  component: Sending,
});
const campaigns = createRoute({ getParentRoute: () => tenant, path: 'campaigns', component: () => <Soon area="campaigns" /> });
const flows = createRoute({ getParentRoute: () => tenant, path: 'flows', component: () => <Soon area="flows" /> });
const audience = createRoute({ getParentRoute: () => tenant, path: 'audience', component: () => <Soon area="audience" /> });
const developers = createRoute({ getParentRoute: () => tenant, path: 'developers', component: Developers });
const appearance = createRoute({ getParentRoute: () => tenant, path: 'settings/appearance', component: Appearance });

const routeTree = root.addChildren([index, tenant.addChildren([home, sending, campaigns, flows, audience, developers, appearance])]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultPreloadStaleTime: 0, scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}

function Centred({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="display m-0 text-[28px]" style={{ fontFamily: "'Cal Sans', sans-serif" }}>
          {title}
        </h1>
        {children && <p className="m-0 text-sm leading-relaxed text-muted">{children}</p>}
      </div>
    </div>
  );
}

function Failure({ error, reset }: ErrorComponentProps) {
  return (
    <Centred title="Something went wrong">
      {error instanceof Error ? error.message : String(error)}
      <span className="mt-4 block">
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      </span>
    </Centred>
  );
}
