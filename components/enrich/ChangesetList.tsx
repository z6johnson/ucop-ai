import Link from "next/link";

import { DIMENSION_LABEL, type DimensionId } from "@/lib/baseline";
import type { ChangesetSummary } from "@/lib/enrich/history";

const TARGET_LABEL: Record<ChangesetSummary["target"], string> = {
  baseline: "UC baseline",
  peer: "Peer baseline",
  committee: "Committee records",
};

function dimensionLabel(id: string): string {
  return DIMENSION_LABEL[id as DimensionId] ?? id;
}

function perDimensionText(perDimension: Record<string, number>): string {
  const parts = Object.entries(perDimension)
    .sort((a, b) => b[1] - a[1])
    .map(([dim, n]) => `${dimensionLabel(dim)} ${n}`);
  return parts.length > 0 ? parts.join(" · ") : "no fields";
}

/* ------------------------------------------------------------------ */
/* Pending (draft) rows — awaiting human review                        */
/* ------------------------------------------------------------------ */

export function PendingList({ items }: { items: ChangesetSummary[] }) {
  if (items.length === 0) {
    return (
      <p className="mt-4 text-sm" style={{ color: "var(--color-text-subtle)" }}>
        Nothing awaiting review. Every produced changeset has been applied or
        declined.
      </p>
    );
  }
  return (
    <ul className="mt-4 flex flex-col">
      {items.map((cs) => (
        <li key={cs.changeset_id} className="hairline py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="display" style={{ fontSize: "var(--text-lg)" }}>
              {TARGET_LABEL[cs.target]}
              <span
                className="label ml-3"
                style={{ color: "var(--color-warn-strong)" }}
              >
                Draft · awaiting review
              </span>
            </h3>
            <span className="label">run {cs.run_date}</span>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
            {cs.acceptedCount} of {cs.totalCount} change
            {cs.totalCount === 1 ? "" : "s"} ready to apply
            {cs.reviewCount > 0 ? ` · ${cs.reviewCount} still need a decision` : ""}
            {cs.rejectedCount > 0 ? ` · ${cs.rejectedCount} declined` : ""}.
          </p>
          <p className="mt-2 text-sm">
            <Link
              href={`/admin/enrich/${cs.changeset_id}`}
              style={{ color: "var(--color-accent)" }}
            >
              Review and publish →
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Applied rows — the refresh history                                  */
/* ------------------------------------------------------------------ */

export function AppliedList({ items }: { items: ChangesetSummary[] }) {
  if (items.length === 0) {
    return (
      <p className="mt-4 text-sm" style={{ color: "var(--color-text-subtle)" }}>
        No tracked refreshes applied yet. Earlier baseline history lives in{" "}
        <code>data/ENRICHMENT_LOG.md</code>.
      </p>
    );
  }
  return (
    <ul className="mt-4 flex flex-col">
      {items.map((cs) => (
        <li key={cs.changeset_id} className="hairline py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="display" style={{ fontSize: "var(--text-lg)" }}>
              {TARGET_LABEL[cs.target]}
              {cs.target_version ? (
                <span className="label ml-3" style={{ color: "var(--color-accent)" }}>
                  v{cs.target_version}
                </span>
              ) : null}
            </h3>
            <span className="label">
              applied {cs.applied_at ? cs.applied_at.slice(0, 10) : cs.run_date}
            </span>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
            {cs.acceptedCount} field{cs.acceptedCount === 1 ? "" : "s"} updated
            {" · "}
            {perDimensionText(cs.perDimension)}
          </p>
          {cs.touchedEntities.length > 0 ? (
            <p
              className="mt-1 text-xs"
              style={{ color: "var(--color-text-subtle)" }}
            >
              Entities: {cs.touchedEntities.join(", ")}
            </p>
          ) : null}
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-subtle)" }}
          >
            {cs.base_version ? `from v${cs.base_version} · ` : ""}
            {/* Never conflate the two lanes — "reviewed by" has to mean it. */}
            {cs.approval_mode === "policy" ? (
              <span style={{ color: "var(--color-warn-strong)" }}>
                published automatically · policy {cs.policy_id || "—"} · no human review
              </span>
            ) : (
              <span style={{ color: "var(--color-accent)" }}>
                reviewed by {cs.reviewed_by || "—"}
              </span>
            )}
            {cs.rejectedCount > 0 ? ` · ${cs.rejectedCount} declined` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
