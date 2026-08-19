import { useMemo } from "react";
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
    mixed ? "mixed" : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(valueCents / 100);

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
          <div
            key={stage.id}
            data-testid={`funnel-row-${stage.id}`}
            className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2"
          >
            <span className="w-40 shrink-0 truncate text-sm font-medium text-slate-900">{stage.name}</span>
            <div className="h-5 flex-1 rounded bg-slate-100">
              <div className="h-5 rounded bg-slate-700" style={{ width: `${widthPct}%` }} />
            </div>
            <span className="w-12 shrink-0 text-right text-xs text-slate-500">{count}</span>
            <span className="w-28 shrink-0 text-right text-xs font-medium text-slate-700">
              {formatValue(valueCents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
