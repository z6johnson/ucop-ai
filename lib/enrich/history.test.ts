import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeChangeset, type Decision } from "./storage.ts";
import {
  appliedChangesets,
  fieldLastUpdatedIndex,
  pendingChangesets,
} from "./history.ts";
import type { Changeset, ProposedChange } from "./types.ts";

function change(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    entity_id: "uc_merced",
    dimension: "governance",
    field: "has_ai_council",
    record: { value: true, source_id: "disc-1", source_url: "https://x/doc", notes: "n" },
    source_artifact_id: "disc-1",
    confidence: "high",
    change_kind: "new_field",
    current_record: null,
    status: "accepted",
    validation_reasons: [],
    ...over,
  };
}

function changeset(over: Partial<Changeset>, changes: ProposedChange[]): Changeset {
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
    ...over,
  };
}

test("pending vs applied split, with decision tallies", () => {
  const repo = mkdtempSync(join(tmpdir(), "ucnfi-hist-"));

  // An applied refresh: one accepted add, one rejected newly_absent.
  const applied = changeset(
    {
      changeset_id: "2026-05",
      status: "applied",
      reviewed_by: "zj",
      reviewed_at: "2026-05-01T00:00:00Z",
      applied_at: "2026-05-01T12:00:00Z",
      target_version: "0.8.0",
    },
    [
      change(),
      change({
        field: "has_use_policy",
        change_kind: "newly_absent",
        status: "needs_human",
      }),
    ],
  );
  const appliedDecisions: Record<string, Decision> = {
    "uc_merced.governance.has_ai_council": "accept",
    "uc_merced.governance.has_use_policy": "reject",
  };
  writeChangeset(repo, applied, appliedDecisions);

  // A draft still awaiting review.
  const draft = changeset({ changeset_id: "2026-06" }, [
    change({ field: "has_named_lead", dimension: "leadership" }),
  ]);
  writeChangeset(repo, draft, undefined);

  const pending = pendingChangesets(repo);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].changeset_id, "2026-06");
  assert.equal(pending[0].acceptedCount, 1);

  const done = appliedChangesets(repo);
  assert.equal(done.length, 1);
  assert.equal(done[0].acceptedCount, 1);
  assert.equal(done[0].rejectedCount, 1);
  assert.equal(done[0].target_version, "0.8.0");
  assert.deepEqual(done[0].perDimension, { governance: 1 });
  assert.deepEqual(done[0].touchedEntities, ["uc_merced"]);
});

test("fieldLastUpdatedIndex only reflects accepted changes from applied changesets", () => {
  const repo = mkdtempSync(join(tmpdir(), "ucnfi-hist-"));

  const applied = changeset(
    {
      changeset_id: "2026-05",
      status: "applied",
      reviewed_by: "zj",
      applied_at: "2026-05-01T12:00:00Z",
      target_version: "0.8.0",
    },
    [change(), change({ field: "has_use_policy", status: "needs_human" })],
  );
  writeChangeset(repo, applied, {
    "uc_merced.governance.has_ai_council": "accept",
    "uc_merced.governance.has_use_policy": "reject",
  });

  const index = fieldLastUpdatedIndex(repo);
  const hit = index.get("uc_merced.governance.has_ai_council");
  assert.ok(hit);
  assert.equal(hit.version, "0.8.0");
  assert.equal(hit.applied_at, "2026-05-01T12:00:00Z");
  // The rejected field must not appear.
  assert.equal(index.get("uc_merced.governance.has_use_policy"), undefined);
});
