import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { Deal, UpdateDealInput } from "@conduit/shared";
import { formatMoneyCents } from "@conduit/shared";
import { ApiError, apiUrl } from "../api";
import { parseDecimal } from "../lib";
import {
  useArchiveDeal,
  useCompany,
  useContact,
  useDeal,
  useDealDocuments,
  useLoseDeal,
  usePipeline,
  useReopenDeal,
  useUnarchiveDeal,
  useUpdateDeal,
  useWinDeal,
} from "../queries";
import { DocumentForm } from "../components/document-form";
import { FieldCard, type FieldCardField } from "../components/field-card";
import { OwnerSelect } from "../components/owner-select";
import { Rail } from "../components/rail/rail";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";

function buildDealPatch(name: string, value: string): UpdateDealInput {
  const trimmed = value.trim();
  switch (name) {
    case "title":
      return { title: trimmed };
    case "value": {
      // Mirrors board.tsx's NewDealDialog: the input is a plain decimal
      // amount ("1234.56"), converted to integer cents on save, via the
      // shared parseDecimal (src/lib.ts) so a comma decimal separator
      // ("1234,56") is accepted too. An empty or unparseable draft clears
      // the value; the API's own valueCents schema
      // (z.number().int().safe().nullable()) is the actual guard against a
      // malformed amount slipping through -- this only does the unit
      // conversion, not full validation.
      const parsed = parseDecimal(trimmed);
      return { valueCents: parsed === null ? null : Math.round(parsed * 100) };
    }
    default:
      return {};
  }
}

const STATUS_LABEL: Record<string, string> = { open: "Open", won: "Won", lost: "Lost" };
const STATUS_CLASSES: Record<string, string> = {
  open: "bg-slate-100 text-slate-700",
  won: "bg-green-100 text-green-800",
  lost: "bg-red-100 text-red-700",
};

export function DealDetailPage() {
  const { dealId } = useParams({ from: "/deals/$dealId" });
  const { data: deal, isLoading, error } = useDeal(dealId);
  const companyQuery = useCompany(deal?.companyId ?? "");
  const contactQuery = useContact(deal?.contactId ?? "");
  const linkedCompany = companyQuery.data;
  const linkedContact = contactQuery.data;
  /**
   * WHETHER THE QUOTE FORM'S DEFAULTS ARE STILL ON THE WIRE.
   *
   * `fetchStatus`, not `isLoading` or `isPending`: a DISABLED query (this deal
   * has no company, or no contact) sits at `status: "pending"` for ever in
   * TanStack v5, so anything derived from `isPending` would report "still
   * loading" on a deal that will never have one. `fetchStatus === "fetching"`
   * is true only while a request is actually open, which also means a query
   * that FAILED lifts the gate rather than holding it shut -- see
   * components/document-form.tsx, where the reason that distinction matters is
   * written out.
   */
  const defaultsInFlight =
    companyQuery.fetchStatus === "fetching" || contactQuery.fetchStatus === "fetching";
  const { data: pipelineData } = usePipeline(deal?.pipelineId ?? "");
  const updateDeal = useUpdateDeal();
  const archiveDeal = useArchiveDeal();
  const unarchiveDeal = useUnarchiveDeal();
  const winDeal = useWinDeal();
  const reopenDeal = useReopenDeal();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [loseOpen, setLoseOpen] = useState(false);

  // ApiError.code is the server's machine-readable `error` field: branching
  // on it (rather than the human-readable message, which for "archived"
  // always includes the interpolated deal id) is what lets this reword that
  // 409 into an actionable hint. A 409 "conflict" from win/lose/reopen (an
  // illegal transition -- someone else changed the deal's status first)
  // falls through to the plain message, same as every other page here.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This deal is archived. Unarchive it to make changes.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  function handleSave(name: string, value: string) {
    if (!deal) return;
    setSavingField(name);
    updateDeal.mutate(
      { id: deal.id, patch: buildDealPatch(name, value) },
      {
        onSuccess: () => setSavingField(null),
        onError: (err) => {
          setSavingField(null);
          reportError(err);
        },
      },
    );
  }

  function handleOwnerChange(userId: string | null) {
    if (!deal) return;
    updateDeal.mutate({ id: deal.id, patch: { ownerUserId: userId } }, { onError: reportError });
  }

  function handleExpectedCloseDateChange(value: string) {
    if (!deal) return;
    updateDeal.mutate(
      { id: deal.id, patch: { expectedCloseDate: value === "" ? null : value } },
      { onError: reportError },
    );
  }

  function handleArchive() {
    if (!deal) return;
    if (!window.confirm(`Archive ${deal.title}?`)) return;
    archiveDeal.mutate(deal.id, { onError: reportError });
  }

  function handleUnarchive() {
    if (!deal) return;
    unarchiveDeal.mutate(deal.id, { onError: reportError });
  }

  function handleWin() {
    if (!deal) return;
    winDeal.mutate(deal.id, { onError: reportError });
  }

  function handleReopen() {
    if (!deal) return;
    reopenDeal.mutate(deal.id, { onError: reportError });
  }

  // Inside the frame, not in place of it, and with the route param rather
  // than `deal.id` -- see company-detail.tsx for what that keeps alive.
  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 lg:w-2/3">
          <p>Loading...</p>
        </div>
        <aside className="min-w-0 lg:w-1/3">
          <Rail dealId={dealId} />
        </aside>
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div
          data-testid="not-found"
          className="max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm"
        >
          <h1 className="text-lg font-semibold text-slate-900">Deal not found</h1>
          <Link to="/pipelines" className="mt-4 inline-block text-sm font-medium text-slate-900 underline">
            Back to pipelines
          </Link>
        </div>
      );
    }
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load deal: {error.message}
      </p>
    );
  }

  if (!deal) return null;

  const archived = deal.archivedAt !== null;
  const formattedValue = deal.valueCents != null
    ? formatMoneyCents(deal.valueCents, deal.currency)
    : null;

  const fields: FieldCardField[] = [
    { name: "title", label: "Title", value: deal.title, editable: true },
    {
      name: "value",
      label: "Value",
      value: deal.valueCents != null ? String(deal.valueCents / 100) : null,
      displayValue: formattedValue,
      editable: true,
    },
  ];

  const statusText = deal.status === "lost" && deal.lostReason
    ? `${STATUS_LABEL.lost} \u2014 ${deal.lostReason}`
    : (STATUS_LABEL[deal.status] ?? deal.status);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 lg:w-2/3">
        {bannerError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            <span>{bannerError}</span>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              className="ml-4 shrink-0 text-red-500 hover:text-red-700"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mb-2">
          <Link
            to="/pipelines/$pipelineId"
            params={{ pipelineId: deal.pipelineId }}
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            {"\u2190"} {pipelineData?.pipeline.name ?? "Board"}
          </Link>
        </div>

        {/*
          WRAPS BELOW THE BREAKPOINT, AND IT IS NOT COSMETIC. Measured at 390px:
          the title, the status pill and the Win/Lose/Archive group are 403px of
          row against a 390px box, and this was the ONE phone page in the app
          whose content did not fit -- which components/shell.tsx used to hide
          by letting <main> scroll sideways, and can no longer, now that main
          clips below the breakpoint so the board's stage picker can stick.
          Wrapping drops the action group onto its own line, which takes this
          page's scroll width to 390 against 390 -- nothing over the edge. See
          that comment for the rest of the measurements.
        */}
        <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-wrap">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-xl font-semibold break-words text-slate-900">{deal.title}</h1>
            <span
              data-testid="deal-status"
              className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[deal.status] ?? STATUS_CLASSES.open}`}
            >
              {statusText}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!archived && deal.status === "open" && (
              <>
                <Button data-testid="win-button" onClick={handleWin}>
                  Win
                </Button>
                <Dialog open={loseOpen} onOpenChange={setLoseOpen}>
                  <DialogTrigger asChild>
                    <Button data-testid="lose-button" variant="outline">
                      Lose
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <LoseDealDialog dealId={deal.id} onClose={() => setLoseOpen(false)} />
                  </DialogContent>
                </Dialog>
              </>
            )}
            {!archived && deal.status !== "open" && (
              <Button data-testid="reopen-button" variant="outline" onClick={handleReopen}>
                Reopen
              </Button>
            )}
            {!archived && (
              <Button variant="danger" onClick={handleArchive}>
                Archive
              </Button>
            )}
          </div>
        </div>

        <FieldCard
          fields={fields}
          onSave={handleSave}
          archived={archived}
          onUnarchive={handleUnarchive}
          savingField={savingField}
        />

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Expected close</span>
          {/*
            `min-w-0` BECAUSE A DATE INPUT WILL NOT SHRINK. A flex item defaults
            to `min-width: auto`, which floors it at its content's min-content
            width -- and Chromium's date control has an intrinsic one it will
            not go below, so at 320px this wrapper ran 185 to 326 against a
            320px box: 6px over, on the only page in the app that overflowed at
            that width. It used to be swipe-reachable because <main> scrolled
            sideways; components/shell.tsx now clips below the breakpoint so the
            board's stage picker can stick, which turns a swipe into a cut.
            `min-w-0` lets the item shrink and the input's own `max-w-xs` still
            caps it at a desk. The phone standard is anchored at 390 and this
            was never a violation of it -- it is the regression the clip would
            otherwise have introduced.
          */}
          <div data-testid="field-expectedCloseDate" className="min-w-0 flex-1">
            <input
              type="date"
              value={deal.expectedCloseDate ?? ""}
              onChange={(event) => handleExpectedCloseDateChange(event.target.value)}
              disabled={archived}
              className="w-full max-w-xs rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Owner</span>
          <div data-testid="field-ownerUserId" className="max-w-xs flex-1">
            <OwnerSelect value={deal.ownerUserId} onChange={handleOwnerChange} disabled={archived} />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Company</span>
          <div data-testid="field-companyId" className="min-w-0 flex-1 break-words text-sm text-slate-900">
            {deal.companyId === null ? (
              <span>{"\u2014"}</span>
            ) : linkedCompany ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId: linkedCompany.id }}
                className="text-slate-900 underline hover:text-slate-700"
              >
                {linkedCompany.name}
              </Link>
            ) : (
              <span>{"\u2026"}</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Contact</span>
          <div data-testid="field-contactId" className="min-w-0 flex-1 break-words text-sm text-slate-900">
            {deal.contactId === null ? (
              <span>{"\u2014"}</span>
            ) : linkedContact ? (
              <Link
                to="/contacts/$contactId"
                params={{ contactId: linkedContact.id }}
                className="text-slate-900 underline hover:text-slate-700"
              >
                {linkedContact.firstName} {linkedContact.lastName ?? ""}
              </Link>
            ) : (
              <span>{"\u2026"}</span>
            )}
          </div>
        </div>
        <DocumentsSection
          deal={deal}
          companyName={linkedCompany?.name ?? ""}
          contactName={
            linkedContact === undefined
              ? ""
              : `${linkedContact.firstName} ${linkedContact.lastName ?? ""}`.trim()
          }
          // Picked up exactly as the name beside it is, and EMPTY WHEN THE
          // CONTACT HAS NONE -- no guess from the name, and none from anything
          // else. A quote for a contact without a salutation carries none.
          contactSalutation={linkedContact?.salutation ?? ""}
          companyAddress={linkedCompany?.address ?? ""}
          defaultsInFlight={defaultsInFlight}
        />
      </div>
      <aside className="min-w-0 lg:w-1/3">
        <Rail dealId={dealId} />
      </aside>
    </div>
  );
}

/**
 * THE DEAL'S DOCUMENTS SECTION: what has been raised, and the way to raise
 * another.
 *
 * A section on the page rather than a tab in the rail, because the rail is
 * SHARED by the company, contact, deal and project pages and a document belongs
 * to a deal alone -- a sixth tab there would be empty on three of the four.
 *
 * The download is the existing `GET /api/files/:id/download`, reached exactly as
 * the rail's Files tab reaches it. The PDF is an ordinary `files` row against
 * the same deal, so it is already on that tab; there is deliberately no second
 * download path here to keep in step with the first.
 *
 * There is no edit and no delete, and that is the phase's central claim rather
 * than an omission: a quote already issued never changes, and a corrected quote
 * is a new quote with a new number.
 */
function DocumentsSection({
  deal, companyName, contactName, contactSalutation, companyAddress, defaultsInFlight,
}: {
  deal: Deal;
  companyName: string;
  contactName: string;
  contactSalutation: string;
  companyAddress: string;
  defaultsInFlight: boolean;
}) {
  const { data: documents = [], isLoading, error } = useDealDocuments(deal.id);
  const [formOpen, setFormOpen] = useState(false);
  const archived = deal.archivedAt !== null;

  return (
    <div data-testid="deal-documents" className="mt-4 rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-quote-button" disabled={archived}>New quote</Button>
          </DialogTrigger>
          {/*
            An ordinary DialogContent, which ui/dialog.tsx already turns into a
            full-screen sheet below the breakpoint -- pinned to all four edges
            and scrolling its own content, because a dialog centred in the
            LAYOUT viewport is the one thing that cannot work on a phone: the
            on-screen keyboard shrinks the VISUAL viewport under it and takes
            the fields with it. That is also what makes the form's sticky total
            stick.

            Wider than the default card at a desk, because six columns of line
            items do not fit in a 28rem dialog; the cap is lifted below the
            breakpoint by the shape itself.
          */}
          <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
            {formOpen && (
              <DocumentForm
                dealId={deal.id}
                currency={deal.currency}
                defaultRecipientName={companyName}
                defaultRecipientContactName={contactName}
                defaultRecipientSalutation={contactSalutation}
                defaultRecipientAddress={companyAddress}
                defaultsInFlight={defaultsInFlight}
                onIssued={() => setFormOpen(false)}
                onCancel={() => setFormOpen(false)}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="px-4 py-3">
        {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">Could not load documents: {error.message}</p>
        )}
        {!isLoading && !error && documents.length === 0 && (
          <p data-testid="documents-empty" className="text-sm text-slate-400">
            No quotes yet. Raise one with New quote and it is stored on this deal as a PDF.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <li
              key={document.id}
              data-testid={`document-${document.number}`}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 max-md:flex-col max-md:items-stretch"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{document.number}</p>
                <p className="truncate text-xs text-slate-400">
                  {document.issueDate}
                  {document.recipientName === "" ? "" : ` \u2014 ${document.recipientName}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 max-md:justify-between">
                <span data-testid={`document-total-${document.number}`} className="text-sm tabular-nums text-slate-900">
                  {formatMoneyCents(document.totalCents, document.currency)}
                </span>
                {/*
                  A plain anchor, not a Button: this is a navigation to a file
                  the server streams, so it should be a link and not something
                  that looks like one.

                  The 44px floor is spelled out on it, and NOT copied from the
                  rail's own download link -- that one is a bare underlined
                  anchor with no floor at all (components/rail/files.tsx). Said
                  plainly because the obvious comment to write here was "the
                  same way the rail does it", which is false: this is the floor
                  ui/button.tsx and ui/input.tsx carry, applied to an anchor
                  that is neither. The rail's gap is a Phase 6 surface and is
                  left alone rather than widened into by this task.
                */}
                <a
                  href={apiUrl(`/files/${document.fileId}/download`)}
                  data-testid={`document-download-${document.number}`}
                  className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-900 underline hover:bg-slate-50 max-md:min-h-11"
                >
                  Download
                </a>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function LoseDealDialog({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const loseDeal = useLoseDeal();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed === "") return;
    loseDeal.mutate({ id: dealId, reason: trimmed }, { onSuccess: () => onClose() });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>Mark as lost</DialogTitle>
      <Textarea
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (required)"
        rows={3}
        disabled={loseDeal.isPending}
      />
      {loseDeal.isError && <p className="text-sm text-red-600">{loseDeal.error.message}</p>}
      <Button type="submit" disabled={reason.trim() === "" || loseDeal.isPending}>
        Mark lost
      </Button>
    </form>
  );
}
