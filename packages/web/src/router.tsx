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
import { GlobalGanttPage, ProjectGanttPage } from "./pages/gantt";
import { InboxPage } from "./pages/inbox";
import { MyTasksPage } from "./pages/my-tasks";
import { PipelinesPage } from "./pages/pipelines";
import { ProjectsPage } from "./pages/projects";
import { ProjectDetailPage } from "./pages/project-detail";
import { SettingsDataPage } from "./pages/settings-data";
import { SettingsMailPage } from "./pages/settings-mail";
import { SettingsOrgPage } from "./pages/settings-org";
import { SettingsTemplatesPage } from "./pages/settings-templates";
import { TaskBoardPage } from "./pages/task-board";

// Shared by both routes below that open the task drawer via a `?task=<id>`
// deep link (the task board and My Tasks, Task 8) -- a malformed/absent
// value degrades to "no task open" rather than throwing, mirroring every
// other loosely-typed search param convention in this app (there is no
// stricter validation library wired in).
function validateTaskSearch(search: Record<string, unknown>): { task?: string } {
  return { task: typeof search.task === "string" ? search.task : undefined };
}

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
  validateSearch: validateTaskSearch,
  component: TaskBoardPage,
});

const myTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/my-tasks",
  validateSearch: validateTaskSearch,
  component: MyTasksPage,
});

// The real Gantt (Task 9), replacing G0's throwaway gantt-lab route (now
// deleted) and project-gantt-placeholder.tsx (also deleted). Per-project and
// global both open the task drawer via the same `?task=<id>` deep-link
// convention as the task board / My Tasks.
const projectGanttRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/gantt",
  validateSearch: validateTaskSearch,
  component: ProjectGanttPage,
});

const globalGanttRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gantt",
  validateSearch: validateTaskSearch,
  component: GlobalGanttPage,
});

// The mail inbox (Phase 4). `?thread=<id>` preselects a conversation, the
// same loosely-typed deep-link convention validateTaskSearch uses for the
// task drawer -- a malformed or absent value degrades to "nothing selected".
const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  validateSearch: (search: Record<string, unknown>): { thread?: string } => ({
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  component: InboxPage,
});

// Settings (Phase 4) is the app's first non-record area: three sibling routes
// under /settings, each rendering its own page inside the shared
// SettingsLayout frame (components/settings-layout.tsx). The tabs there are
// router Links rather than a Tabs component precisely because these are real
// routes -- see that file's doc comment.
const settingsMailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/mail",
  component: SettingsMailPage,
});

const settingsTemplatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/templates",
  component: SettingsTemplatesPage,
});

// Phase 7's issuer profile: who a quote is FROM. A settings singleton rather
// than a record, so it is a sibling route here like the other two.
const settingsOrgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/org",
  component: SettingsOrgPage,
});

// Phase 7.6: the two downloads, and the page whose job is to stop them being
// confused for each other. A fourth sibling under /settings for the same reason
// the other three are siblings -- it has its own URL, and "send me the export
// page" has to be a link somebody can follow.
const settingsDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/data",
  component: SettingsDataPage,
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
  projectsRoute,
  projectDetailRoute,
  taskBoardRoute,
  projectGanttRoute,
  globalGanttRoute,
  myTasksRoute,
  mailRoute,
  settingsMailRoute,
  settingsTemplatesRoute,
  settingsOrgRoute,
  settingsDataRoute,
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
