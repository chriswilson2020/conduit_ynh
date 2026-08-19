import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "./App";
import { basePath } from "./api";
import { Shell } from "./components/shell";
import { BoardPage } from "./pages/board";
import { CompaniesPage } from "./pages/companies";
import { CompanyDetailPage } from "./pages/company-detail";
import { ContactsPage } from "./pages/contacts";
import { ContactDetailPage } from "./pages/contact-detail";
import { DealDetailPage } from "./pages/deal-detail";
import { GanttLabPage } from "./pages/gantt-lab";
import { PipelinesPage } from "./pages/pipelines";
import { ProjectsPage } from "./pages/projects";
import { ProjectDetailPage } from "./pages/project-detail";
import { ProjectGanttPlaceholderPage } from "./pages/project-gantt-placeholder";
import { TaskBoardPage } from "./pages/task-board";

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

const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  component: CompaniesPage,
});

const companyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies/$companyId",
  component: CompanyDetailPage,
});

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: ContactsPage,
});

const contactDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/$contactId",
  component: ContactDetailPage,
});

const pipelinesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pipelines",
  component: PipelinesPage,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pipelines/$pipelineId",
  component: BoardPage,
});

const dealDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deals/$dealId",
  component: DealDetailPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectDetailPage,
});

const taskBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/board",
  component: TaskBoardPage,
});

// Placeholder until Task 9 (see project-gantt-placeholder.tsx's own doc
// comment) -- registered now so project-detail.tsx's "Gantt" link is honest
// rather than a 404.
const projectGanttRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/gantt",
  component: ProjectGanttPlaceholderPage,
});

// G0 prototype gate (Phase 3 plan, Task 1): registered normally so it's a
// real route, but deliberately linked from no nav -- throwaway, synthetic
// data only, deleted by Task 9 once the real Gantt ships either way.
const ganttLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gantt-lab",
  component: GanttLabPage,
});

// Rendered by the router itself (not a route) whenever the URL matches no
// route in the tree -- a stale bookmark or a mistyped path. It renders as the
// root route's Outlet content, i.e. inside Shell, so the sidebar/header stay
// usable and the user is never dropped on a bare, nav-less page. A company or
// contact id that IS shaped like a route match but doesn't exist in the
// database is a different case, handled inside CompanyDetailPage /
// ContactDetailPage themselves (their query 404s, so they render their own
// not-found card rather than falling through to this one).
function NotFoundComponent() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div
        data-testid="not-found"
        className="max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm"
      >
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-1 text-sm text-slate-500">
          The page you are looking for does not exist.
        </p>
        <Link
          to="/"
          className="mt-4 inline-block text-sm font-medium text-slate-900 underline hover:text-slate-700"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  companiesRoute,
  companyDetailRoute,
  contactsRoute,
  contactDetailRoute,
  pipelinesRoute,
  boardRoute,
  dealDetailRoute,
  ganttLabRoute,
  projectsRoute,
  projectDetailRoute,
  taskBoardRoute,
  projectGanttRoute,
]);

// basePath() returns "/" both at a root install and during `vite dev` (see its
// doc comment in api.ts): the router's own default is already "/", so passing
// undefined there avoids the router treating "/" as a one-segment basepath
// literally. Only a real subpath install (e.g. "/conduit") needs to be passed
// through.
const mountedBasePath = basePath();

export const router = createRouter({
  routeTree,
  basepath: mountedBasePath === "/" ? undefined : mountedBasePath,
  defaultNotFoundComponent: NotFoundComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
