/**
 * Changeset applier — the ONLY module that writes canonical data files.
 *
 * Refuses to run unless the changeset is `status: draft` and a human has
 * filled `reviewed_by`. Applies only changes whose final DECISION is
 * `accept`. Additive (new_field) writes are no-overwrite-safe; human-approved
 * value mutations overwrite. Bumps the target's version and flips the
 * changeset to `applied`.
 *
 * Returns a summary the calling script uses to append ENRICHMENT_LOG.md and
 * re-run data/compute_derived.py. apply.ts itself never touches the log or
 * the derived analytics — it stays a pure data mutation with an audit return.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FieldRecord } from "../baseline.ts";
import { AUTO_POLICY_ID, isAutoEligible, type PolicyContext } from "./diff.ts";
import { readChangeset, writeChangeset, type Decision } from "./storage.ts";
import {
  changeId,
  type Changeset,
  type EnrichTarget,
  type ProposedChange,
} from "./types.ts";
import { BASELINE_FILE } from "./targets/baseline.ts";
import { PEER_FILE } from "./targets/peer.ts";
import { COMMITTEE_DIMENSION } from "./targets/committee.ts";

export type ApplySummary = {
  changesetId: string;
  target: string;
  applied: number;
  skipped: number;
  newFields: number;
  valueChanges: number;
  baseVersion: string;
  newVersion: string;
  perDimension: Record<string, number>;
  touchedEntities: string[];
};

export class ApplyGateError extends Error {}

/** "0.7.0" → "0.8.0". Falls back to appending ".1" if unparpseable. */
export function bumpMinor(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return `${version}.1`;
  return `${m[1]}.${Number(m[2]) + 1}.0`;
}

/**
 * "0.8.0" → "0.8.1". Used for the policy lane, so the version string alone
 * says how a release was authorised: a minor bump had a human behind it, a
 * patch bump did not.
 */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return `${version}.1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * The `dimension.field` coordinates the target already recognises.
 *
 * Feeds the policy check that stops an auto-applied change inventing new
 * canonical vocabulary. Derived from the live data rather than a hardcoded
 * list, so a field a human deliberately added last month is recognised this
 * month. Returns undefined for committee, which is never auto-eligible.
 */
export function knownFieldsFor(
  repoRoot: string,
  target: EnrichTarget,
): Set<string> | undefined {
  if (target !== "baseline" && target !== "peer") return undefined;
  const fileName = target === "baseline" ? BASELINE_FILE : PEER_FILE;
  const path = join(repoRoot, "data", fileName);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    entities: Record<string, Record<string, unknown>>;
  };
  const known = new Set<string>();
  for (const entity of Object.values(raw.entities)) {
    for (const [dimension, bucket] of Object.entries(entity)) {
      if (typeof bucket !== "object" || bucket === null) continue;
      for (const field of Object.keys(bucket as Record<string, unknown>)) {
        known.add(`${dimension}.${field}`);
      }
    }
  }
  return known;
}

function acceptedChanges(
  changes: ProposedChange[],
  decisions: Record<string, Decision>,
): ProposedChange[] {
  return changes.filter((c) => decisions[changeId(c)] === "accept");
}

function setDotted(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/* ------------------------------------------------------------------ */
/* FieldRecord targets (baseline / peer)                               */
/* ------------------------------------------------------------------ */

function applyFieldBaseline(
  repoRoot: string,
  fileName: string,
  accepted: ProposedChange[],
  runDate: string,
  approvalMode: "human" | "policy",
): { baseVersion: string; newVersion: string; perDimension: Record<string, number>; touched: Set<string> } {
  const path = join(repoRoot, "data", fileName);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    metadata: { version: string; notes?: string; created?: string };
    entities: Record<string, Record<string, unknown>>;
  };
  const baseVersion = raw.metadata.version;
  const perDimension: Record<string, number> = {};
  const touched = new Set<string>();

  for (const change of accepted) {
    const entity = raw.entities[change.entity_id];
    if (!entity) continue;
    if (typeof entity[change.dimension] !== "object" || entity[change.dimension] === null) {
      entity[change.dimension] = {};
    }
    const bucket = entity[change.dimension] as Record<string, FieldRecord>;
    bucket[change.field] = change.record;
    perDimension[change.dimension] = (perDimension[change.dimension] ?? 0) + 1;
    touched.add(change.entity_id);
  }

  // Minor for a reviewed release, patch for one policy let through, so the
  // version alone says whether a human was involved.
  const newVersion =
    approvalMode === "policy" ? bumpPatch(baseVersion) : bumpMinor(baseVersion);
  raw.metadata.version = newVersion;
  raw.metadata.created = runDate;
  raw.metadata.notes =
    approvalMode === "policy"
      ? `v${newVersion}: automated monthly enrichment applied ${runDate}. ` +
        `${accepted.length} field changes across ${touched.size} entities, published under ` +
        `policy ${AUTO_POLICY_ID} WITHOUT human review. ` +
        `See data/enrich/changesets/ for the audit record.`
      : `v${newVersion}: automated monthly enrichment applied ${runDate}. ` +
        `${accepted.length} human-approved field changes across ${touched.size} entities. ` +
        `See data/enrich/changesets/ for the reviewed changeset and rejection sidecar.`;

  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  return { baseVersion, newVersion, perDimension, touched };
}

/* ------------------------------------------------------------------ */
/* Committee target                                                    */
/* ------------------------------------------------------------------ */

function applyCommittee(
  repoRoot: string,
  accepted: ProposedChange[],
  runDate: string,
): { perDimension: Record<string, number>; touched: Set<string> } {
  const perDimension: Record<string, number> = {};
  const touched = new Set<string>();
  // Group by member so each file is read/written once.
  const byMember = new Map<string, ProposedChange[]>();
  for (const c of accepted) {
    const list = byMember.get(c.entity_id) ?? [];
    list.push(c);
    byMember.set(c.entity_id, list);
  }

  for (const [memberId, changes] of byMember) {
    const path = join(repoRoot, "data", "ucnfi-committee", "records", `${memberId}.json`);
    const rec = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    for (const c of changes) {
      setDotted(rec, c.field, c.record.value);
      // Record provenance into enrichment.sources, staying within schema.
      const enrichment = (rec["enrichment"] ??= {}) as Record<string, unknown>;
      const sources = (enrichment["sources"] ??= []) as Array<Record<string, unknown>>;
      if (c.record.source_url) {
        sources.push({
          url: c.record.source_url,
          type: "institutional_bio",
          accessed: runDate,
          note: c.record.notes ?? `Re-verified ${c.field} via monthly enrichment.`,
        });
      }
      perDimension[COMMITTEE_DIMENSION] = (perDimension[COMMITTEE_DIMENSION] ?? 0) + 1;
    }
    const rm = (rec["record_meta"] ??= {}) as Record<string, unknown>;
    rm["last_verified"] = runDate;
    writeFileSync(path, JSON.stringify(rec, null, 2) + "\n", "utf-8");
    touched.add(memberId);
  }
  return { perDimension, touched };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * The gate. Nothing writes canonical data without passing this.
 *
 * Two ways to be authorised, and they are not interchangeable:
 *
 *  - `human` — a person reviewed it and signed their name. This is the only
 *    mode that may carry a value mutation.
 *  - `policy` — every accepted change is independently re-derived as
 *    auto-eligible, right here, right now.
 *
 * That re-derivation is the point. A changeset file is just text in the repo:
 * it can be hand-edited, corrupted, or crafted. If this trusted the file's
 * own `status` or `approval_mode`, anyone able to write a changeset could
 * smuggle a `changed_value` into the baseline by labelling it policy. Instead
 * the gate ignores what the file claims about itself and asks the policy
 * function directly.
 */
function assertApprovalGate(
  changeset: Changeset,
  accepted: ProposedChange[],
  ctx: PolicyContext,
): void {
  const id = changeset.changeset_id;

  if (changeset.status !== "draft") {
    throw new ApplyGateError(
      `Changeset ${id} has status "${changeset.status}", expected "draft". Already applied?`,
    );
  }

  if (changeset.approval_mode === "policy") {
    if (!changeset.policy_id.trim()) {
      throw new ApplyGateError(
        `Changeset ${id} claims policy approval but names no policy_id.`,
      );
    }
    if (ctx.killSwitch) {
      throw new ApplyGateError(
        `Automatic publishing is disabled (ENRICH_AUTO_APPLY=0); ${id} was not applied.`,
      );
    }
    for (const change of accepted) {
      if (!isAutoEligible(change, ctx)) {
        throw new ApplyGateError(
          `Changeset ${id} is marked policy-approved but ${changeId(change)} ` +
            `(${change.change_kind}, ${change.confidence} confidence) is not auto-eligible ` +
            `under ${AUTO_POLICY_ID}. Refusing to apply it without a human.`,
        );
      }
    }
    return;
  }

  if (!changeset.reviewed_by.trim()) {
    throw new ApplyGateError(
      `Changeset ${id} has empty reviewed_by — a human must review and sign off before apply.`,
    );
  }
}

export function applyChangeset(
  repoRoot: string,
  changesetId: string,
  opts: { killSwitch?: boolean } = {},
): ApplySummary {
  const parsed = readChangeset(repoRoot, changesetId);
  if (!parsed) throw new ApplyGateError(`Changeset ${changesetId} not found`);
  const { changeset, decisions } = parsed;

  const accepted = acceptedChanges(changeset.changes, decisions);
  assertApprovalGate(changeset, accepted, {
    target: changeset.target,
    killSwitch: opts.killSwitch,
    knownFields: knownFieldsFor(repoRoot, changeset.target),
  });
  const runDate = changeset.run_date;

  let baseVersion = changeset.base_version;
  let newVersion = changeset.base_version;
  let perDimension: Record<string, number> = {};
  let touched = new Set<string>();

  if (accepted.length > 0) {
    if (changeset.target === "baseline" || changeset.target === "peer") {
      const fileName = changeset.target === "baseline" ? BASELINE_FILE : PEER_FILE;
      const res = applyFieldBaseline(
        repoRoot,
        fileName,
        accepted,
        runDate,
        changeset.approval_mode,
      );
      baseVersion = res.baseVersion;
      newVersion = res.newVersion;
      perDimension = res.perDimension;
      touched = res.touched;
    } else {
      const res = applyCommittee(repoRoot, accepted, runDate);
      perDimension = res.perDimension;
      touched = res.touched;
      newVersion = changeset.base_version; // committee is per-record versioned
    }
  }

  // Flip the changeset to applied and persist (preserving reviewer decisions).
  changeset.status = "applied";
  changeset.applied_at = new Date().toISOString();
  changeset.target_version = newVersion;
  writeChangeset(repoRoot, changeset, decisions);

  const newFields = accepted.filter((c) => c.change_kind === "new_field").length;
  return {
    changesetId,
    target: changeset.target,
    applied: accepted.length,
    skipped: changeset.changes.length - accepted.length,
    newFields,
    valueChanges: accepted.length - newFields,
    baseVersion,
    newVersion,
    perDimension,
    touchedEntities: [...touched].sort(),
  };
}
