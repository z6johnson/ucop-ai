/**
 * Decision memory for the enrichment pipeline.
 *
 * The monthly run had no recollection of what a reviewer had already turned
 * down. In June a reviewer worked through 43 proposals and declined 41 of
 * them; August re-proposed 40 of those same coordinates with byte-identical
 * values, so the entire queue was work that had already been done. Reviewing
 * is only worth doing if a decision sticks.
 *
 * This records every decision by coordinate and rewrites nothing else. At
 * diff time a proposal whose fingerprint matches a standing rejection is held
 * back instead of entering the changeset.
 *
 * Two properties keep this memory rather than suppression:
 *
 *  - The fingerprint covers the proposed value AND its backing source, so a
 *    genuinely new claim about the same field is a new proposal and comes
 *    back. Declining "Berkeley has no AI hub, per a dead link" does not
 *    silence "Berkeley has an AI hub, per a live page".
 *  - Rejections expire after SUPPRESSION_DAYS, so a coordinate is revisited
 *    eventually even if nothing about it changes. Facts go stale; a decision
 *    from three years ago is not evidence.
 *
 * Withheld proposals are counted in the changeset manifest and written to a
 * {changeset_id}.suppressed.json sidecar, so this is never invisible.
 *
 * Storage: data/enrich/decisions_ledger.json — pretty JSON + trailing
 * newline, the same shape as data/enrich/source_ledger.json.
 *
 * No "server-only" import: read by Node CLI scripts and the review routes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Decision } from "./storage.ts";
import { changeId, type ProposedChange } from "./types.ts";

/**
 * How long a rejection holds. Six months is two enrichment cycles past the
 * quarter — long enough that a reviewer isn't re-litigating the same call
 * every month, short enough that a genuine change on the ground surfaces
 * within a governance cycle.
 */
export const SUPPRESSION_DAYS = 180;

export type DecisionEntry = {
  decision: Decision;
  /** Identifies WHAT was decided, so a different claim isn't covered by it. */
  value_fingerprint: string;
  decided_by: string;
  decided_at: string; // ISO timestamp
  changeset_id: string;
};

export type DecisionsLedger = Record<string, DecisionEntry>;

/* ------------------------------------------------------------------ */
/* Fingerprinting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Identity of the claim being made: the proposed value plus the source
 * asserting it. Deliberately excludes notes and confidence — a reworded note
 * is the same claim and should stay declined.
 */
export function fingerprint(change: ProposedChange): string {
  const payload = JSON.stringify([
    change.record.value,
    change.record.source_id ?? null,
    change.record.source_url ?? null,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* The predicate                                                       */
/* ------------------------------------------------------------------ */

/**
 * Should this proposal be held back? Pure — `nowIso` is injected so the
 * expiry boundary is testable.
 *
 * Only rejections suppress. An `accept` entry means the value is already
 * canonical, so an identical re-proposal will classify as
 * `unchanged_confirmed` on its own; and a `review` entry means the reviewer
 * never actually decided, which is not a decision to remember.
 */
export function isSuppressed(
  entry: DecisionEntry | undefined,
  change: ProposedChange,
  nowIso: string,
): boolean {
  if (!entry || entry.decision !== "reject") return false;
  if (entry.value_fingerprint !== fingerprint(change)) return false;

  const decidedAt = Date.parse(entry.decided_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(now)) return false;
  return now - decidedAt < SUPPRESSION_DAYS * 24 * 60 * 60 * 1000;
}

export type PartitionedChanges = {
  /** Proposals that should enter the changeset. */
  kept: ProposedChange[];
  /** Proposals held back by a standing rejection. */
  suppressed: ProposedChange[];
};

/** Splits proposals against the ledger. Order within each list is preserved. */
export function partitionSuppressed(
  changes: ProposedChange[],
  ledger: DecisionsLedger,
  nowIso: string,
): PartitionedChanges {
  const kept: ProposedChange[] = [];
  const suppressed: ProposedChange[] = [];
  for (const change of changes) {
    if (isSuppressed(ledger[changeId(change)], change, nowIso)) suppressed.push(change);
    else kept.push(change);
  }
  return { kept, suppressed };
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

/**
 * Records the decisions taken on a changeset. Mutates `ledger` in place.
 * Later decisions on the same coordinate replace earlier ones, so changing
 * your mind works — re-accepting something you once declined clears the
 * rejection rather than fighting it.
 */
export function recordDecisions(
  ledger: DecisionsLedger,
  args: {
    changes: ProposedChange[];
    decisions: Record<string, Decision>;
    decidedBy: string;
    changesetId: string;
    nowIso: string;
  },
): void {
  for (const change of args.changes) {
    const id = changeId(change);
    const decision = args.decisions[id];
    // A change left at `review` was never decided — don't overwrite whatever
    // the reviewer concluded about this coordinate last time.
    if (decision !== "accept" && decision !== "reject") continue;
    ledger[id] = {
      decision,
      value_fingerprint: fingerprint(change),
      decided_by: args.decidedBy,
      decided_at: args.nowIso,
      changeset_id: args.changesetId,
    };
  }
}

/** Drop entries older than SUPPRESSION_DAYS — they no longer suppress anything. */
export function pruneDecisions(ledger: DecisionsLedger, nowIso: string): DecisionsLedger {
  const cutoff = Date.parse(nowIso) - SUPPRESSION_DAYS * 24 * 60 * 60 * 1000;
  for (const [k, entry] of Object.entries(ledger)) {
    const t = Date.parse(entry.decided_at);
    if (Number.isFinite(t) && t < cutoff) delete ledger[k];
  }
  return ledger;
}

/* ------------------------------------------------------------------ */
/* I/O                                                                 */
/* ------------------------------------------------------------------ */

export function decisionsLedgerPath(repoRoot: string): string {
  return join(repoRoot, "data", "enrich", "decisions_ledger.json");
}

export function readDecisionsLedger(repoRoot: string): DecisionsLedger {
  const p = decisionsLedgerPath(repoRoot);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8")) as DecisionsLedger;
}

export function writeDecisionsLedger(repoRoot: string, ledger: DecisionsLedger): void {
  const p = decisionsLedgerPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
}

/* ------------------------------------------------------------------ */
/* Suppressed sidecar                                                  */
/* ------------------------------------------------------------------ */

export type SuppressedRecord = {
  changeset_id: string;
  suppressed_at: string;
  changes: Array<{
    change_id: string;
    entity_id: string;
    dimension: string;
    field: string;
    change_kind: string;
    proposed_value: unknown;
    /** The decision that is holding this back, so it can be traced or undone. */
    prior: DecisionEntry;
  }>;
};

export function suppressedPath(repoRoot: string, changesetId: string): string {
  return join(repoRoot, "data", "enrich", "changesets", `${changesetId}.suppressed.json`);
}

export function writeSuppressed(
  repoRoot: string,
  changesetId: string,
  record: SuppressedRecord,
): string {
  const p = suppressedPath(repoRoot, changesetId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + "\n", "utf-8");
  return p;
}

/** Builds the sidecar payload for a set of withheld proposals. */
export function toSuppressedRecord(
  changesetId: string,
  suppressed: ProposedChange[],
  ledger: DecisionsLedger,
  nowIso: string,
): SuppressedRecord {
  return {
    changeset_id: changesetId,
    suppressed_at: nowIso,
    changes: suppressed.map((c) => {
      const id = changeId(c);
      return {
        change_id: id,
        entity_id: c.entity_id,
        dimension: c.dimension,
        field: c.field,
        change_kind: c.change_kind,
        proposed_value: c.record.value,
        prior: ledger[id],
      };
    }),
  };
}
