/**
 * View model for the review queue.
 *
 * Pure and client-safe: no node builtins, no lib/baseline import (entity and
 * dimension labels arrive as props, resolved on the server). Everything here
 * is a plain function over ProposedChange so it can be unit-tested without a
 * DOM and shared by the server page and the client component.
 */

import type { Decision } from "./changeset-format.ts";
import { changeId, type ChangeKind, type ProposedChange } from "./types.ts";

export type ReviewChange = {
  id: string;
  entity_id: string;
  dimension: string;
  field: string;
  kind: ChangeKind;
  confidence: "high" | "medium" | "low";
  /** The canonical value this would replace; undefined when the field is new. */
  currentValue?: boolean | string | number | null;
  proposedValue: boolean | string | number | null;
  sourceId: string | null;
  sourceUrl: string | null;
  notes: string | null;
  flags: string[];
  /**
   * The source that backs the value being replaced. For a dead-source sweep
   * this is the link that went missing, which is what makes those proposals
   * groupable — one broken URL explains a whole cluster of them.
   */
  currentSourceId: string | null;
};

export function toReviewChange(c: ProposedChange): ReviewChange {
  return {
    id: changeId(c),
    entity_id: c.entity_id,
    dimension: c.dimension,
    field: c.field,
    kind: c.change_kind,
    confidence: c.confidence,
    currentValue: c.current_record ? c.current_record.value : undefined,
    proposedValue: c.record.value,
    sourceId: c.record.source_id,
    sourceUrl: c.record.source_url,
    notes: c.record.notes,
    flags: c.validation_reasons,
    currentSourceId: c.current_record?.source_id ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export type QueueFilter = {
  kind?: ChangeKind | "all";
  confidence?: "high" | "medium" | "low" | "all";
  dimension?: string | "all";
  entity?: string | "all";
  decision?: Decision | "all" | "undecided";
  /** Case-insensitive substring over entity/field/notes. */
  search?: string;
};

export function filterChanges(
  items: ReviewChange[],
  filter: QueueFilter,
  decisions: Record<string, Decision>,
): ReviewChange[] {
  const needle = filter.search?.trim().toLowerCase();
  return items.filter((c) => {
    if (filter.kind && filter.kind !== "all" && c.kind !== filter.kind) return false;
    if (filter.confidence && filter.confidence !== "all" && c.confidence !== filter.confidence) {
      return false;
    }
    if (filter.dimension && filter.dimension !== "all" && c.dimension !== filter.dimension) {
      return false;
    }
    if (filter.entity && filter.entity !== "all" && c.entity_id !== filter.entity) return false;

    if (filter.decision && filter.decision !== "all") {
      const d = decisions[c.id] ?? "review";
      if (filter.decision === "undecided" ? d !== "review" : d !== filter.decision) return false;
    }

    if (needle) {
      const hay = `${c.entity_id} ${c.dimension} ${c.field} ${c.notes ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

export type QueueCounts = {
  accept: number;
  reject: number;
  review: number;
  total: number;
};

export function queueCounts(
  items: ReviewChange[],
  decisions: Record<string, Decision>,
): QueueCounts {
  const counts: QueueCounts = { accept: 0, reject: 0, review: 0, total: items.length };
  for (const c of items) counts[decisions[c.id] ?? "review"] += 1;
  return counts;
}

/** Distinct values present in the queue, for building filter chips. */
export function facets(items: ReviewChange[]): {
  kinds: ChangeKind[];
  dimensions: string[];
  entities: string[];
  confidences: Array<"high" | "medium" | "low">;
} {
  const kinds = new Set<ChangeKind>();
  const dimensions = new Set<string>();
  const entities = new Set<string>();
  const confidences = new Set<"high" | "medium" | "low">();
  for (const c of items) {
    kinds.add(c.kind);
    dimensions.add(c.dimension);
    entities.add(c.entity_id);
    confidences.add(c.confidence);
  }
  return {
    kinds: [...kinds].sort(),
    dimensions: [...dimensions].sort(),
    entities: [...entities].sort(),
    confidences: (["high", "medium", "low"] as const).filter((c) => confidences.has(c)),
  };
}

/* ------------------------------------------------------------------ */
/* Dead-source grouping                                                */
/* ------------------------------------------------------------------ */

export const UNGROUPED = "__ungrouped__";

/**
 * Buckets `newly_absent` proposals by the source that went missing.
 *
 * These arrive in clusters — one broken campus URL backs a dozen fields, so
 * the sweep proposes a dozen separate absences that are really one question:
 * "is this page actually gone?" Answering it once and fanning the decision
 * across the bucket is the difference between 40 decisions and 8. Everything
 * else stays individual, under UNGROUPED, because those proposals are
 * genuinely independent.
 */
export function groupByDeadSource(items: ReviewChange[]): Map<string, ReviewChange[]> {
  const groups = new Map<string, ReviewChange[]>();
  for (const c of items) {
    const key =
      c.kind === "newly_absent" && c.currentSourceId ? c.currentSourceId : UNGROUPED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export const KIND_LABEL: Record<ChangeKind, string> = {
  new_field: "New field",
  changed_value: "Value changed",
  unchanged_confirmed: "Re-confirmed",
  newly_contradicted: "Contradicted",
  newly_absent: "Source gone",
};

/** One line saying what accepting this change would actually do. */
export function kindExplanation(c: ReviewChange): string {
  switch (c.kind) {
    case "new_field":
      return "Records a fact the baseline does not currently hold.";
    case "changed_value":
      return "Overwrites the current value with a different one.";
    case "unchanged_confirmed":
      return "Re-confirms the current value against a live source.";
    case "newly_contradicted":
      return "A live source now contradicts what the baseline asserts.";
    case "newly_absent":
      return "The source backing the current value returned 404 — this records the claim as no longer publicly verifiable.";
  }
}

export function formatValue(v: boolean | string | number | null | undefined): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v.length > 0 ? v : '""';
  return String(v);
}
