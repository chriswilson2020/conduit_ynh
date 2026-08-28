import { useMemo } from "react";
import { formatMoneyCents } from "@conduit/shared";
import { useDeals, useFunnel, usePipeline } from "../queries";

/**
 * Per-pipeline funnel: one horizontal-bar row per stage, in board column
 * order, showing that stage's open deal count and value. Pulls its own data
 * (usePipeline for stage order/names, useFunnel for the per-stage
 * count/valueCents aggregate, useDeals for currency -- see the comment on
 * `currency` below) so the board page only needs to mount `<Funnel
 * pipelineId={...} />` behind its view toggle, the same way `<Rail
 * dealId={...} />` is self-contained on the deal detail page.
 */
export function Funnel({ pipelineId }: { pipelineId: string }) {
  const { data: pipelineData } = usePipeline(pipelineId);
  const { data: funnelRows } = useFunnel(pipelineId);
  const { data: dealsData } = useDeals(pipelineId);

  const rowsByStage = useMemo(
    () => new Map((funnelRows ?? []).map((row) => [row.stageId, row])),
    [funnelRows],
  );

  // funnelRowSchema carries no currency (funnel() sums raw valueCents across
  // whatever currencies are present server-side, see its doc comment in
  // services/deals.ts) -- so the currency used to format every row here is
  // read off the same open deals the funnel counts describe. Mirrors
  // board.tsx Column's mixed-currency guard: a single Conduit instance has
  // one DEFAULT_CURRENCY in practice, so "mixed" is a defensive fallback,
  // not the common case, and it applies to the whole funnel at once rather
  // than per stage -- one dominant currency for the pipeline, or "mixed".
  const openDeals = useMemo(() => (dealsData ?? []).filter((deal) => deal.status === "open"), [dealsData]);
  const currencies = new Set(openDeals.map((deal) => deal.currency));
  const mixed = currencies.size > 1;
  const currency = openDeals[0]?.currency ?? "EUR";
  const formatValue = (valueCents: number) =>
    mixed ? "mixed" : formatMoneyCents(valueCents, currency);

  if (!pipelineData) return null;
  const { stages } = pipelineData;

  const maxValueCents = Math.max(0, ...stages.map((stage) => rowsByStage.get(stage.id)?.valueCents ?? 0));
  const maxCount = Math.max(0, ...stages.map((stage) => rowsByStage.get(stage.id)?.count ?? 0));
  // Every stage sits at zero value (a brand-new pipeline, or one where no
  // deal has a value set) -- fall back to a count-based bar so the row isn't
  // just a flat empty track for every stage.
  const useCountForWidth = maxValueCents === 0;

  return (
    <div data-testid="funnel" className="flex flex-col gap-2">
      {stages.map((stage) => {
        const row = rowsByStage.get(stage.id);
        const count = row?.count ?? 0;
        const valueCents = row?.valueCents ?? 0;
        const widthPct = useCountForWidth
          ? (maxCount === 0 ? 0 : (count / maxCount) * 100)
          : (valueCents / maxValueCents) * 100;

        return (
          /* THE ROW WRAPS BELOW THE BREAKPOINT, because its four columns do not
             fit and the one that gives way is the bar.

             Measured at 375px before this: the three fixed columns (160 + 48 +
             112) plus padding and gaps come to 368px inside <main>'s 327px
             content box, so the flex-1 track was squeezed to ZERO and the value
             column was pushed out of the box -- a funnel with no bars, which is
             the whole of what a funnel is.

             BE ACCURATE ABOUT WHERE THE OVERFLOW WENT, because an earlier
             version of this paragraph was not and a reviewer measured it: the
             DOCUMENT did not scroll sideways, but <main> did. It reported
             scrollWidth 393 against clientWidth 375 with overflow-x auto, and
             setting its scrollLeft revealed the value column in full. So the
             numbers were reachable by a sideways scroll of the content region
             that nothing on the page signalled -- worse than plainly absent for
             being deniable, but not absent.

             The stage name takes its own line and the bar keeps the second one,
             which is the arrangement that gives the track the most width: the
             names are short and the comparison between stages is the point. The
             count loses its fixed 48px too -- a right-aligned integer needs no
             column -- so the track ends up around 150px rather than 50px. All
             three are `max-md:`, so the desk keeps the single-line row it has
             had since Phase 2. The board's own kanban does not render at this
             width at all (see pages/board.tsx), so this and the stage view are
             the two things a phone sees of a pipeline. */
          <div
            key={stage.id}
            data-testid={`funnel-row-${stage.id}`}
            className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 max-md:flex-wrap"
          >
            <span className="w-40 shrink-0 truncate text-sm font-medium text-slate-900 max-md:w-full">
              {stage.name}
            </span>
            <div className="h-5 flex-1 rounded bg-slate-100">
              <div className="h-5 rounded bg-slate-700" style={{ width: `${widthPct}%` }} />
            </div>
            <span className="w-12 shrink-0 text-right text-xs text-slate-500 max-md:w-auto">{count}</span>
            <span className="w-28 shrink-0 text-right text-xs font-medium text-slate-700">
              {formatValue(valueCents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
