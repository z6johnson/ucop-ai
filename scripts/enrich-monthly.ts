/**
 * Monthly shared-picture enrichment — proposal stage (cron entry point).
 *
 * Refreshes known sources, runs a full entity×dimension discovery sweep,
 * extracts candidate fields, validates + diffs them, and writes a DRAFT
 * changeset under data/enrich/changesets/. It NEVER mutates the canonical
 * baseline / peer / committee files — that is enrich-apply.ts, behind the
 * human-review gate.
 *
 * Usage:
 *   npm run enrich:monthly                         # all targets, full sweep
 *   TARGET=baseline npm run enrich:monthly         # one target
 *   DRY_RUN=1 npm run enrich:monthly               # build, print, write nothing
 *   RUN_DATE=2026-06-01 npm run enrich:monthly     # anchor the run date
 *   FULL_SWEEP=0 npm run enrich:monthly            # changed-cells only (cheap)
 *   MAX_ENTITIES=2 npm run enrich:monthly          # smoke run
 *
 * Env required: LITELLM_API_KEY
 * Optional: ENRICH_MODEL (committee re-verification + the generated_by_model
 *           stamp — needs a Claude model, since committee verification uses
 *           Anthropic's web_search tool; see lib/enrich/committee_verify.ts),
 *           EXTRACT_MODEL (field extraction — open-weight by default, see
 *           lib/enrich/extract.ts), TARGET, LOOKBACK_DAYS (default 35),
 *           FULL_SWEEP, RUN_DATE (YYYY-MM-DD), MAX_ENTITIES
 */

import { isoNowUTC } from "../lib/activity.ts";
import { CLAUDE_MODEL } from "../lib/litellm.ts";
import { knownFieldsFor } from "../lib/enrich/apply.ts";
import {
  readDecisionsLedger,
  toSuppressedRecord,
  writeSuppressed,
} from "../lib/enrich/decisions.ts";
import { AUTO_POLICY_ID, isAutoEligible, type PolicyContext } from "../lib/enrich/diff.ts";
import { runFieldEnrichment } from "../lib/enrich/run.ts";
import { runCommitteeEnrichment } from "../lib/enrich/committee_verify.ts";
import {
  serializeChangeset,
  writeChangeset,
  writeRejected,
} from "../lib/enrich/storage.ts";
import { changeId, ENRICH_TARGETS, type Changeset, type EnrichTarget } from "../lib/enrich/types.ts";

const REPO_ROOT = process.cwd();
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
/**
 * Kill switch for automatic publishing. Resolved at the edge so the policy
 * function itself stays pure; also re-checked at apply time, so flipping it
 * blocks an auto lane that has already been generated.
 */
const AUTO_OFF =
  process.env.ENRICH_AUTO_APPLY === "0" || process.env.ENRICH_AUTO_APPLY === "false";
const MODEL = process.env.ENRICH_MODEL || CLAUDE_MODEL;
const LOOKBACK_DAYS = process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) : 35;
const FULL_SWEEP = process.env.FULL_SWEEP !== "0" && process.env.FULL_SWEEP !== "false";
const MAX_ENTITIES = process.env.MAX_ENTITIES ? Number(process.env.MAX_ENTITIES) : undefined;

function parseRunDate(): Date {
  const raw = process.env.RUN_DATE?.trim();
  if (!raw) return new Date();
  const t = Date.parse(raw + "T12:00:00Z");
  if (!Number.isFinite(t)) {
    console.error(`[enrich] invalid RUN_DATE=${raw}; expected YYYY-MM-DD`);
    process.exit(2);
  }
  return new Date(t);
}

function selectedTargets(): EnrichTarget[] {
  const raw = (process.env.TARGET || "all").trim().toLowerCase();
  if (raw === "all") return [...ENRICH_TARGETS];
  if ((ENRICH_TARGETS as readonly string[]).includes(raw)) return [raw as EnrichTarget];
  console.error(`[enrich] invalid TARGET=${raw}; expected one of all|${ENRICH_TARGETS.join("|")}`);
  process.exit(2);
}

async function runTarget(target: EnrichTarget, runDate: Date) {
  if (target === "committee") {
    return runCommitteeEnrichment({ repoRoot: REPO_ROOT, runDate, model: MODEL, lookbackDays: LOOKBACK_DAYS, maxEntities: MAX_ENTITIES });
  }
  return runFieldEnrichment({
    repoRoot: REPO_ROOT,
    target,
    runDate,
    model: MODEL,
    lookbackDays: LOOKBACK_DAYS,
    fullSweep: FULL_SWEEP,
    maxEntities: MAX_ENTITIES,
    dryRun: DRY_RUN,
  });
}

async function main(): Promise<void> {
  const runDate = parseRunDate();
  const targets = selectedTargets();
  console.info(
    `[enrich] start run_date=${runDate.toISOString().slice(0, 10)} targets=${targets.join(",")} ` +
      `full_sweep=${FULL_SWEEP} lookback=${LOOKBACK_DAYS} model=${MODEL} dry_run=${DRY_RUN}`,
  );

  for (const target of targets) {
    const { changeset, rejected, suppressed } = await runTarget(target, runDate);
    const m = changeset.inputs_manifest;
    console.info(
      `[enrich] ${target} changeset=${changeset.changeset_id} changes=${changeset.changes.length} ` +
        `rejected=${rejected.length} suppressed=${suppressed.length} ` +
        `(refreshed=${m.sources_refreshed} changed=${m.sources_changed} ` +
        `dead=${m.sources_dead} blocked=${m.sources_blocked ?? 0} discovered=${m.sources_discovered})`,
    );
    const needsHuman = changeset.changes.filter((c) => c.status === "needs_human").length;
    console.info(`[enrich] ${target} auto-accepted=${changeset.changes.length - needsHuman} needs_human=${needsHuman}`);
    if (suppressed.length > 0) {
      console.info(
        `[enrich] ${target} withheld ${suppressed.length} proposal(s) already declined in identical ` +
          `form — see ${changeset.changeset_id}.suppressed.json`,
      );
    }

    if (DRY_RUN) {
      console.info(`[enrich] dry run — ${target} changeset follows:\n---`);
      console.info(serializeChangeset(changeset));
      continue;
    }

    // Split into lanes. The auto lane is applied unattended right after this
    // run; the human lane becomes the review queue. They are separate files
    // so the audit trail never has to claim a review that did not happen.
    const ctx: PolicyContext = {
      target,
      killSwitch: AUTO_OFF,
      knownFields: knownFieldsFor(REPO_ROOT, target),
    };
    const auto = changeset.changes.filter((c) => isAutoEligible(c, ctx));
    const human = changeset.changes.filter((c) => !isAutoEligible(c, ctx));
    console.info(
      `[enrich] ${target} lanes: ${auto.length} publish automatically, ${human.length} need review` +
        (AUTO_OFF ? " (automatic publishing is off)" : ""),
    );

    if (auto.length > 0) {
      const autoChangeset: Changeset = {
        ...changeset,
        changeset_id: `${changeset.changeset_id}-auto`,
        approval_mode: "policy",
        policy_id: AUTO_POLICY_ID,
        // Every change here is auto-eligible by construction, so each carries
        // an explicit accept; the applier re-derives eligibility regardless.
        changes: auto.map((c) => ({ ...c, status: "accepted" as const })),
      };
      const out = writeChangeset(
        REPO_ROOT,
        autoChangeset,
        Object.fromEntries(auto.map((c) => [changeId(c), "accept" as const])),
      );
      console.info(`[enrich] wrote ${out}`);
    }

    if (human.length > 0 || rejected.length > 0) {
      const humanChangeset: Changeset = {
        ...changeset,
        approval_mode: "human",
        policy_id: "",
        // Anything in this lane failed the automatic bar, so nothing here is
        // pre-approved — every one of them starts undecided.
        changes: human.map((c) => ({ ...c, status: "needs_human" as const })),
      };
      const out = writeChangeset(REPO_ROOT, humanChangeset);
      console.info(`[enrich] wrote ${out}`);
    } else {
      console.info(`[enrich] ${target}: nothing needs review`);
    }
    if (rejected.length > 0) {
      const rp = writeRejected(REPO_ROOT, changeset.changeset_id, {
        changeset_id: changeset.changeset_id,
        rejected_at: isoNowUTC(),
        candidates: rejected,
      });
      console.info(`[enrich] wrote rejection sidecar ${rp} (${rejected.length})`);
    }
    if (suppressed.length > 0) {
      // Withholding must be auditable: the sidecar names every held-back
      // proposal and the decision holding it back.
      const sp = writeSuppressed(
        REPO_ROOT,
        changeset.changeset_id,
        toSuppressedRecord(
          changeset.changeset_id,
          suppressed,
          readDecisionsLedger(REPO_ROOT),
          isoNowUTC(),
        ),
      );
      console.info(`[enrich] wrote suppression sidecar ${sp} (${suppressed.length})`);
    }
  }

  if (!DRY_RUN) {
    console.info(
      `[enrich] draft changesets are at data/enrich/changesets/. ` +
        `Review them at /admin/enrich.`,
    );
  }
}

main().catch((err) => {
  console.error("[enrich] fatal:", err);
  process.exit(1);
});
