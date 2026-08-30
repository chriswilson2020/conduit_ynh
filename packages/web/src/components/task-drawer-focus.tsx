import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { NO_RETURN_FOCUS, useDialogReturnFocus } from "./ui/dialog-focus";
import type { DialogReturnFocus } from "./ui/dialog-focus";

/**
 * WHERE THE TASK DRAWER'S CLOSE PUTS THE CARET, HELD ABOVE THE ROUTER because
 * one of its openers is not on the page the drawer opens on.
 *
 * The drawer is driven by a `?task=` URL param, and three pages mount it --
 * the task board, My Tasks and both Gantts. Those openers are on the same page
 * and could hand the element straight down. GLOBAL SEARCH CANNOT: it lives in
 * components/shell.tsx's header and in the phone's search sheet, navigates to
 * `?task=<id>` on another page's route, and has no way to reach that page's
 * hook. When the target is a task on the route the user is ALREADY on, the
 * search box does not even unmount -- so it is a live opener sitting on screen
 * while the drawer's close was measured landing on `<main>`.
 *
 * A CONTEXT RATHER THAN A MODULE-LEVEL SLOT, and the alternative was written
 * out before this was: a `let` in ui/dialog-focus.ts that any opener could
 * write and any dialog could read. It is smaller and it is a global variable
 * standing in for a shared ancestor that actually exists -- shell.tsx renders
 * both the search box and the router outlet. So the ancestor provides it.
 *
 * ONE INSTANCE FOR ALL FOUR MOUNT SITES IS CORRECT, not a compromise: the
 * drawer is one surface addressed by one URL param, and two of them can never
 * be open at once.
 *
 * The prop on TaskDrawer stays REQUIRED even though this could supply it
 * directly, because that is what makes a new mount site a type error.
 *
 * IT LIVES IN ITS OWN MODULE rather than in components/task-drawer.tsx because
 * that file is already in an import cycle with pages/task-board.tsx (it borrows
 * that page's STATUS and TYPE tables), and shell.tsx and search.tsx would each
 * have added an edge into it. Nothing here imports anything but React and the
 * hook.
 */
const TaskDrawerFocusContext = createContext<DialogReturnFocus>(NO_RETURN_FOCUS);

/** Wraps the app; see the context above. components/shell.tsx is the caller. */
export function TaskDrawerFocusProvider({ children }: { children: ReactNode }) {
  const value = useDialogReturnFocus();
  return <TaskDrawerFocusContext.Provider value={value}>{children}</TaskDrawerFocusContext.Provider>;
}

/**
 * For the pages that mount the drawer and for every control that opens it,
  * including components/search.tsx.
 */

export function useTaskDrawerFocus(): DialogReturnFocus {
  return useContext(TaskDrawerFocusContext);
}
