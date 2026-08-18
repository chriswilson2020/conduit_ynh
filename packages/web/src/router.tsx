import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "./App";
import { basePath } from "./api";
import { Shell } from "./components/shell";

// A short staleTime keeps list/detail views from refetching on every focus
// change while still picking up another tab's edits within a few seconds; a
// single retry tolerates one transient blip without masking a real outage
// behind a spinner that retries silently three more times.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1 },
  },
});

function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell>
        <Outlet />
      </Shell>
    </QueryClientProvider>
  );
}

const rootRoute = createRootRoute({ component: RootComponent });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});

// Placeholder page components: Task 9 (companies + contacts pages) replaces
// these with the real list/detail views.
const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  component: () => <div data-testid="page-companies">Companies</div>,
});

const companyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies/$companyId",
  component: () => <div data-testid="page-company-detail">Company</div>,
});

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: () => <div data-testid="page-contacts">Contacts</div>,
});

const contactDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/$contactId",
  component: () => <div data-testid="page-contact-detail">Contact</div>,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  companiesRoute,
  companyDetailRoute,
  contactsRoute,
  contactDetailRoute,
]);

// basePath() returns "/" both at a root install and during `vite dev` (see its
// doc comment in api.ts): the router's own default is already "/", so passing
// undefined there avoids the router treating "/" as a one-segment basepath
// literally. Only a real subpath install (e.g. "/conduit") needs to be passed
// through.
export const router = createRouter({
  routeTree,
  basepath: basePath() === "/" ? undefined : basePath(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
