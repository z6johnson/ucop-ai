import { test } from "node:test";
import assert from "node:assert/strict";

import type { FieldRecord } from "../baseline.ts";
import { classify, classifyKind, isAutoEligible, tierFor, type PolicyContext } from "./diff.ts";
import type { CandidateField, ProposedChange } from "./types.ts";

function cand(value: FieldRecord["value"], confidence: CandidateField["confidence"] = "high"): CandidateField {
  return {
    entity_id: "uc_merced",
    dimension: "governance",
    field: "has_ai_council",
    record: { value, source_id: "disc-1", source_url: "https://x", notes: "n" },
    source_artifact_id: "disc-1",
    confidence,
  };
}

function rec(value: FieldRecord["value"]): FieldRecord {
  return { value, source_id: "s", source_url: "https://y", notes: "n" };
}

test("new_field when current is absent", () => {
  assert.equal(classifyKind(null, cand(true)), "new_field");
});

test("unchanged_confirmed when values match", () => {
  assert.equal(classifyKind(rec(true), cand(true)), "unchanged_confirmed");
});

test("changed_value when a non-positive value differs", () => {
  assert.equal(classifyKind(rec("draft"), cand("final")), "changed_value");
});

test("newly_contradicted when a prior positive is now false", () => {
  assert.equal(classifyKind(rec(true), cand(false)), "newly_contradicted");
});

test("newly_absent when prior positive and the backing source died", () => {
  assert.equal(classifyKind(rec(true), cand(false), { fromDeadSource: true }), "newly_absent");
});

test("new_field high confidence auto-accepts", () => {
  assert.equal(classify(null, cand(true)).status, "accepted");
});

test("new_field low confidence needs human", () => {
  assert.equal(classify(null, cand(true, "low")).status, "needs_human");
});

test("any value mutation is forced to needs_human even at high confidence", () => {
  assert.equal(classify(rec(false), cand(true)).status, "needs_human");
  assert.equal(classify(rec(true), cand(false)).status, "needs_human");
});

test("validation reasons force needs_human", () => {
  assert.equal(classify(null, cand(true), { validationReasons: ["x"] }).status, "needs_human");
});

/* ------------------------------------------------------------------ */
/* Auto-publish policy                                                 */
/* ------------------------------------------------------------------ */

const BASELINE: PolicyContext = { target: "baseline" };

function proposed(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    ...cand(true),
    change_kind: "new_field",
    current_record: null,
    status: "accepted",
    validation_reasons: [],
    ...over,
  };
}

test("a purely additive high-confidence field may publish itself", () => {
  assert.equal(tierFor(proposed(), BASELINE), "auto");
});

test("every mutation of an existing value needs a human", () => {
  for (const kind of ["changed_value", "newly_contradicted", "newly_absent"] as const) {
    assert.equal(
      tierFor(proposed({ change_kind: kind, current_record: rec(true) }), BASELINE),
      "review",
      kind,
    );
  }
});

test("re-confirmation is automatic at any confidence", () => {
  // It asserts nothing new — the value is already canonical. Withholding it
  // only makes provenance staler.
  for (const c of ["high", "medium", "low"] as const) {
    assert.equal(
      tierFor(proposed({ change_kind: "unchanged_confirmed", confidence: c, current_record: rec(true) }), BASELINE),
      "auto",
      c,
    );
  }
});

test("a new field below high confidence needs a human", () => {
  for (const c of ["medium", "low"] as const) {
    assert.equal(tierFor(proposed({ confidence: c }), BASELINE), "review", c);
  }
});

test("any validation flag disqualifies a change from publishing itself", () => {
  assert.equal(tierFor(proposed({ validation_reasons: ["suspect"] }), BASELINE), "review");
  assert.equal(
    tierFor(proposed({ change_kind: "unchanged_confirmed", validation_reasons: ["suspect"] }), BASELINE),
    "review",
  );
});

test("committee changes are never automatic — they are facts about named people", () => {
  const ctx: PolicyContext = { target: "committee" };
  assert.equal(tierFor(proposed(), ctx), "review");
  assert.equal(tierFor(proposed({ change_kind: "unchanged_confirmed" }), ctx), "review");
});

test("the kill switch overrides everything", () => {
  const ctx: PolicyContext = { target: "baseline", killSwitch: true };
  assert.equal(tierFor(proposed(), ctx), "review");
  assert.equal(tierFor(proposed({ change_kind: "unchanged_confirmed" }), ctx), "review");
});

test("a new field with no source URL is not automatic", () => {
  // No URL means it came from the synthetic inventory-gap path, so the
  // anti-hallucination check in validate.ts never applied to it.
  const c = proposed();
  c.record = { ...c.record, source_url: null };
  assert.equal(tierFor(c, BASELINE), "review");
});

test("an unrecognised field name is not automatic", () => {
  // validate.ts blocks invented citations but nothing blocks an invented
  // FIELD, which would mint permanent canonical vocabulary unattended.
  const known = new Set(["governance.has_ai_council"]);
  assert.equal(tierFor(proposed(), { ...BASELINE, knownFields: known }), "auto");
  assert.equal(
    tierFor(proposed({ field: "has_invented_thing" }), { ...BASELINE, knownFields: known }),
    "review",
  );
});

test("peer target follows the same rules as baseline", () => {
  assert.equal(tierFor(proposed(), { target: "peer" }), "auto");
  assert.equal(
    tierFor(proposed({ change_kind: "changed_value", current_record: rec(false) }), { target: "peer" }),
    "review",
  );
});

test("auto eligibility never exceeds what classify would auto-accept, except re-confirmations", () => {
  // Guards the one intentional widening: everything else the lane publishes
  // unattended is something the pipeline already marked `accepted`.
  for (const kind of ["new_field", "changed_value", "newly_contradicted", "newly_absent"] as const) {
    for (const confidence of ["high", "medium", "low"] as const) {
      const c = proposed({
        change_kind: kind,
        confidence,
        current_record: kind === "new_field" ? null : rec(true),
      });
      if (isAutoEligible(c, BASELINE)) {
        assert.equal(
          classify(c.current_record, { ...cand(true, confidence) }, {}).status,
          "accepted",
          `${kind}/${confidence} publishes itself but classify would not accept it`,
        );
      }
    }
  }
});
