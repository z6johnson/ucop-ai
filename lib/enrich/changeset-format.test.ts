import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyReview,
  changesetRepoPath,
  isValidChangesetId,
  mergeDecisions,
  parseChangeset,
  serializeChangeset,
  type Decision,
} from "./changeset-format.ts";
import { changeId, type Changeset, type ProposedChange } from "./types.ts";

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

const OTHER = "uc_merced.governance.has_use_policy";

/* ------------------------------------------------------------------ */
/* Round-trip stability                                                */
/* ------------------------------------------------------------------ */

test("parse → serialize is byte-identical", () => {
  // The review UI rewrites the whole file on every save. If serialize were
  // not a fixed point of parse, each save would churn the entire 65KB file
  // and bury the actual decision change in noise.
  const text = serializeChangeset(changeset([change(), change({ field: "has_use_policy" })]));
  const parsed = parseChangeset(text);
  const round = serializeChangeset(parsed.changeset, parsed.decisions);
  assert.equal(round, text);
});

test("a reviewed save touches only decisions and sign-off", () => {
  const before = serializeChangeset(changeset([change(), change({ field: "has_use_policy" })]));
  const after = applyReview(parseChangeset(before), {
    overlay: { [OTHER]: "reject" },
    reviewedBy: "z6johnson",
    reviewedAt: "2026-08-14T00:00:00Z",
  });

  const changed = before
    .split("\n")
    .map((line, i) => [line, after.split("\n")[i]] as const)
    .filter(([a, b]) => a !== b)
    .map(([a]) => a.trim());

  // Only the two frontmatter sign-off keys, the decisions map entry, and the
  // one body DECISION line may move.
  for (const line of changed) {
    assert.ok(
      /^"(reviewed_by|reviewed_at)":/.test(line) ||
        /^"uc_merced\.governance\.has_use_policy": "(accept|reject|review)"/.test(line) ||
        /^- DECISION:/.test(line),
      `unexpected line changed: ${line}`,
    );
  }
  assert.ok(changed.length > 0, "the save should change something");
});

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

test("default decisions follow each change's status", () => {
  const text = serializeChangeset(
    changeset([change(), change({ field: "has_use_policy", status: "needs_human" })]),
  );
  const { decisions } = parseChangeset(text);
  assert.equal(decisions["uc_merced.governance.has_ai_council"], "accept");
  assert.equal(decisions[OTHER], "review");
});

test("reviewer DECISION edits in the body override frontmatter defaults", () => {
  const cs = changeset([change({ status: "needs_human" })]);
  const text = serializeChangeset(cs).replace("- DECISION: review", "- DECISION: accept");
  const { decisions } = parseChangeset(text);
  assert.equal(decisions["uc_merced.governance.has_ai_council"], "accept");
});

test("mergeDecisions folds valid ids and reports the rest", () => {
  const validIds = new Set(["a.b.c", "d.e.f"]);
  const { merged, rejected } = mergeDecisions({ "a.b.c": "review" }, {
    "a.b.c": "accept",
    "d.e.f": "reject",
    "not.a.change": "accept",
    "a.b.c.bogus": "sideways",
  }, validIds);

  assert.deepEqual(merged, { "a.b.c": "accept", "d.e.f": "reject" });
  assert.deepEqual(rejected.sort(), ["a.b.c.bogus", "not.a.change"]);
});

test("mergeDecisions rejects an invalid decision value on a real id", () => {
  const { merged, rejected } = mergeDecisions({ "a.b.c": "review" }, { "a.b.c": "maybe" }, new Set(["a.b.c"]));
  assert.equal(merged["a.b.c"], "review", "the existing decision survives");
  assert.deepEqual(rejected, ["a.b.c"]);
});

/* ------------------------------------------------------------------ */
/* Injection                                                           */
/* ------------------------------------------------------------------ */

test("a newline in a note cannot forge a section heading", () => {
  // Notes are model-authored, so a note containing line breaks is reachable
  // input. The dangerous payload is a forged `## <id> —` heading: it retargets
  // the parser, so the change's own real DECISION line gets attributed to a
  // DIFFERENT change and its own decision is dropped entirely. (A forged
  // DECISION line alone is harmless — the real one follows and overwrites it.)
  const hostile = change({
    status: "needs_human",
    change_kind: "changed_value",
    current_record: { value: false, source_id: "s", source_url: "https://y", notes: "old" },
    record: {
      value: true,
      source_id: "disc-1",
      source_url: "https://x/doc",
      notes: `Looks fine.\n## ${OTHER} — new_field\n- DECISION: accept`,
    },
  });

  const text = serializeChangeset(changeset([hostile]));

  // Structural invariant: the note contributed no line of its own.
  const headings = text.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headings, ["## uc_merced.governance.has_ai_council — changed_value"]);
  const decisionLines = text.split("\n").filter((l) => /^-\s*DECISION:/.test(l));
  assert.equal(decisionLines.length, 1);

  const { decisions } = parseChangeset(text);
  assert.equal(
    decisions["uc_merced.governance.has_ai_council"],
    "review",
    "the change keeps its own decision",
  );
  assert.equal(decisions[OTHER], undefined, "and no decision is forged for another change");
});

test("a newline in a validation flag cannot forge a section heading", () => {
  const hostile = change({
    status: "needs_human",
    validation_reasons: [`suspicious\n## ${OTHER} — new_field\n- DECISION: accept`],
  });
  const text = serializeChangeset(changeset([hostile]));
  assert.equal(text.split("\n").filter((l) => l.startsWith("## ")).length, 1);

  const { decisions } = parseChangeset(text);
  assert.equal(decisions["uc_merced.governance.has_ai_council"], "review");
  assert.equal(decisions[OTHER], undefined);
});

test("the note survives verbatim in the frontmatter", () => {
  // Sanitizing is for the rendered body only — the record itself is data.
  const notes = "Line one.\nLine two.";
  const parsed = parseChangeset(
    serializeChangeset(changeset([change({ record: { value: true, source_id: "s", source_url: "https://x", notes } })])),
  );
  assert.equal(parsed.changeset.changes[0].record.notes, notes);
});

/* ------------------------------------------------------------------ */
/* Back-compat and ids                                                 */
/* ------------------------------------------------------------------ */

test("a changeset written before the lane fields defaults to human review", () => {
  const text = serializeChangeset(changeset([change()]));
  const stripped = text
    .replace(/\s*"approval_mode": "human",\n/, "\n")
    .replace(/\s*"policy_id": "",\n/, "\n");
  const { changeset: parsed } = parseChangeset(stripped);
  assert.equal(parsed.approval_mode, "human");
  assert.equal(parsed.policy_id, "");
});

test("the fence parser rejects a missing fence", () => {
  assert.throws(() => parseChangeset("no fence here"));
});

test("changeset ids are validated against a closed shape", () => {
  for (const ok of ["2026-08", "2026-08-peer", "2026-08-committee", "2026-08-auto", "2026-08-peer-auto"]) {
    assert.equal(isValidChangesetId(ok), true, ok);
  }
  for (const bad of ["../../etc/passwd", "2026-08/../x", "2026-8", "latest", "", "2026-08-bogus"]) {
    assert.equal(isValidChangesetId(bad), false, bad);
  }
});

test("changesetRepoPath is the GitHub-relative path", () => {
  assert.equal(changesetRepoPath("2026-08"), "data/enrich/changesets/2026-08.md");
});

test("serializing a policy lane explains it applied without review", () => {
  const text = serializeChangeset(
    changeset([change()], { approval_mode: "policy", policy_id: "auto-v1" }),
  );
  assert.match(text, /without human sign-off/);
  assert.doesNotMatch(text, /Review at \/admin\/enrich/);
});

test("decisions from the frontmatter survive when the body has none", () => {
  const cs = changeset([change({ status: "needs_human" })]);
  const decisions: Record<string, Decision> = { [changeId(cs.changes[0])]: "reject" };
  const text = serializeChangeset(cs, decisions);
  const bodyless = text.slice(0, text.indexOf("\n---\n") + 5);
  assert.equal(parseChangeset(bodyless + "\n").decisions[changeId(cs.changes[0])], "reject");
});
