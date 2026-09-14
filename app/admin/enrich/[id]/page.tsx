import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewQueue } from "@/components/enrich/ReviewQueue";
import { DIMENSION_LABEL, listEntities } from "@/lib/baseline";
import { listPeers } from "@/lib/peers";
import { toReviewChange } from "@/lib/enrich/review";
import { loadChangeset } from "@/lib/enrich/source";

// Read through the GitHub API on every request: a decision saved a moment ago
// must be visible now, not after the next Vercel build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TARGET_LABEL = {
  baseline: "UC baseline",
  peer: "Peer baseline",
  committee: "Committee records",
} as const;

export default async function ReviewChangesetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadChangeset(id);
  if (!loaded) notFound();

  const { changeset, decisions } = loaded.parsed;
  const changes = changeset.changes.map(toReviewChange);

  // Entity names are resolved here so the client bundle doesn't pull in the
  // baseline JSON just to render a heading.
  const entityNames: Record<string, string> = {};
  for (const e of listEntities()) entityNames[e.entity_id] = e.entity_name;
  if (changeset.target === "peer") {
    for (const p of listPeers()) entityNames[p.entity_id] = p.entity_name;
  }

  const isDraft = changeset.status === "draft";
  const isPolicy = changeset.approval_mode === "policy";
  const readOnly = !isDraft || isPolicy;

  return (
    <div className="mt-10">
      <Link href="/admin/enrich" className="label" style={{ color: "var(--color-accent)" }}>
        ← All refreshes
      </Link>

      <div className="hairline mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-3">
        <h1 className="display" style={{ fontSize: "var(--text-2xl)" }}>
          {TARGET_LABEL[changeset.target]}
          <span className="label ml-3" style={{ color: "var(--color-text-subtle)" }}>
            {changeset.changeset_id}
          </span>
        </h1>
        <span className="label">run {changeset.run_date}</span>
      </div>

      {isPolicy ? (
        <p
          className="prose-body mt-4 max-w-2xl rounded p-3 text-sm"
          style={{
            background: "var(--color-surface-muted, rgba(0,0,0,0.04))",
            color: "var(--color-text-muted)",
          }}
        >
          These changes were applied automatically under policy{" "}
          <code>{changeset.policy_id}</code> — nobody reviewed them. This page is the
          audit record. If something here is wrong, it is already live in the baseline.
        </p>
      ) : null}

      {!isDraft && !isPolicy ? (
        <p className="mt-4 text-sm" style={{ color: "var(--color-text-muted)" }}>
          Applied {changeset.applied_at.slice(0, 10)} by {changeset.reviewed_by || "—"}
          {changeset.target_version ? ` · published as v${changeset.target_version}` : ""}.
          Decisions are frozen.
        </p>
      ) : null}

      {isDraft && !isPolicy ? (
        <p
          className="prose-body mt-4 max-w-2xl text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Nothing here has touched the baseline. Approve what should be published,
          decline what should not, and save — declining is remembered, so a proposal you
          turn down will not come back next month unless the evidence changes.
        </p>
      ) : null}

      {changeset.inputs_manifest.suppressed ? (
        <p className="mt-2 text-xs" style={{ color: "var(--color-text-subtle)" }}>
          {changeset.inputs_manifest.suppressed} further proposal
          {changeset.inputs_manifest.suppressed === 1 ? " was" : "s were"} withheld because you
          already declined {changeset.inputs_manifest.suppressed === 1 ? "it" : "them"} in
          identical form — see <code>{changeset.changeset_id}.suppressed.json</code>.
        </p>
      ) : null}

      {changes.length === 0 ? (
        <p className="mt-8 text-sm" style={{ color: "var(--color-text-subtle)" }}>
          This changeset contains no proposals.
        </p>
      ) : (
        <div className="mt-8">
          <ReviewQueue
            changesetId={changeset.changeset_id}
            changes={changes}
            initialDecisions={decisions}
            initialSha={loaded.sha}
            entityNames={entityNames}
            dimensionLabels={DIMENSION_LABEL}
            readOnly={readOnly}
            publish={
              readOnly
                ? undefined
                : {
                    targetLabel: TARGET_LABEL[changeset.target],
                    baseVersion: changeset.base_version,
                  }
            }
          />
        </div>
      )}
    </div>
  );
}
