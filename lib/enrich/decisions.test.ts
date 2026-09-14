import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPRESSION_DAYS,
  fingerprint,
  isSuppressed,
  partitionSuppressed,
  pruneDecisions,
  recordDecisions,
  type DecisionsLedger,
} from "./decisions.ts";
import { changeId, type ProposedChange } from "./types.ts";

const NOW = "2026-08-14T00:00:00Z";

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}

/** A dead-source gap proposal, the shape that flooded the June/August queues. */
function change(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    entity_id: "uc_berkeley",
    dimension: "infrastructure",
    field: "has_ai_hub_portal",
    record: {
      value: false,
      source_id: "inventory-gap",
      source_url: null,
      notes: "Backing source ucb-05 returned HTTP 404/410 for ≥2 consecutive checks.",
    },
    source_artifact_id: "inventory-gap",
    confidence: "medium",
    change_kind: "newly_absent",
    current_record: {
      value: true,
      source_id: "ucb-05",
      source_url: "https://technology.berkeley.edu/AI",
      notes: "Berkeley AI Hub.",
    },
    status: "needs_human",
    validation_reasons: [],
    ...over,
  };
}

function ledgerWith(c: ProposedChange, over: Partial<DecisionsLedger[string]> = {}): DecisionsLedger {
  return {
    [changeId(c)]: {
      decision: "reject",
      value_fingerprint: fingerprint(c),
      decided_by: "z6johnson",
      decided_at: daysBefore(NOW, 74), // June → August, the real interval
      changeset_id: "2026-06",
      ...over,
    },
  };
}

test("a standing rejection suppresses an identical re-proposal", () => {
  const c = change();
  assert.equal(isSuppressed(ledgerWith(c)[changeId(c)], c, NOW), true);
});

test("no ledger entry never suppresses", () => {
  assert.equal(isSuppressed(undefined, change(), NOW), false);
});

test("a different proposed value is a new claim and comes back", () => {
  const declined = change();
  const revived = change({
    record: { ...declined.record, value: true, source_id: "ucb-05", source_url: "https://technology.berkeley.edu/AI" },
  });
  assert.equal(isSuppressed(ledgerWith(declined)[changeId(declined)], revived, NOW), false);
});

test("the same value from a different source is a new claim and comes back", () => {
  const declined = change();
  const resourced = change({
    record: { ...declined.record, source_id: "ucb-99", source_url: "https://example.edu/new" },
  });
  assert.equal(isSuppressed(ledgerWith(declined)[changeId(declined)], resourced, NOW), false);
});

test("rewording the note does not revive a declined claim", () => {
  const declined = change();
  const reworded = change({ record: { ...declined.record, notes: "Completely different prose." } });
  assert.equal(isSuppressed(ledgerWith(declined)[changeId(declined)], reworded, NOW), true);
});

test("confidence is not part of the claim's identity", () => {
  const declined = change();
  assert.equal(
    isSuppressed(ledgerWith(declined)[changeId(declined)], change({ confidence: "high" }), NOW),
    true,
  );
});

test("a rejection expires after SUPPRESSION_DAYS", () => {
  const c = change();
  const stale = ledgerWith(c, { decided_at: daysBefore(NOW, SUPPRESSION_DAYS + 1) });
  assert.equal(isSuppressed(stale[changeId(c)], c, NOW), false);

  const fresh = ledgerWith(c, { decided_at: daysBefore(NOW, SUPPRESSION_DAYS - 1) });
  assert.equal(isSuppressed(fresh[changeId(c)], c, NOW), true);
});

test("accept and review entries never suppress", () => {
  const c = change();
  assert.equal(isSuppressed(ledgerWith(c, { decision: "accept" })[changeId(c)], c, NOW), false);
  assert.equal(isSuppressed(ledgerWith(c, { decision: "review" })[changeId(c)], c, NOW), false);
});

test("partitionSuppressed splits the August queue against June's decisions", () => {
  const declined = change();
  const fresh = change({ entity_id: "uc_merced", field: "has_ai_council", record: { ...declined.record, value: true } });
  const { kept, suppressed } = partitionSuppressed([declined, fresh], ledgerWith(declined), NOW);
  assert.deepEqual(suppressed.map(changeId), [changeId(declined)]);
  assert.deepEqual(kept.map(changeId), [changeId(fresh)]);
});

test("recordDecisions writes accepts and rejects but ignores undecided", () => {
  const c = change();
  const other = change({ field: "has_enterprise_ai_platform" });
  const undecided = change({ field: "has_use_policy" });
  const ledger: DecisionsLedger = {};
  recordDecisions(ledger, {
    changes: [c, other, undecided],
    decisions: {
      [changeId(c)]: "reject",
      [changeId(other)]: "accept",
      [changeId(undecided)]: "review",
    },
    decidedBy: "z6johnson",
    changesetId: "2026-08",
    nowIso: NOW,
  });
  assert.equal(ledger[changeId(c)].decision, "reject");
  assert.equal(ledger[changeId(other)].decision, "accept");
  assert.equal(ledger[changeId(undecided)], undefined, "an undecided change records nothing");
});

test("changing your mind clears an earlier rejection", () => {
  const c = change();
  const ledger = ledgerWith(c);
  assert.equal(isSuppressed(ledger[changeId(c)], c, NOW), true);

  recordDecisions(ledger, {
    changes: [c],
    decisions: { [changeId(c)]: "accept" },
    decidedBy: "z6johnson",
    changesetId: "2026-08",
    nowIso: NOW,
  });
  assert.equal(isSuppressed(ledger[changeId(c)], c, NOW), false);
});

test("pruneDecisions drops entries past the window", () => {
  const c = change();
  const ledger = ledgerWith(c, { decided_at: daysBefore(NOW, SUPPRESSION_DAYS + 5) });
  pruneDecisions(ledger, NOW);
  assert.deepEqual(Object.keys(ledger), []);
});
