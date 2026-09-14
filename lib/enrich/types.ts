/**
 * Shared contract for the monthly baseline-enrichment pipeline.
 *
 * The pipeline keeps the authoritative "shared picture" (the UC baseline,
 * the peer baseline, and the committee directory) fresh by PROPOSING
 * changes a human reviews before any canonical value moves. This module
 * defines the candidate / change / changeset types that flow through
 * fetch → discover → extract → validate → diff → storage → apply.
 *
 * It deliberately reuses FieldRecord / DimensionId / DIMENSION_IDS from
 * lib/baseline.ts so a candidate is shaped exactly like a baseline field.
 *
 * No "server-only" import: consumed by Node CLI scripts under
 * --experimental-strip-types, like lib/activity.ts and lib/brief/*.
 */

import type { FieldRecord } from "../baseline.ts";

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The three data surfaces the pipeline refreshes. `baseline` is the UC
 * shared picture (data/uc_ai_baseline.json); `peer` is the benchmark
 * (data/peer_ai_baseline.json); `committee` re-verifies the structured
 * member records (data/ucnfi-committee/records/).
 */
export type EnrichTarget = "baseline" | "peer" | "committee";

export const ENRICH_TARGETS: readonly EnrichTarget[] = [
  "baseline",
  "peer",
  "committee",
] as const;

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** One entry from data/inventory_urls.json (or a peer/committee source list). */
export type InventorySource = {
  id: string;
  title: string;
  url: string;
  type: "pdf" | "web";
  date: string;
  issuer: string;
};

/** A source surfaced this run by the discovery sweep (web_search). */
export type DiscoveredArtifact = {
  /** Synthetic source id, e.g. `disc-uc_merced-2026-06-1`. */
  source_id: string;
  entity_id: string;
  /** A DimensionId for baseline/peer; a record section for committee. */
  dimension: string;
  title: string;
  url: string;
  published_at: string | null;
  issuer: string;
  snippet: string;
  why_relevant: string;
};

/**
 * The full set of sources Claude was actually given for a run, keyed by
 * source_url. The validator rejects any candidate whose source_url is not
 * in this set — the core anti-hallucination gate (no imagined citations).
 */
export type SourceSet = Map<string, { source_id: string; url: string }>;

/* ------------------------------------------------------------------ */
/* Candidates & changes                                                */
/* ------------------------------------------------------------------ */

/**
 * A single proposed FieldRecord, fully provenanced, before validation.
 *
 * For the baseline/peer targets, `dimension` MUST be one of DIMENSION_IDS
 * and `field` is a snake_case field name (e.g. `has_ai_council`) — this is
 * enforced by the validator, not the type. For the committee target,
 * `dimension` is a record section (e.g. `profile`) and `field` is a dotted
 * path into the member record (e.g. `primary_affiliation.title`).
 */
export type CandidateField = {
  entity_id: string;
  dimension: string;
  field: string;
  record: FieldRecord;
  /** The inventory id or discovered id whose URL backs this candidate. */
  source_artifact_id: string;
  confidence: "high" | "medium" | "low";
};

/** Classification of a candidate against the current canonical value. */
export type ChangeKind =
  | "new_field" // dimension/field absent in the target → additive
  | "changed_value" // field exists, value differs → human-gated mutation
  | "unchanged_confirmed" // field exists, same value → re-confirmation
  | "newly_contradicted" // was true/positive, a live source now shows false/equivocal
  | "newly_absent"; // was true, the backing source went dead → propose value:false gap

export type ChangeStatus = "accepted" | "rejected" | "needs_human";

export type ProposedChange = CandidateField & {
  change_kind: ChangeKind;
  /** The canonical record this would replace; null for new_field. */
  current_record: FieldRecord | null;
  status: ChangeStatus;
  validation_reasons: string[];
};

/* ------------------------------------------------------------------ */
/* Changesets                                                          */
/* ------------------------------------------------------------------ */

export type ChangesetStatus = "draft" | "applied" | "discarded";

export type EnrichInputsManifest = {
  sources_refreshed: number;
  sources_unchanged: number;
  sources_changed: number;
  /** Sources that 404/410'd past DEAD_THRESHOLD — the only kind that may imply absence. */
  sources_dead: number;
  /**
   * Sources persistently refused by a bot wall (401/403/429). Reported so a
   * long-blocked source is visible and can be checked by hand; never treated
   * as evidence the document is gone. Optional for back-compat with
   * changesets written before the distinction existed.
   */
  sources_blocked?: number;
  sources_discovered: number;
  entities_swept: number;
  dimensions_swept: number;
  /**
   * Proposals withheld because an identical one was already declined — see
   * lib/enrich/decisions.ts. Optional for back-compat.
   */
  suppressed?: number;
};

export type ChangesetMeta = {
  /** `YYYY-MM` for the baseline target, `YYYY-MM-peer` / `-committee` otherwise. */
  changeset_id: string;
  target: EnrichTarget;
  run_date: string; // ISO date (YYYY-MM-DD), UTC
  status: ChangesetStatus;
  /**
   * Who is accountable for applying this changeset.
   *
   * `human` — a person reviewed it and `reviewed_by` names them. This is the
   * only mode that may carry a value mutation.
   *
   * `policy` — every change in it was auto-eligible under `policy_id`, and it
   * applied unattended. Kept as a distinct mode rather than writing a fake
   * name into `reviewed_by`, so the audit trail never claims a review that
   * did not happen. apply.ts re-derives eligibility at apply time instead of
   * trusting this field.
   */
  approval_mode: "human" | "policy";
  /** The policy version that authorised a `policy` changeset; "" when human. */
  policy_id: string;
  reviewed_by: string; // empty in draft (the human-accountable gate)
  reviewed_at: string; // empty in draft
  applied_at: string; // empty until apply
  generated_at: string;
  generated_by_model: string;
  base_version: string; // version this was diffed against, e.g. "0.7.0"
  target_version: string; // version on apply, e.g. "0.8.0" (empty until apply)
  inputs_manifest: EnrichInputsManifest;
};

export type Changeset = ChangesetMeta & { changes: ProposedChange[] };

/** A stable per-change key used in the markdown body and frontmatter. */
export function changeId(c: Pick<CandidateField, "entity_id" | "dimension" | "field">): string {
  return `${c.entity_id}.${c.dimension}.${c.field}`;
}
