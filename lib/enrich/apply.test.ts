import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApplyGateError, applyChangeset, bumpMinor, bumpPatch } from "./apply.ts";
import { writeChangeset } from "./storage.ts";
import { AUTO_POLICY_ID } from "./diff.ts";
import { changeId, type Changeset, type ProposedChange } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

function baselineFile() {
  return {
    metadata: { version: "0.8.0", created: "2026-06-01", notes: "" },
    schema: { dimensions: { governance: "Governance" } },
    entities: {
      uc_merced: {
        entity_name: "UC Merced",
        governance: {
          has_use_policy: {
            value: false,
            source_id: "s",
            source_url: "https://y",
            notes: "old",
          },
        },
      },
      // A second entity that already carries has_ai_council, so that field is
      // established vocabulary even though UC Merced lacks it. That is what
      // `new_field` means in practice: new for this entity, not new to the
      // schema. A name no entity uses is a different thing entirely.
      uc_berkeley: {
        entity_name: "UC Berkeley",
        governance: {
          has_ai_council: {
            value: true,
            source_id: "ucb-1",
            source_url: "https://b",
            notes: "council",
          },
        },
      },
    },
  };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "ucnfi-apply-"));
  mkdirSync(join(root, "data", "enrich", "changesets"), { recursive: true });
  writeFileSync(
    join(root, "data", "uc_ai_baseline.json"),
    JSON.stringify(baselineFile(), null, 2),
    "utf-8",
  );
  return root;
}

function change(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    entity_id: "uc_merced",
    dimension: "governance",
    field: "has_ai_council",
    record: {
      value: true,
      source_id: "disc-1",
      source_url: "https://x/doc",
      notes: "Council formed 2026-02.",
    },
    source_artifact_id: "disc-1",
    confidence: "high",
    change_kind: "new_field",
    current_record: null,
    status: "accepted",
    validation_reasons: [],
    ...over,
  };
}

function changeset(changes: ProposedChange[], over: Partial<Changeset> = {}): Changeset {
  return {
    changeset_id: "2026-08",
    target: "baseline",
    run_date: "2026-08-01",
    status: "draft",
    approval_mode: "human",
    policy_id: "",
    reviewed_by: "",
    reviewed_at: "",
    applied_at: "",
    generated_at: "2026-08-01T11:00:00Z",
    generated_by_model: "claude-sonnet-4-6",
    base_version: "0.8.0",
    target_version: "",
    inputs_manifest: {
      sources_refreshed: 0,
      sources_unchanged: 0,
      sources_changed: 0,
      sources_dead: 0,
      sources_discovered: 0,
      entities_swept: 1,
      dimensions_swept: 1,
    },
    changes,
    ...over,
  };
}

function seed(cs: Changeset, decisions?: Record<string, "accept" | "reject" | "review">): string {
  const root = repo();
  writeChangeset(root, cs, decisions);
  return root;
}

const acceptAll = (cs: Changeset) =>
  Object.fromEntries(cs.changes.map((c) => [changeId(c), "accept" as const]));

/* ------------------------------------------------------------------ */
/* Human lane                                                          */
/* ------------------------------------------------------------------ */

test("the human lane refuses to apply without a signature", () => {
  const cs = changeset([change()]);
  const root = seed(cs, acceptAll(cs));
  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /empty reviewed_by/.test(e.message),
  );
});

test("a signed human changeset applies and bumps the minor version", () => {
  const cs = changeset([change()], { reviewed_by: "z6johnson" });
  const root = seed(cs, acceptAll(cs));
  const summary = applyChangeset(root, "2026-08");

  assert.equal(summary.applied, 1);
  assert.equal(summary.newVersion, "0.9.0");
  const data = JSON.parse(readFileSync(join(root, "data", "uc_ai_baseline.json"), "utf-8"));
  assert.equal(data.entities.uc_merced.governance.has_ai_council.value, true);
  assert.match(data.metadata.notes, /human-approved/);
});

test("an applied changeset cannot be applied twice", () => {
  const cs = changeset([change()], { reviewed_by: "z6johnson" });
  const root = seed(cs, acceptAll(cs));
  applyChangeset(root, "2026-08");
  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /expected "draft"/.test(e.message),
  );
});

test("only accepted changes are written", () => {
  const keep = change();
  const drop = change({ field: "has_transparency_report" });
  const cs = changeset([keep, drop], { reviewed_by: "z6johnson" });
  const root = seed(cs, { [changeId(keep)]: "accept", [changeId(drop)]: "reject" });

  const summary = applyChangeset(root, "2026-08");
  assert.equal(summary.applied, 1);
  assert.equal(summary.skipped, 1);
  const data = JSON.parse(readFileSync(join(root, "data", "uc_ai_baseline.json"), "utf-8"));
  assert.equal(data.entities.uc_merced.governance.has_transparency_report, undefined);
});

/* ------------------------------------------------------------------ */
/* Policy lane                                                         */
/* ------------------------------------------------------------------ */

const policy = { approval_mode: "policy" as const, policy_id: AUTO_POLICY_ID };

test("the policy lane applies auto-eligible changes with no signature", () => {
  const cs = changeset([change()], policy);
  const root = seed(cs, acceptAll(cs));
  const summary = applyChangeset(root, "2026-08");

  assert.equal(summary.applied, 1);
  assert.equal(summary.newVersion, "0.8.1", "policy releases bump the patch, not the minor");
  const data = JSON.parse(readFileSync(join(root, "data", "uc_ai_baseline.json"), "utf-8"));
  assert.match(data.metadata.notes, /WITHOUT human review/);
});

test("the policy lane cannot smuggle a value mutation past the gate", () => {
  // The whole point of re-deriving eligibility at apply time: a changeset is
  // just text in the repo, so a file that LABELS itself policy-approved must
  // not be taken at its word.
  const mutation = change({
    field: "has_use_policy",
    change_kind: "changed_value",
    current_record: { value: false, source_id: "s", source_url: "https://y", notes: "old" },
  });
  const cs = changeset([mutation], policy);
  const root = seed(cs, acceptAll(cs));

  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /not auto-eligible/.test(e.message),
  );
  const data = JSON.parse(readFileSync(join(root, "data", "uc_ai_baseline.json"), "utf-8"));
  assert.equal(data.entities.uc_merced.governance.has_use_policy.value, false, "untouched");
  assert.equal(data.metadata.version, "0.8.0", "and unversioned");
});

test("the policy lane cannot smuggle a low-confidence field either", () => {
  const cs = changeset([change({ confidence: "low" })], policy);
  const root = seed(cs, acceptAll(cs));
  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /not auto-eligible/.test(e.message),
  );
});

test("the policy lane cannot invent new canonical vocabulary", () => {
  // knownFields is derived from the live baseline, which has no such field.
  const cs = changeset([change({ field: "has_completely_invented_field" })], policy);
  const root = seed(cs, acceptAll(cs));
  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /not auto-eligible/.test(e.message),
  );
});

test("a policy changeset naming no policy is refused", () => {
  const cs = changeset([change()], { approval_mode: "policy", policy_id: "" });
  const root = seed(cs, acceptAll(cs));
  assert.throws(
    () => applyChangeset(root, "2026-08"),
    (e: Error) => e instanceof ApplyGateError && /names no policy_id/.test(e.message),
  );
});

test("the kill switch stops an already-generated policy lane", () => {
  const cs = changeset([change()], policy);
  const root = seed(cs, acceptAll(cs));
  assert.throws(
    () => applyChangeset(root, "2026-08", { killSwitch: true }),
    (e: Error) => e instanceof ApplyGateError && /disabled/.test(e.message),
  );
});

test("the kill switch does not block a human-reviewed changeset", () => {
  // It disables automatic publishing, not publishing.
  const cs = changeset([change()], { reviewed_by: "z6johnson" });
  const root = seed(cs, acceptAll(cs));
  assert.equal(applyChangeset(root, "2026-08", { killSwitch: true }).applied, 1);
});

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

test("version bumps", () => {
  assert.equal(bumpMinor("0.8.0"), "0.9.0");
  assert.equal(bumpMinor("0.8.3"), "0.9.0");
  assert.equal(bumpPatch("0.8.0"), "0.8.1");
  assert.equal(bumpPatch("0.8.9"), "0.8.10");
  assert.equal(bumpMinor("weird"), "weird.1");
  assert.equal(bumpPatch("weird"), "weird.1");
});
