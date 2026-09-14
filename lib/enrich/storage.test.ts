import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChangeset, serializeChangeset } from "./storage.ts";
import type { Changeset, ProposedChange } from "./types.ts";

function change(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    entity_id: "uc_merced",
    dimension: "governance",
    field: "has_ai_council",
    record: { value: true, source_id: "disc-1", source_url: "https://x/doc", notes: "Council formed 2026-02." },
    source_artifact_id: "disc-1",
    confidence: "high",
    change_kind: "new_field",
    current_record: null,
    status: "accepted",
    validation_reasons: [],
    ...over,
  };
}

function changeset(changes: ProposedChange[]): Changeset {
  return {
    changeset_id: "2026-06",
    target: "baseline",
    run_date: "2026-06-01",
    status: "draft",
    approval_mode: "human",
    policy_id: "",
    reviewed_by: "",
    reviewed_at: "",
    applied_at: "",
    generated_at: "2026-06-01T11:00:00Z",
    generated_by_model: "claude-opus-4-6",
    base_version: "0.7.0",
    target_version: "",
    inputs_manifest: {
      sources_refreshed: 0,
      sources_unchanged: 0,
      sources_changed: 0,
      sources_dead: 0,
      sources_discovered: 0,
      entities_swept: 1,
      dimensions_swept: 10,
    },
    changes,
  };
}

test("serialize → parse round-trips a changeset", () => {
  const cs = changeset([change(), change({ field: "has_use_policy", status: "needs_human", change_kind: "changed_value", current_record: { value: false, source_id: "s", source_url: "https://y", notes: "old" } })]);
  const text = serializeChangeset(cs);
  const { changeset: parsed, decisions } = parseChangeset(text);

  assert.equal(parsed.changeset_id, "2026-06");
  assert.equal(parsed.changes.length, 2);
  assert.equal(parsed.base_version, "0.7.0");
  // Default decisions: accepted → accept, needs_human → review.
  assert.equal(decisions["uc_merced.governance.has_ai_council"], "accept");
  assert.equal(decisions["uc_merced.governance.has_use_policy"], "review");
});

test("reviewer DECISION edits in the body override frontmatter defaults", () => {
  const cs = changeset([change({ status: "needs_human", change_kind: "changed_value" })]);
  let text = serializeChangeset(cs);
  // Simulate a reviewer flipping the review line to accept.
  text = text.replace("- DECISION: review", "- DECISION: accept");
  const { decisions } = parseChangeset(text);
  assert.equal(decisions["uc_merced.governance.has_ai_council"], "accept");
});

test("changeset fence parser rejects a missing fence", () => {
  assert.throws(() => parseChangeset("no fence here"));
});
