import { test, expect, devices } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

/**
 * WHERE THE CARET IS AFTER A DIALOG CLOSES, AT A DESK AND UNDER A THUMB.
 *
 * v1.2.0's finding: closing a dialog left `document.activeElement` on `<body>`.
 * A keyboard user was returned to the top of the document with no way back to
 * what they were doing, and a screen-reader user was told nothing at all.
 *
 * THE CAUSE, and it is in one line of Radix. `DialogContentModal` composes its
 * own `onCloseAutoFocus`: `event.preventDefault()` and then
 * `context.triggerRef.current?.focus()` (@radix-ui/react-dialog
 * dist/index.mjs:154-157). That ref is written by `<DialogTrigger>` and by
 * nothing else, and the `preventDefault()` has already disabled FocusScope's
 * own fallback -- so a dialog with no trigger gets no restore, and a dialog
 * whose trigger is on its way out gets a restore onto a node that then leaves.
 * web: components/ui/dialog-focus.ts is the fix and carries the mechanism.
 *
 * WHICH DIALOGS, MEASURED RATHER THAN REASONED ABOUT, at 1280 and 390, over
 * all SIXTEEN `<Dialog>` roots this app opens across twelve files. Five landed
 * on `<body>` and are the subject of this file: the four driven by state
 * instead of a trigger (the composer, the task drawer, and the two settings
 * dialogs) and the Lose dialog on a deal, which HAS a trigger and still fails
 * because a successful lose unmounts it. The sixteenth caller is the phone
 * board's move sheet, which had this fixed by hand a task earlier and is
 * covered by e2e/mobile.spec.ts's two move tests.
 *
 * TEN ROOTS ARE LEFT TO RADIX and none is asserted here. All ten restore their
 * trigger on a dismissal. SEVEN of them do lose the caret on their success
 * path -- they navigate, which unmounts the page the trigger was on -- and that
 * is deliberately out of scope, because the same `<body>` was measured after
 * clicking an ordinary row link with no dialog in sight. See
 * web: components/entity-table.tsx, which carries the argument.
 *
 * PROVE THE INSTRUMENT BEFORE TRUSTING A READING, and the first version of the
 * probe behind this file failed exactly that test. FocusScope dispatches its
 * close-focus event from a `setTimeout(..., 0)` in the unmount cleanup
 * (@radix-ui/react-focus-scope dist/index.mjs:94), so the dialog is out of the
 * DOM a whole task before focus is placed. A `page.evaluate` taken the moment
 * the dialog disappears answers BODY for EVERY dialog in this app, the ten
 * working ones included -- which is a false positive that looks exactly like
 * the bug. `toBeFocused` polls, so it does not have that hole, and it is also
 * the assertion the plan asks for: focus lands ON THE TRIGGER, not merely
 * somewhere other than the body.
 *
 * THE DISMISSAL GESTURE IS THE REAL ONE AT EACH WIDTH. Escape at a desk; at
 * 390 the Close control, because a phone has no Escape key and ui/dialog.tsx
 * renders that control for exactly that reason.
 */

// See mobile.spec.ts: everything the device describes except the browser
// choice, since the job installs chromium and only chromium.
const { defaultBrowserType: _webkitByDefault, ...IPHONE_13 } = devices["iPhone 13"];

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
}

interface Fixture {
  readonly projectId: string;
  readonly taskId: string;
  readonly archivableTaskId: string;
  readonly pipelineId: string;
  readonly dealId: string;
  readonly templateAId: string;
  readonly templateBId: string;
}

/**
 * A project with a task on its board, and a pipeline with an OPEN deal.
 *
 * The deal has to be open and stay open until the last test in the group
 * touches it, because the Lose button only exists while it is -- which is the
 * whole point of the pair of tests at the end.
 */
async function seed(page: Page, tag: string): Promise<Fixture> {
  const me = (await (await page.request.get("/api/me")).json()) as { user: { id: string } };
  const project = await create(page, "/api/projects", { name: `Focusproj ${tag}` });
  const task = await create(page, "/api/tasks", {
    title: `Focustask ${tag}`,
    projectId: project.id,
    assigneeUserId: me.user.id,
  });
  // A second task, because the archive test consumes the one it uses.
  const archivable = await create(page, "/api/tasks", {
    title: `Focusarch ${tag}`,
    projectId: project.id,
    assigneeUserId: me.user.id,
  });
  const pipeline = await create(page, "/api/pipelines", { name: `Focuspipe ${tag}`, scope: "global" });
  const stage = await create(page, `/api/pipelines/${pipeline.id}/stages`, { name: "Lead" });
  const deal = await create(page, "/api/deals", {
    title: `Focusdeal ${tag}`,
    pipelineId: pipeline.id,
    stageId: stage.id,
  });
  return {
    projectId: project.id,
    taskId: task.id,
    archivableTaskId: archivable.id,
    pipelineId: pipeline.id,
    dealId: deal.id,
    // Two rows on one settings page, so one dialog has two different Edit
    // buttons. Templates rather than mail accounts because a template needs no
    // mail server at all, and because leaving a live account behind would
    // change the composer fixture of any spec running beside this one.
    templateAId: (await create(page, "/api/mail/templates", {
      name: `Focus template A ${tag}`, subject: "A", bodyHtml: "<p>A</p>",
    })).id,
    templateBId: (await create(page, "/api/mail/templates", {
      name: `Focus template B ${tag}`, subject: "B", bodyHtml: "<p>B</p>",
    })).id,
  };
}

function suite(label: string, phone: boolean, open: (browser: Browser) => Promise<Page>): void {
  test.describe.serial(`Closing a dialog returns the caret, at ${label}`, () => {
    const tag = `${phone ? "p" : "d"}${Date.now().toString(36)}`;
    let page: Page;
    let fixture: Fixture;

    test.beforeAll(async ({ browser }) => {
      page = await open(browser);
      fixture = await seed(page, tag);
    });

    test.afterAll(async () => {
      await page.close();
    });

    /** Escape at a desk; the sheet's own Close control on a phone. */
    async function dismiss(): Promise<void> {
      if (phone) await page.getByTestId("dialog-close").click();
      else await page.keyboard.press("Escape");
    }

    /**
     * The drawer has no `dialog-close`: that control belongs to DialogContent,
     * and the drawer carries its own labelled X instead.
     */
    async function dismissDrawer(): Promise<void> {
      if (phone) await page.getByRole("button", { name: "Close" }).click();
      else await page.keyboard.press("Escape");
    }

    test("the composer goes back to the button that opened it", async () => {
      await page.goto("/mail");
      const trigger = page.getByTestId("compose-button");
      await trigger.click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await dismiss();
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test("the task drawer goes back to the card that opened it", async () => {
      await page.goto(`/projects/${fixture.projectId}/board`);
      const trigger = page.getByTestId(`card-${fixture.taskId}`);
      await trigger.click();
      await expect(page.getByTestId("task-drawer")).toBeVisible();
      await dismissDrawer();
      await expect(page.getByTestId("task-drawer")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    /**
     * THE DRAWER'S OWN ACTIONS RETIRE THE CARD, AND `isConnected` CANNOT SEE
     * IT. Archiving takes the task off the board, but the drawer stays open and
     * the user closes it whenever they like -- so if they close BEFORE the
     * invalidate-and-refetch lands, the card is still in the document, still
     * `isConnected`, and gets the caret a frame before it unmounts. Measured
     * exactly that way: the caret went to the card and then to `<body>`.
     *
     * The `Escape` is deliberately not preceded by any wait, which is what puts
     * this inside the round trip. Deleting the `forget()` in task-drawer.tsx's
     * handleArchive is what this fails on; waiting for the refetch first would
     * make it pass either way, which is why no assertion here waits.
     */
    test("a task archived from the drawer lands on the page, not on the card", async () => {
      await page.goto(`/projects/${fixture.projectId}/board`);
      const trigger = page.getByTestId(`card-${fixture.archivableTaskId}`);
      await trigger.click();
      await expect(page.getByTestId("task-drawer")).toBeVisible();
      page.once("dialog", (confirm) => void confirm.accept());
      await page.getByRole("button", { name: "Archive", exact: true }).click();
      await dismissDrawer();
      await expect(page.getByTestId("task-drawer")).toHaveCount(0);
      await expect(page.locator("main")).toBeFocused();
      // The instrument: the card really did go, so this is the fallback rather
      // than a coincidence of the card never having been there.
      await expect(trigger).toHaveCount(0);
    });

    /**
     * THE CASE THAT DECIDED THE DESIGN. `?task=` is a supported deep link, so
     * this drawer can open on page load with no opener anywhere -- an element
     * cannot travel through a URL. Nothing to go back to is not the same as
     * nowhere to go: the app's content landmark takes the caret, which is what
     * components/shell.tsx's `tabIndex={-1}` is for and what fails if it goes.
     */
    test("a task drawer opened by a deep link lands on the page's content", async () => {
      await page.goto(`/projects/${fixture.projectId}/board?task=${fixture.taskId}`);
      await expect(page.getByTestId("task-drawer")).toBeVisible();
      await dismissDrawer();
      await expect(page.getByTestId("task-drawer")).toHaveCount(0);
      await expect(page.locator("main")).toBeFocused();
    });

    /**
     * The mail account form marks its first field `autoFocus`, and that is not
     * incidental to this test -- it is why the opener cannot be captured from
     * Radix's `onOpenAutoFocus`, which is never dispatched when focus is
     * already inside the content. See dialog-focus.ts.
     */
    test("the mail account dialog goes back to Add account", async () => {
      await page.goto("/settings/mail");
      const trigger = page.getByRole("button", { name: "Add account" });
      await trigger.click();
      await expect(page.getByTestId("account-form")).toBeVisible();
      await dismiss();
      await expect(page.getByTestId("account-form")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    /**
     * THE WHOLE JUSTIFICATION FOR CAPTURING AT THE OPENER, and until this test
     * nothing exercised it: every other case here opens from a single
     * top-of-page button, which one hard-coded ref would satisfy just as well.
     * Two template rows, two Edit buttons, one dialog -- opened from the second
     * row and then the first, so a stale capture from the previous open is a
     * failure rather than a coincidence.
     */
    test("the template dialog goes back to the ROW that opened it, not the last one", async () => {
      await page.goto("/settings/templates");
      const first = page.getByTestId(`email-template-${fixture.templateAId}`);
      const second = page.getByTestId(`email-template-${fixture.templateBId}`);
      await expect(first).toBeVisible();
      await expect(second).toBeVisible();

      const secondEdit = second.getByRole("button", { name: "Edit" });
      await secondEdit.click();
      await expect(page.getByTestId("template-form")).toBeVisible();
      await dismiss();
      await expect(page.getByTestId("template-form")).toHaveCount(0);
      await expect(secondEdit).toBeFocused();

      const firstEdit = first.getByRole("button", { name: "Edit" });
      await firstEdit.click();
      await expect(page.getByTestId("template-form")).toBeVisible();
      await dismiss();
      await expect(page.getByTestId("template-form")).toHaveCount(0);
      await expect(firstEdit).toBeFocused();
    });

    /** The second `autoFocus` dialog, and the fourth of the four. */
    test("the template dialog goes back to New template", async () => {
      await page.goto("/settings/templates");
      const trigger = page.getByRole("button", { name: "New template" });
      await trigger.click();
      await expect(page.getByTestId("template-form")).toBeVisible();
      await dismiss();
      await expect(page.getByTestId("template-form")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    /**
     * THE DEAL'S LOSE DIALOG IS BOTH A PASS AND A FAILURE, depending only on
     * how it is closed, which is why it takes two tests rather than one. This
     * is the dismissal: nothing changed, the trigger is still on screen, and
     * Radix restored it correctly even before this task -- so this test is here
     * to catch the fix REGRESSING that, not to prove it.
     */
    test("the Lose dialog goes back to Lose when it is dismissed", async () => {
      await page.goto(`/deals/${fixture.dealId}`);
      const trigger = page.getByTestId("lose-button");
      await trigger.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await dismiss();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    /**
     * AND THIS IS THE FAILURE, measured at `<body>` before the fix. Marking the
     * deal lost takes `deal.status` off "open", which unmounts the Lose button
     * -- so Radix hands the caret to a control that is leaving.
     *
     * MEASURED AGAIN AFTER THE FIRST FIX, because `isConnected` alone did not
     * close it: at the moment focus was handed back the button was STILL in the
     * document, and unmounted a frame later, so the caret ended on `<body>`
     * anyway. What closes it is the page telling the hook to forget the trigger
     * on the mutation's success -- see deal-detail.tsx. Deleting that one call
     * puts this test back on `<body>` while every other test in this file stays
     * green.
     *
     * LAST IN THE GROUP ON PURPOSE: it is the only test here that changes the
     * fixture, and the dismissal test above needs an open deal.
     */
    test("the Lose dialog has no Lose button to go back to once the deal is lost", async () => {
      await page.goto(`/deals/${fixture.dealId}`);
      await page.getByTestId("lose-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByPlaceholder("Reason (required)").fill("Budget");
      await page.getByRole("button", { name: "Mark lost" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The instrument: the trigger really has gone, so the landing below is
      // the fallback rather than a coincidence.
      await expect(page.getByTestId("lose-button")).toHaveCount(0);
      // THE DEAL'S OWN HEADING, not the shared `<main>`: this page passes a
      // better fallback, because the status badge is the heading's sibling and
      // nothing else on the page announces the change the user just made. So
      // this asserts the override as well as the landing.
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(page.getByTestId("deal-status")).toContainText("Lost");
    });
  });
}

suite("1280", false, (browser) => browser.newPage({ viewport: { width: 1280, height: 900 } }));
suite("390", true, (browser) => browser.newPage({ ...IPHONE_13 }));
