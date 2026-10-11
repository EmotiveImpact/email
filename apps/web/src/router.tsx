import { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { activityQuery, ApiError, campaignQuery, campaignsQuery, flowQuery, flowsQuery, meQuery, messagesQuery, overviewQuery, segmentsQuery, sendingQuery, tenantsQuery } from './api.ts';
import { readLastTenant, Shell } from './components/Shell.tsx';
import { Button } from './components/ui.tsx';
import { Appearance } from './pages/Appearance.tsx';
import { Audience, type AudienceSearch } from './pages/Audience.tsx';
import { CampaignPage } from './pages/CampaignEditor.tsx';
import { Campaigns } from './pages/Campaigns.tsx';
import { Developers } from './pages/Developers.tsx';
import { Domain } from './pages/Domain.tsx';
import { Embed } from './pages/Embed.tsx';
import { Home } from './pages/Home.tsx';
import { SegmentBuilder } from './pages/SegmentBuilder.tsx';
import { Sending } from './pages/Sending.tsx';
import { Setup, SignIn } from './pages/SignIn.tsx';
import { FlowOverview, FlowPage, Flows } from './pages/Flows.tsx';

/*
 * Routes are declared in code rather than generated from files: there are few of them, and it
 * keeps the build free of a generated route tree.
 */

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  errorComponent: Failure,
  notFoundComponent: () => <Centred title="Page not found" />,
});

/** Loads who is signed in; anyone signed out goes to the sign-in page. */
async function requireMe(queryClient: QueryClient) {
  try {
    return await queryClient.ensureQueryData(meQuery);
  } catch (error) {
    // Inside a host app's frame there is no sign-in page: the host has to open the studio again.
    if (error instanceof ApiError && error.status === 401) throw redirect({ to: window.parent !== window ? '/embed' : '/sign-in' });
    throw error;
  }
}

const signIn = createRoute({ getParentRoute: () => root, path: 'sign-in', component: SignIn });
const embed = createRoute({ getParentRoute: () => root, path: 'embed', component: Embed });

const setup = createRoute({
  getParentRoute: () => root,
  path: 'setup',
  loader: ({ context }) => requireMe(context.queryClient),
  component: Setup,
});

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  loader: async ({ context }) => {
    const me = await requireMe(context.queryClient);
    if (!me.accountId) throw redirect({ to: '/setup' });
    const tenants = await context.queryClient.ensureQueryData(tenantsQuery);
    const last = tenants.find((t) => t.id === readLastTenant()) ?? tenants[0];
    throw last ? redirect({ to: '/$tenant', params: { tenant: last.id } }) : redirect({ to: '/setup' });
  },
});

const tenant = createRoute({
  getParentRoute: () => root,
  path: '$tenant',
  loader: async ({ context }) => {
    const me = await requireMe(context.queryClient);
    if (!me.accountId) throw redirect({ to: '/setup' });
    return context.queryClient.ensureQueryData(tenantsQuery);
  },
  component: Shell,
});

const withActivity = ({ context, params }: { context: { queryClient: QueryClient }; params: { tenant: string } }) =>
  context.queryClient.ensureQueryData(activityQuery(params.tenant));

const home = createRoute({
  getParentRoute: () => tenant,
  path: '/',
  loader: async (args) => {
    void args.context.queryClient.prefetchQuery(overviewQuery(args.params.tenant));
    return withActivity(args);
  },
  component: Home,
});
const sending = createRoute({
  getParentRoute: () => tenant,
  path: 'sending',
  loader: ({ context, params }) =>
    Promise.all([withActivity({ context, params }), context.queryClient.ensureQueryData(messagesQuery(params.tenant, 'all'))]),
  component: Sending,
});
const campaigns = createRoute({
  getParentRoute: () => tenant,
  path: 'campaigns',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(campaignsQuery(params.tenant)),
  component: Campaigns,
});
const campaign = createRoute({
  getParentRoute: () => tenant,
  path: 'campaigns/$campaign',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(campaignQuery(params.tenant, params.campaign)),
  component: CampaignPage,
});
const flows = createRoute({
  getParentRoute: () => tenant,
  path: 'flows',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(flowsQuery(params.tenant)),
  component: Flows,
});
const flow = createRoute({
  getParentRoute: () => tenant,
  path: 'flows/$flow',
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(flowsQuery(params.tenant)), context.queryClient.ensureQueryData(flowQuery(params.tenant, params.flow))]),
  component: FlowOverview,
});
const flowEmail = createRoute({
  getParentRoute: () => tenant,
  path: 'flows/$flow/email',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(flowQuery(params.tenant, params.flow)),
  component: FlowPage,
});
const audience = createRoute({
  getParentRoute: () => tenant,
  path: 'audience',
  validateSearch: (search: Record<string, unknown>): AudienceSearch => ({
    view: search.view === 'segments' ? 'segments' : undefined,
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
    consent: search.consent === 'granted' || search.consent === 'withdrawn' || search.consent === 'unknown' ? search.consent : undefined,
    segment: typeof search.segment === 'string' && search.segment ? search.segment : undefined,
    page: typeof search.page === 'number' && search.page > 0 ? search.page : undefined,
    contact: typeof search.contact === 'string' && search.contact ? search.contact : undefined,
  }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(segmentsQuery(params.tenant)),
  component: Audience,
});
const segment = createRoute({ getParentRoute: () => tenant, path: 'audience/segments/$segment', component: SegmentBuilder });
const developers = createRoute({ getParentRoute: () => tenant, path: 'developers', component: Developers });
const domain = createRoute({
  getParentRoute: () => tenant,
  path: 'settings/domain',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(sendingQuery(params.tenant)),
  component: Domain,
});
const appearance = createRoute({ getParentRoute: () => tenant, path: 'settings/appearance', component: Appearance });

const routeTree = root.addChildren([
  index,
  signIn,
  embed,
  setup,
  tenant.addChildren([home, sending, campaigns, campaign, flows, flow, flowEmail, audience, segment, domain, developers, appearance]),
]);

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
