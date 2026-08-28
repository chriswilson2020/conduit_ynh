import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { UpdateDealInput } from "@conduit/shared";
import { formatMoneyCents } from "@conduit/shared";
import { ApiError } from "../api";
import { parseDecimal } from "../lib";
import {
  useArchiveDeal,
  useCompany,
  useContact,
  useDeal,
  useLoseDeal,
  usePipeline,
  useReopenDeal,
  useUnarchiveDeal,
  useUpdateDeal,
  useWinDeal,
} from "../queries";
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
  const { data: linkedCompany } = useCompany(deal?.companyId ?? "");
  const { data: linkedContact } = useContact(deal?.contactId ?? "");
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

        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">{deal.title}</h1>
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
          <div data-testid="field-expectedCloseDate" className="flex-1">
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
          <div data-testid="field-companyId" className="flex-1 text-sm text-slate-900">
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
          <div data-testid="field-contactId" className="flex-1 text-sm text-slate-900">
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
      </div>
      <aside className="min-w-0 lg:w-1/3">
        <Rail dealId={dealId} />
      </aside>
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
