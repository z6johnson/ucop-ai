/**
 * Enrichment history — a read-only derivation over the changeset store.
 *
 * Answers "when and where was the shared picture last updated?" without
 * adding anything to the canonical schema. Every applied changeset already
 * records `target_version` + `applied_at` and a per-change map keyed by
 * `entity_id.dimension.field`, so per-entity / per-field update dates are
 * fully derivable from the set of applied changesets.
 *
 * Pure reuse of lib/enrich/storage.ts — no new parsing. Consumed by the
 * About page's "Data status" section and the per-field "updated" captions
 * on entity views.
 */

import {
  listChangesetIds,
  readChangeset,
  type Decision,
} from "./storage.ts";
import {
  changeId,
  type Changeset,
  type ChangeKind,
  type ChangesetStatus,
  type EnrichInputsManifest,
  type EnrichTarget,
} from "./types.ts";

export type ChangesetSummary = {
  changeset_id: string;
  target: EnrichTarget;
  status: ChangesetStatus;
  run_date: string;
  /** Which lane applied this — see ChangesetMeta.approval_mode. */
  approval_mode: "human" | "policy";
  policy_id: string;
  reviewed_by: string;
  reviewed_at: string;
  applied_at: string;
  base_version: string;
  target_version: string;
  /** Decision tallies across every change in the set. */
  acceptedCount: number;
  rejectedCount: number;
  reviewCount: number;
  totalCount: number;
  /** Accepted changes counted by dimension. */
  perDimension: Record<string, number>;
  /** Distinct entity ids touched by accepted changes, sorted. */
  touchedEntities: string[];
  inputs_manifest: EnrichInputsManifest;
};

export function summarizeChangeset(
  changeset: Changeset,
  decisions: Record<string, Decision>,
): ChangesetSummary {
  let acceptedCount = 0;
  let rejectedCount = 0;
  let reviewCount = 0;
  const perDimension: Record<string, number> = {};
  const touched = new Set<string>();

  for (const change of changeset.changes) {
    const decision = decisions[changeId(change)] ?? "review";
    if (decision === "accept") {
      acceptedCount += 1;
      perDimension[change.dimension] = (perDimension[change.dimension] ?? 0) + 1;
      touched.add(change.entity_id);
    } else if (decision === "reject") {
      rejectedCount += 1;
    } else {
      reviewCount += 1;
    }
  }

  return {
    changeset_id: changeset.changeset_id,
    target: changeset.target,
    status: changeset.status,
    run_date: changeset.run_date,
    approval_mode: changeset.approval_mode,
    policy_id: changeset.policy_id,
    reviewed_by: changeset.reviewed_by,
    reviewed_at: changeset.reviewed_at,
    applied_at: changeset.applied_at,
    base_version: changeset.base_version,
    target_version: changeset.target_version,
    acceptedCount,
    rejectedCount,
    reviewCount,
    totalCount: changeset.changes.length,
    perDimension,
    touchedEntities: [...touched].sort(),
    inputs_manifest: changeset.inputs_manifest,
  };
}

/** Every changeset on disk, summarized. */
export function listChangesetSummaries(repoRoot: string): ChangesetSummary[] {
  const out: ChangesetSummary[] = [];
  for (const id of listChangesetIds(repoRoot)) {
    const parsed = readChangeset(repoRoot, id);
    if (parsed) out.push(summarizeChangeset(parsed.changeset, parsed.decisions));
  }
  return out;
}

/** Drafts awaiting human review — the "a refresh is pending" signal. */
export function pendingChangesets(repoRoot: string): ChangesetSummary[] {
  return listChangesetSummaries(repoRoot)
    .filter((s) => s.status === "draft")
    .sort((a, b) => b.run_date.localeCompare(a.run_date));
}

/** Applied refreshes, newest first. */
export function appliedChangesets(repoRoot: string): ChangesetSummary[] {
  return listChangesetSummaries(repoRoot)
    .filter((s) => s.status === "applied")
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at));
}

/* ------------------------------------------------------------------ */
/* Derived "last updated" indices                                      */
/* ------------------------------------------------------------------ */

export type FieldUpdate = {
  /** target_version of the applied changeset that last touched this field. */
  version: string;
  /** applied_at ISO timestamp of that changeset. */
  applied_at: string;
  change_kind: ChangeKind;
};

/**
 * Most-recent applied update per `entity_id.dimension.field`, derived from
 * accepted changes in applied changesets. Fields never touched by a tracked
 * refresh are absent — callers fall back to baseline `metadata.created`.
 */
export function fieldLastUpdatedIndex(repoRoot: string): Map<string, FieldUpdate> {
  const index = new Map<string, FieldUpdate>();
  for (const id of listChangesetIds(repoRoot)) {
    const parsed = readChangeset(repoRoot, id);
    if (!parsed || parsed.changeset.status !== "applied") continue;
    const { changeset, decisions } = parsed;
    for (const change of changeset.changes) {
      if (decisions[changeId(change)] !== "accept") continue;
      const key = changeId(change);
      const next: FieldUpdate = {
        version: changeset.target_version,
        applied_at: changeset.applied_at,
        change_kind: change.change_kind,
      };
      const prev = index.get(key);
      if (!prev || prev.applied_at < next.applied_at) index.set(key, next);
    }
  }
  return index;
}

/** Coarser per-entity index: the most recent applied update touching it. */
export function entityLastUpdatedIndex(repoRoot: string): Map<string, FieldUpdate> {
  const index = new Map<string, FieldUpdate>();
  for (const [key, update] of fieldLastUpdatedIndex(repoRoot)) {
    const entityId = key.slice(0, key.indexOf("."));
    const prev = index.get(entityId);
    if (!prev || prev.applied_at < update.applied_at) index.set(entityId, update);
  }
  return index;
}
