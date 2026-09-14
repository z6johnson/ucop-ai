/**
 * Apply an enrichment changeset to the canonical data.
 *
 * Two modes, matching the two lanes a monthly run produces:
 *
 *   npm run enrich:apply -- --changeset 2026-08
 *     A reviewed changeset. Refuses unless a human filled reviewed_by —
 *     normally done through /admin/enrich, which stamps it and dispatches
 *     .github/workflows/enrich-apply.yml to run this.
 *
 *   npm run enrich:apply -- --auto-lane
 *     Every pending `*-auto` changeset: changes that met the automatic policy
 *     and carry no human sign-off. Run unattended by the monthly workflow
 *     right after the sweep. ENRICH_AUTO_APPLY=0 disables it, and is honoured
 *     here as well as at generation time — so flipping it stops a lane that
 *     has already been written.
 *
 * Both go through the same gate in lib/enrich/apply.ts, which re-derives
 * auto-eligibility from the changes themselves rather than trusting what a
 * changeset claims about its own approval.
 *
 * Then: appends a version section to data/ENRICHMENT_LOG.md that distinguishes
 * the two lanes, records the decisions so declined proposals are not
 * re-proposed next month, and (for baseline) regenerates the derived analytics
 * via data/compute_derived.py.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { isoNowUTC } from "../lib/activity.ts";
import { applyChangeset, ApplyGateError, type ApplySummary } from "../lib/enrich/apply.ts";
import {
  pruneDecisions,
  readDecisionsLedger,
  recordDecisions,
  writeDecisionsLedger,
} from "../lib/enrich/decisions.ts";
import { listChangesetIds, readChangeset, type ParsedChangeset } from "../lib/enrich/storage.ts";
import type { Changeset } from "../lib/enrich/types.ts";

const REPO_ROOT = process.cwd();
const AUTO_LANE_MODE = process.argv.includes("--auto-lane");
const AUTO_OFF =
  process.env.ENRICH_AUTO_APPLY === "0" || process.env.ENRICH_AUTO_APPLY === "false";

function parseChangesetId(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--changeset");
  const id = i !== -1 ? argv[i + 1] : (argv[0] ?? "");
  if (!id) {
    console.error("[enrich-apply] missing --changeset <id>");
    process.exit(2);
  }
  return id;
}

/**
 * Appends a release note. The two lanes are worded so they can never be
 * mistaken for one another when someone reads back the history — "who
 * approved this?" must be answerable from the log alone.
 */
function appendEnrichmentLog(
  summary: ApplySummary,
  runDate: string,
  changeset: Changeset,
): void {
  const logPath = join(REPO_ROOT, "data", "ENRICHMENT_LOG.md");
  if (!existsSync(logPath)) return;
  const dims = Object.entries(summary.perDimension)
    .map(([d, n]) => `${d} +${n}`)
    .join(", ");

  const provenance =
    changeset.approval_mode === "policy"
      ? `**Policy-applied — no human sign-off** (policy \`${changeset.policy_id}\`).`
      : `Human-approved, reviewed by \`${changeset.reviewed_by}\`.`;

  const section =
    `\n- **v${summary.newVersion}** — Monthly automated enrichment applied ${runDate} ` +
    `(changeset \`${summary.changesetId}\`, target ${summary.target}). ${provenance} ` +
    `${summary.applied} changes (${summary.newFields} new fields, ` +
    `${summary.valueChanges} value updates) across ${summary.touchedEntities.length} entities. ` +
    `Per-dimension: ${dims || "n/a"}. ${summary.skipped} proposed changes were not applied. ` +
    `Changeset and sidecars retained under data/enrich/changesets/.\n`;
  appendFileSync(logPath, section, "utf-8");
  console.info(`[enrich-apply] appended v${summary.newVersion} section to ENRICHMENT_LOG.md`);
}

/**
 * Persists what the reviewer decided so the next monthly run doesn't re-ask.
 *
 * Runs on every apply, including one where nothing was accepted — a changeset
 * of 41 rejections is exactly the case worth remembering, and it was the
 * absence of this step that had August re-proposing all of June's declines.
 */
function recordReviewerDecisions(parsed: ParsedChangeset, changesetId: string): void {
  const { changeset, decisions } = parsed;
  const ledger = readDecisionsLedger(REPO_ROOT);
  const nowIso = isoNowUTC();
  recordDecisions(ledger, {
    changes: changeset.changes,
    decisions,
    decidedBy: changeset.reviewed_by || "unknown",
    changesetId,
    nowIso,
  });
  pruneDecisions(ledger, nowIso);
  writeDecisionsLedger(REPO_ROOT, ledger);
  const decided = changeset.changes.filter((c) => {
    const d = decisions[`${c.entity_id}.${c.dimension}.${c.field}`];
    return d === "accept" || d === "reject";
  }).length;
  console.info(
    `[enrich-apply] recorded ${decided} decision(s) to data/enrich/decisions_ledger.json — ` +
      `declined proposals will not be re-proposed while the rejection stands.`,
  );
}

function recomputeDerived(target: string): void {
  if (target !== "baseline") return; // derived analytics are computed off the UC baseline only
  const script = join(REPO_ROOT, "data", "compute_derived.py");
  if (!existsSync(script)) {
    console.warn("[enrich-apply] compute_derived.py not found — skipping derived recompute");
    return;
  }
  const res = spawnSync("python3", [script], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.warn(`[enrich-apply] compute_derived.py exited ${res.status} — recompute derived manually`);
  } else {
    console.info("[enrich-apply] regenerated data/uc_ai_derived.json");
  }
}

/** Applies one changeset. Returns false if its gate refused. */
function applyOne(changesetId: string): boolean {
  const parsed = readChangeset(REPO_ROOT, changesetId);
  if (!parsed) {
    console.error(`[enrich-apply] changeset ${changesetId} not found under data/enrich/changesets/`);
    return false;
  }

  let summary: ApplySummary;
  try {
    summary = applyChangeset(REPO_ROOT, changesetId, { killSwitch: AUTO_OFF });
  } catch (err) {
    if (err instanceof ApplyGateError) {
      console.error(`[enrich-apply] gate: ${err.message}`);
      return false;
    }
    throw err;
  }

  const how =
    parsed.changeset.approval_mode === "policy"
      ? `under policy ${parsed.changeset.policy_id}`
      : `as reviewed by ${parsed.changeset.reviewed_by}`;
  console.info(
    `[enrich-apply] applied ${summary.applied} changes to ${summary.target} ${how} ` +
      `(v${summary.baseVersion} → v${summary.newVersion}); ${summary.skipped} not applied.`,
  );

  recordReviewerDecisions(parsed, changesetId);

  if (summary.applied > 0) {
    appendEnrichmentLog(summary, parsed.changeset.run_date, parsed.changeset);
    recomputeDerived(summary.target);
  }
  return true;
}

/**
 * Applies every pending auto lane. Used by the monthly workflow immediately
 * after the sweep; each changeset still goes through the same gate, which
 * re-derives eligibility rather than trusting the file.
 */
function applyAutoLanes(): void {
  if (AUTO_OFF) {
    console.info("[enrich-apply] ENRICH_AUTO_APPLY=0 — skipping the automatic lane entirely.");
    return;
  }
  const ids = listChangesetIds(REPO_ROOT).filter((id) => id.endsWith("-auto"));
  const pending = ids.filter((id) => readChangeset(REPO_ROOT, id)?.changeset.status === "draft");

  if (pending.length === 0) {
    console.info("[enrich-apply] no pending automatic lanes.");
    return;
  }
  console.info(`[enrich-apply] applying ${pending.length} automatic lane(s): ${pending.join(", ")}`);

  let failed = 0;
  for (const id of pending) {
    if (!applyOne(id)) failed += 1;
  }
  if (failed > 0) {
    console.error(`[enrich-apply] ${failed} automatic lane(s) were refused — see above.`);
    process.exit(3);
  }
}

function main(): void {
  if (AUTO_LANE_MODE) {
    applyAutoLanes();
    console.info("[enrich-apply] done. Commit data/ — canonical files, changesets, log, ledger.");
    return;
  }

  const changesetId = parseChangesetId();
  if (changesetId.endsWith("-auto")) {
    console.error(
      `[enrich-apply] ${changesetId} is an automatic lane; apply it with --auto-lane, ` +
        `not as a reviewed changeset.`,
    );
    process.exit(2);
  }
  if (!applyOne(changesetId)) process.exit(3);

  console.info(
    `[enrich-apply] done. Commit the canonical file, the updated changeset (status=applied), ` +
      `ENRICHMENT_LOG.md, the decisions ledger, and any regenerated derived JSON together.`,
  );
}

main();
