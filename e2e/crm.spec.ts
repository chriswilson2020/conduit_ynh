import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// One serial journey through the core CRM flows: company -> contact -> note
// -> file -> search -> archive/unarchive -> not-found. Tests run in file
// order, share a single page (state accumulates across them: companyId and
// contactId captured in one test are used by later ones), and a failure
// stops the remaining tests rather than cascading into confusing failures.
//
// Names are all derived from a run id so the journey is safe both in CI
// (fresh DB per run) and locally (DB may carry leftovers from a previous
// run): every assertion below scopes to something containing runId, so it
// can never match a stray row from an earlier local run.
test.describe.serial("CRM journey", () => {
  const runId = Date.now().toString(36);
  const companyName = `Acme ${runId}`;
  const contactName = `Ann ${runId}`;
  const noteText = `Met Ann at the Utrecht conference ${runId}`;
  const fileName = `notes-${runId}.txt`;
  const fileContent = `Company notes for ${companyName}`;

  let page: Page;
  let companyId: string;
  let contactId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("creates a company and lists it", async () => {
    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create" }).click();

    // Creation navigates straight to the new company's detail page.
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    companyId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: companyName })).toBeVisible();

    // Back on the list, filtered by the run id, the new row is there.
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(companyName);

    // Open it via the row, as a user would.
    await row.click();
    await expect(page).toHaveURL(`/companies/${companyId}`);
  });

  test("edits the industry field inline and records it on the timeline", async () => {
    await page.goto(`/companies/${companyId}`);

    const industryField = page.getByTestId("field-industry");
    await industryField.click();
    const industryInput = industryField.locator("input");
    await industryInput.fill("biotech");
    await industryInput.press("Enter");
    await expect(industryField).toContainText("biotech");

    await page.getByRole("tab", { name: "Timeline" }).click();
    const entries = page.getByTestId("timeline-entry");
    await expect(entries.filter({ hasText: "created" })).toBeVisible();
    await expect(entries.filter({ hasText: "updated industry" })).toBeVisible();
  });

  test("creates a contact linked to the company", async () => {
    await page.goto(`/companies/${companyId}`);
    await page.getByRole("button", { name: "New contact" }).click();
    await page.getByPlaceholder("First name").fill(contactName);
    await page.getByRole("button", { name: "Create" }).click();

    // Creation navigates straight to the new contact's detail page.
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    contactId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: contactName })).toBeVisible();

    // Back on the company, she is listed under Contacts; follow the link.
    await page.goto(`/companies/${companyId}`);
    const contactLink = page.getByTestId("company-contacts").getByRole("link", { name: contactName });
    await expect(contactLink).toBeVisible();
    await contactLink.click();
    await expect(page).toHaveURL(`/contacts/${contactId}`);
  });

  test("adds a note to the contact", async () => {
    await page.goto(`/contacts/${contactId}`);
    await page.getByRole("tab", { name: "Notes" }).click();
    await expect(page.getByTestId("notes")).toBeVisible();

    await page.getByPlaceholder("Add a note...").fill(noteText);
    await page.getByTestId("add-note").click();
    await expect(page.getByTestId("notes")).toContainText(noteText);

    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.getByTestId("timeline-entry").filter({ hasText: noteText })).toBeVisible();
  });

  test("uploads a file to the company", async () => {
    await page.goto(`/companies/${companyId}`);
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByTestId("files")).toBeVisible();

    await page.getByLabel("Choose file").setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(fileContent),
    });

    const filesRail = page.getByTestId("files");
    await expect(filesRail).toContainText(fileName);

    const downloadLink = filesRail.getByRole("link", { name: fileName });
    const href = await downloadLink.getAttribute("href");
    expect(href).not.toBeNull();
    const response = await page.request.get(href as string);
    expect(response.status()).toBe(200);
    expect((await response.body()).toString("utf-8")).toBe(fileContent);
  });

  test("finds the company and the note via global search", async () => {
    await page.goto(`/companies/${companyId}`);

    // Company name -> a Companies result that navigates to it.
    const searchInput = page.getByTestId("search-input");
    await searchInput.fill(companyName);
    const companyResult = page.getByTestId("search-result").filter({ hasText: companyName });
    await expect(companyResult).toBeVisible();
    await companyResult.click();
    await expect(page).toHaveURL(`/companies/${companyId}`);

    // A fragment of the note body -> a Notes result whose snippet is visible
    // and which navigates to the contact (the note's parent), not the company.
    await searchInput.fill(noteText);
    const noteResult = page.getByTestId("search-result").filter({ hasText: noteText });
    await expect(noteResult).toBeVisible();
    await noteResult.click();
    await expect(page).toHaveURL(`/contacts/${contactId}`);
  });

  test("archives and unarchives the company", async () => {
    await page.goto(`/companies/${companyId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByTestId("archived-badge")).toBeVisible();

    // Gone from the default (non-archived) list.
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    await expect(page.getByTestId(`row-${companyId}`)).not.toBeVisible();

    // Present once the Archived filter is turned on.
    await page.getByRole("checkbox", { name: "Archived" }).check();
    await expect(page.getByTestId(`row-${companyId}`)).toBeVisible();

    // Detail page still loads, read-only, with the archived badge.
    await page.goto(`/companies/${companyId}`);
    await expect(page.getByTestId("archived-badge")).toBeVisible();
    // exact: true -- "Archive" is otherwise a substring match of "Unarchive",
    // which IS visible at this point.
    await expect(page.getByRole("button", { name: "Archive", exact: true })).not.toBeVisible();

    // Unarchive restores it to the default list.
    await page.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.getByTestId("archived-badge")).not.toBeVisible();

    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    await expect(page.getByTestId(`row-${companyId}`)).toBeVisible();
  });

  test("shows a not-found card for a missing company id", async () => {
    await page.goto("/companies/00000000-0000-0000-0000-000000000000");
    await expect(page.getByTestId("not-found")).toBeVisible();
  });
});
