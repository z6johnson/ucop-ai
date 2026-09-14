import { test } from "node:test";
import assert from "node:assert/strict";

import type { Decision } from "./changeset-format.ts";
import {
  UNGROUPED,
  facets,
  filterChanges,
  formatValue,
  groupByDeadSource,
  queueCounts,
  toReviewChange,
  type ReviewChange,
} from "./review.ts";
import type { ProposedChange } from "./types.ts";

function proposed(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    entity_id: "uc_berkeley",
    dimension: "infrastructure",
    field: "has_ai_hub_portal",
    record: { value: false, source_id: "inventory-gap", source_url: null, notes: "gone" },
    source_artifact_id: "inventory-gap",
    confidence: "medium",
    change_kind: "newly_absent",
    current_record: { value: true, source_id: "ucb-05", source_url: "https://x", notes: "hub" },
    status: "needs_human",
    validation_reasons: [],
    ...over,
  };
}

const rc = (over: Partial<ProposedChange> = {}): ReviewChange => toReviewChange(proposed(over));

test("toReviewChange surfaces both sides of the change", () => {
  const c = rc();
  assert.equal(c.id, "uc_berkeley.infrastructure.has_ai_hub_portal");
  assert.equal(c.currentValue, true);
  assert.equal(c.proposedValue, false);
  assert.equal(c.currentSourceId, "ucb-05");
});

test("a new field has no current value, distinct from a null one", () => {
  const added = rc({ change_kind: "new_field", current_record: null });
  assert.equal(added.currentValue, undefined);
  assert.equal(formatValue(added.currentValue), "—");

  const nulled = rc({
    current_record: { value: null, source_id: "s", source_url: null, notes: null },
  });
  assert.equal(formatValue(nulled.currentValue), "null");
});

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

test("dead-source proposals bucket by the source that went missing", () => {
  const items = [
    rc({ field: "has_ai_hub_portal" }),
    rc({ field: "has_enterprise_ai_platform" }),
    rc({
      field: "has_ai_training_program",
      current_record: { value: true, source_id: "ucb-08", source_url: "https://y", notes: "t" },
    }),
  ];
  const groups = groupByDeadSource(items);
  assert.deepEqual([...groups.keys()].sort(), ["ucb-05", "ucb-08"]);
  assert.equal(groups.get("ucb-05")!.length, 2, "one broken URL, one decision");
});

test("everything that is not a dead-source sweep stays individual", () => {
  const items = [
    rc({ change_kind: "new_field", current_record: null }),
    rc({ change_kind: "changed_value" }),
    rc(),
  ];
  const groups = groupByDeadSource(items);
  assert.equal(groups.get(UNGROUPED)!.length, 2);
  assert.equal(groups.get("ucb-05")!.length, 1);
});

test("a dead-source proposal with no prior source is not grouped", () => {
  const groups = groupByDeadSource([rc({ current_record: null })]);
  assert.deepEqual([...groups.keys()], [UNGROUPED]);
});

/* ------------------------------------------------------------------ */
/* Filtering and counting                                              */
/* ------------------------------------------------------------------ */

test("filters compose", () => {
  const items = [
    rc({ field: "a", confidence: "high" }),
    rc({ field: "b", confidence: "medium" }),
    rc({ field: "c", dimension: "governance", confidence: "high" }),
  ];
  const none: Record<string, Decision> = {};
  assert.equal(filterChanges(items, { confidence: "high" }, none).length, 2);
  assert.equal(
    filterChanges(items, { confidence: "high", dimension: "governance" }, none).length,
    1,
  );
  assert.equal(filterChanges(items, {}, none).length, 3);
  assert.equal(filterChanges(items, { kind: "all", confidence: "all" }, none).length, 3);
});

test("the undecided filter is what the reviewer actually needs", () => {
  const items = [rc({ field: "a" }), rc({ field: "b" }), rc({ field: "c" })];
  const decisions: Record<string, Decision> = {
    [items[0].id]: "accept",
    [items[1].id]: "reject",
    // items[2] left undecided
  };
  const undecided = filterChanges(items, { decision: "undecided" }, decisions);
  assert.deepEqual(undecided.map((c) => c.field), ["c"]);
});

test("search spans entity, field and notes", () => {
  const items = [
    rc({ field: "has_ai_hub_portal" }),
    rc({ field: "has_use_policy", record: { value: false, source_id: "s", source_url: null, notes: "Chancellor memo" } }),
  ];
  assert.equal(filterChanges(items, { search: "chancellor" }, {}).length, 1);
  assert.equal(filterChanges(items, { search: "hub" }, {}).length, 1);
  assert.equal(filterChanges(items, { search: "berkeley" }, {}).length, 2);
});

test("counts treat an absent decision as undecided", () => {
  const items = [rc({ field: "a" }), rc({ field: "b" }), rc({ field: "c" })];
  const counts = queueCounts(items, { [items[0].id]: "accept", [items[1].id]: "reject" });
  assert.deepEqual(counts, { accept: 1, reject: 1, review: 1, total: 3 });
});

test("facets list only what is present, with confidence in severity order", () => {
  const f = facets([
    rc({ confidence: "low", dimension: "policy" }),
    rc({ confidence: "high", dimension: "governance", change_kind: "new_field" }),
  ]);
  assert.deepEqual(f.confidences, ["high", "low"]);
  assert.deepEqual(f.dimensions, ["governance", "policy"]);
  assert.deepEqual(f.kinds, ["new_field", "newly_absent"]);
  assert.deepEqual(f.entities, ["uc_berkeley"]);
});

test("formatValue renders booleans for humans", () => {
  assert.equal(formatValue(true), "yes");
  assert.equal(formatValue(false), "no");
  assert.equal(formatValue(""), '""');
  assert.equal(formatValue("TritonGPT"), "TritonGPT");
  assert.equal(formatValue(3), "3");
});
