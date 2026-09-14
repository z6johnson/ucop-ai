/**
 * Backfill the decisions ledger from changesets already applied.
 *
 * The ledger only starts recording from the first apply that runs the new
 * code, which would leave the reviewer's existing work invisible: the June
 * changeset carries 41 explicit rejections, and without seeding them the very
 * next monthly run would re-propose all 41 exactly as August already did.
 *
 * Reads every applied changeset, records its accept/reject decisions, and
 * stamps each with that changeset's applied_at rather than "now" — a decision
 * made in June should age out on June's clock, not restart its six months
 * because we got around to writing it down today.
 *
 * Idempotent. Safe to re-run; later changesets win on the same coordinate.
 *
 * Usage:
 *   npm run seed:decisions
 *   npm run seed:decisions -- --dry-run
 */

import { isoNowUTC } from "../lib/activity.ts";
import {
  pruneDecisions,
  readDecisionsLedger,
  recordDecisions,
  writeDecisionsLedger,
  type DecisionsLedger,
} from "../lib/enrich/decisions.ts";
import { listChangesetIds, readChangeset } from "../lib/enrich/storage.ts";

const REPO_ROOT = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");

function main(): void {
  const ledger: DecisionsLedger = readDecisionsLedger(REPO_ROOT);
  const before = Object.keys(ledger).length;

  // Oldest first, so a later reversal on the same coordinate wins.
  const ids = listChangesetIds(REPO_ROOT).sort();
  let seeded = 0;

  for (const id of ids) {
    const parsed = readChangeset(REPO_ROOT, id);
    if (!parsed) continue;
    const { changeset, decisions } = parsed;

    // Only applied changesets carry final decisions. A draft's DECISION lines
    // are a work in progress — recording them would suppress proposals the
    // reviewer never actually signed off on.
    if (changeset.status !== "applied") {
      console.info(`[seed] skipping ${id} (status=${changeset.status})`);
      continue;
    }

    const decidedAt = changeset.applied_at || changeset.reviewed_at || `${changeset.run_date}T00:00:00Z`;
    const countBefore = Object.keys(ledger).length;
    recordDecisions(ledger, {
      changes: changeset.changes,
      decisions,
      decidedBy: changeset.reviewed_by || "unknown",
      changesetId: id,
      nowIso: decidedAt,
    });
    const added = Object.keys(ledger).length - countBefore;
    seeded += added;

    const tally = { accept: 0, reject: 0, review: 0 };
    for (const c of changeset.changes) {
      const d = decisions[`${c.entity_id}.${c.dimension}.${c.field}`] ?? "review";
      tally[d] += 1;
    }
    console.info(
      `[seed] ${id} (applied ${decidedAt.slice(0, 10)}, by ${changeset.reviewed_by || "unknown"}) — ` +
        `${tally.accept} accept · ${tally.reject} reject · ${tally.review} undecided · +${added} new entries`,
    );
  }

  const beforePrune = Object.keys(ledger).length;
  pruneDecisions(ledger, isoNowUTC());
  const total = Object.keys(ledger).length;
  console.info(
    `\n[seed] ${before} existing + ${seeded} seeded → ${total} live entries ` +
      `(${beforePrune - total} already past the suppression window).`,
  );

  if (DRY_RUN) {
    console.info("[seed] dry run — ledger not written.");
    return;
  }
  writeDecisionsLedger(REPO_ROOT, ledger);
  console.info("[seed] wrote data/enrich/decisions_ledger.json");
}

main();
