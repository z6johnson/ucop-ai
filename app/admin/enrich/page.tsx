import Link from "next/link";

import type { ChangesetSummary } from "@/lib/enrich/history";
import { allChangesetSummaries } from "@/lib/enrich/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TARGET_LABEL = {
  baseline: "UC baseline",
  peer: "Peer baseline",
  committee: "Committee records",
} as const;

function Row({ cs, children }: { cs: ChangesetSummary; children: React.ReactNode }) {
  return (
    <li className="hairline py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="display" style={{ fontSize: "var(--text-lg)" }}>
          <Link
            href={`/admin/enrich/${cs.changeset_id}`}
            style={{ color: "var(--color-accent)" }}
          >
            {TARGET_LABEL[cs.target]}
          </Link>
          <span className="label ml-3" style={{ color: "var(--color-text-subtle)" }}>
            {cs.changeset_id}
          </span>
        </h3>
        <span className="label">run {cs.run_date}</span>
      </div>
      {children}
    </li>
  );
}

export default async function EnrichIndexPage() {
  const all = await allChangesetSummaries();

  const pending = all
    .filter((s) => s.status === "draft" && s.approval_mode === "human")
    .sort((a, b) => b.run_date.localeCompare(a.run_date));
  const autoApplied = all
    .filter((s) => s.status === "applied" && s.approval_mode === "policy")
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at))
    .slice(0, 10);
  const humanApplied = all
    .filter((s) => s.status === "applied" && s.approval_mode === "human")
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at));

  const undecided = pending.reduce((n, s) => n + s.reviewCount, 0);

  return (
    <div className="mt-10">
      <div className="hairline flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-3">
        <h1 className="display" style={{ fontSize: "var(--text-2xl)" }}>
          Enrichment review
        </h1>
        <span className="label">
          {undecided > 0 ? `${undecided} awaiting a decision` : "nothing awaiting review"}
        </span>
      </div>

      <p className="prose-body mt-4 max-w-2xl text-sm" style={{ color: "var(--color-text-muted)" }}>
        The monthly run proposes changes; it never publishes them. Approve what belongs in
        the baseline and publish from the changeset page.
      </p>

      <section className="mt-10">
        <h2 className="display" style={{ fontSize: "var(--text-lg)" }}>
          Needs your review
          {pending.length > 0 ? (
            <span className="label ml-3" style={{ color: "var(--color-warn-strong)" }}>
              {pending.length} pending
            </span>
          ) : null}
        </h2>
        {pending.length === 0 ? (
          <p className="mt-4 text-sm" style={{ color: "var(--color-text-subtle)" }}>
            Nothing waiting. Every proposal has been decided.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col">
            {pending.map((cs) => (
              <Row key={cs.changeset_id} cs={cs}>
                <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {cs.reviewCount > 0 ? (
                    <strong style={{ color: "var(--color-warn-strong)" }}>
                      {cs.reviewCount} undecided
                    </strong>
                  ) : (
                    <strong style={{ color: "var(--color-accent)" }}>ready to publish</strong>
                  )}
                  {" · "}
                  {cs.acceptedCount} approved · {cs.rejectedCount} declined · {cs.totalCount} total
                </p>
                {cs.inputs_manifest.suppressed ? (
                  <p className="mt-1 text-xs" style={{ color: "var(--color-text-subtle)" }}>
                    {cs.inputs_manifest.suppressed} withheld as already declined
                  </p>
                ) : null}
              </Row>
            ))}
          </ul>
        )}
      </section>

      {autoApplied.length > 0 ? (
        <section className="mt-12">
          <h2 className="display" style={{ fontSize: "var(--text-lg)" }}>
            Published automatically
            <span className="label ml-3" style={{ color: "var(--color-warn-strong)" }}>
              no human sign-off
            </span>
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--color-text-muted)" }}>
            Low-risk changes that met policy and went live unattended. Worth a glance —
            anything wrong here is already in the baseline.
          </p>
          <ul className="mt-4 flex flex-col">
            {autoApplied.map((cs) => (
              <Row key={cs.changeset_id} cs={cs}>
                <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {cs.acceptedCount} field{cs.acceptedCount === 1 ? "" : "s"} updated ·{" "}
                  policy <code>{cs.policy_id}</code>
                  {cs.applied_at ? ` · ${cs.applied_at.slice(0, 10)}` : ""}
                </p>
              </Row>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-12">
        <h2 className="display" style={{ fontSize: "var(--text-lg)" }}>
          Published after review
        </h2>
        {humanApplied.length === 0 ? (
          <p className="mt-4 text-sm" style={{ color: "var(--color-text-subtle)" }}>
            No reviewed refreshes yet. Earlier history lives in{" "}
            <code>data/ENRICHMENT_LOG.md</code>.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col">
            {humanApplied.map((cs) => (
              <Row key={cs.changeset_id} cs={cs}>
                <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {cs.acceptedCount} field{cs.acceptedCount === 1 ? "" : "s"} updated
                  {cs.target_version ? ` · v${cs.target_version}` : ""} · reviewed by{" "}
                  {cs.reviewed_by || "—"}
                  {cs.rejectedCount > 0 ? ` · ${cs.rejectedCount} declined` : ""}
                </p>
              </Row>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
