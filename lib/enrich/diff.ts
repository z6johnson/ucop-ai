/**
 * Candidate → ProposedChange classifier.
 *
 * Pure functions, no I/O. Given a validated CandidateField and the target's
 * current canonical record, classify the delta into one of five ChangeKinds
 * and decide whether it may be auto-accepted or must go to a human.
 *
 * Governance rule (the core guard): only purely ADDITIVE changes
 * (new_field) and re-confirmations (unchanged_confirmed) of high confidence
 * may be auto-`accepted`. ANY mutation of an existing canonical value —
 * changed_value, newly_contradicted, newly_absent — is forced to
 * `needs_human`, even when otherwise clean. The pipeline can propose
 * flipping a false→true, but never does it unattended.
 */

import type { FieldRecord } from "../baseline.ts";
import type {
  CandidateField,
  ChangeKind,
  ChangeStatus,
  EnrichTarget,
  ProposedChange,
} from "./types.ts";

/**
 * Marks a candidate that came from a dead-link sweep: the source that backs
 * the existing value went dead, so we propose recording the absence.
 */
export type DiffContext = {
  /** True when this candidate represents a dead backing source. */
  fromDeadSource?: boolean;
};

function valuesEqual(a: FieldRecord["value"], b: FieldRecord["value"]): boolean {
  return a === b;
}

/** Was the prior canonical value a positive assertion (true / non-empty string)? */
function isPositive(v: FieldRecord["value"]): boolean {
  if (v === true) return true;
  if (typeof v === "string") return v.length > 0 && v !== "false" && v !== "absent";
  if (typeof v === "number") return v !== 0;
  return false;
}

/** Is the candidate value a contradiction of a prior positive (false/equivocal)? */
function isContradiction(v: FieldRecord["value"]): boolean {
  return v === false || v === "equivocal" || v === "absent";
}

export function classifyKind(
  current: FieldRecord | null,
  candidate: CandidateField,
  ctx: DiffContext = {},
): ChangeKind {
  if (!current) return "new_field";
  if (valuesEqual(current.value, candidate.record.value)) return "unchanged_confirmed";
  if (ctx.fromDeadSource && isPositive(current.value)) return "newly_absent";
  if (isPositive(current.value) && isContradiction(candidate.record.value)) {
    return "newly_contradicted";
  }
  return "changed_value";
}

/* ------------------------------------------------------------------ */
/* Risk policy                                                         */
/* ------------------------------------------------------------------ */

/**
 * Version of the auto-publish rules below. Recorded on any changeset applied
 * without a human, so it is always answerable which policy let something
 * through. Bump it whenever the rules change.
 */
export const AUTO_POLICY_ID = "auto-v1";

export type RiskTier = "auto" | "review";

export type PolicyContext = {
  target: EnrichTarget;
  /** Forces every change to `review`. Set from ENRICH_AUTO_APPLY=0. */
  killSwitch?: boolean;
  /**
   * `dimension.field` coordinates the target already knows. A change naming a
   * field outside this set is proposing new canonical vocabulary, which is
   * never automatic. Omitted (e.g. in tests) means "don't check".
   */
  knownFields?: ReadonlySet<string>;
};

/**
 * May this change be published without a human looking at it?
 *
 * The governing idea is that reviewer attention should be spent on judgement,
 * not volume — but "low risk" has to mean genuinely low risk, because nothing
 * downstream will catch a mistake here. Rules, first match wins:
 *
 *  1. Kill switch → review. An operator override beats every other rule.
 *  2. Committee target → review. Facts about named people, always.
 *  3. Any validation flag → review. The pipeline already doubted it.
 *  4. unchanged_confirmed → AUTO. Re-confirming a value the baseline already
 *     holds changes no claim; withholding it just makes provenance staler.
 *  5. new_field at high confidence, with a real source URL and a field the
 *     target already recognises → AUTO. Purely additive.
 *  6. Everything else → review. In particular every mutation of an existing
 *     value: changed_value, newly_contradicted, newly_absent.
 *
 * Two conditions in rule 5 are worth naming. A null source_url means the
 * change came from the synthetic inventory-gap path rather than a validated
 * model candidate, so the anti-hallucination check in validate.ts never
 * applied to it. And the known-field check exists because that validator
 * blocks invented citations but nothing blocks an invented *field name* — an
 * auto-applied change could otherwise mint permanent canonical vocabulary
 * that no one chose.
 *
 * Pure: never reads process.env. Callers resolve the kill switch at the edge.
 */
export function isAutoEligible(change: ProposedChange, ctx: PolicyContext): boolean {
  if (ctx.killSwitch) return false;
  if (ctx.target === "committee") return false;
  if (change.validation_reasons.length > 0) return false;

  if (change.change_kind === "unchanged_confirmed") return true;

  if (change.change_kind === "new_field" && change.confidence === "high") {
    if (!change.record.source_url) return false;
    if (ctx.knownFields && !ctx.knownFields.has(`${change.dimension}.${change.field}`)) {
      return false;
    }
    return true;
  }

  return false;
}

export function tierFor(change: ProposedChange, ctx: PolicyContext): RiskTier {
  return isAutoEligible(change, ctx) ? "auto" : "review";
}

/** Auto-acceptable only when additive/confirming AND high confidence. */
function statusFor(kind: ChangeKind, candidate: CandidateField): ChangeStatus {
  if (kind === "new_field" || kind === "unchanged_confirmed") {
    return candidate.confidence === "high" ? "accepted" : "needs_human";
  }
  // changed_value | newly_contradicted | newly_absent → always human-gated.
  return "needs_human";
}

/**
 * Classify a single validated candidate against the current canonical
 * record. `validationReasons` carries any non-fatal notes; a non-empty list
 * forces `needs_human` regardless of kind.
 */
export function classify(
  current: FieldRecord | null,
  candidate: CandidateField,
  opts: { ctx?: DiffContext; validationReasons?: string[] } = {},
): ProposedChange {
  const ctx = opts.ctx ?? {};
  const reasons = opts.validationReasons ?? [];
  const change_kind = classifyKind(current, candidate, ctx);
  let status = statusFor(change_kind, candidate);
  if (reasons.length > 0) status = "needs_human";
  return {
    ...candidate,
    change_kind,
    current_record: current,
    status,
    validation_reasons: reasons,
  };
}
