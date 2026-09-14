/**
 * Changeset storage — the filesystem half of the changeset contract.
 *
 * The format itself (parse, serialize, reviewer edits) lives in
 * ./changeset-format.ts, which touches no node builtins so the review UI can
 * import it. This module adds paths and disk I/O for the CLI scripts, and
 * re-exports the format so every existing `from "./storage.ts"` import keeps
 * working unchanged.
 *
 * Rejected candidates never appear in a changeset; they go to
 * {changeset_id}.rejected.json. Proposals withheld by a standing rejection go
 * to {changeset_id}.suppressed.json (see ./decisions.ts).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  parseChangeset,
  serializeChangeset,
  type Decision,
  type ParsedChangeset,
} from "./changeset-format.ts";
import type { Changeset } from "./types.ts";

export * from "./changeset-format.ts";

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function enrichRoot(repoRoot: string): string {
  return join(repoRoot, "data", "enrich");
}

export function changesetsDir(repoRoot: string): string {
  return join(enrichRoot(repoRoot), "changesets");
}

export function changesetPath(repoRoot: string, changesetId: string): string {
  return join(changesetsDir(repoRoot), `${changesetId}.md`);
}

export function rejectedPath(repoRoot: string, changesetId: string): string {
  return join(changesetsDir(repoRoot), `${changesetId}.rejected.json`);
}

/* ------------------------------------------------------------------ */
/* I/O                                                                 */
/* ------------------------------------------------------------------ */

export function writeChangeset(
  repoRoot: string,
  changeset: Changeset,
  decisions?: Record<string, Decision>,
): string {
  const p = changesetPath(repoRoot, changeset.changeset_id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serializeChangeset(changeset, decisions), "utf-8");
  return p;
}

export function readChangeset(repoRoot: string, changesetId: string): ParsedChangeset | null {
  const p = changesetPath(repoRoot, changesetId);
  if (!existsSync(p)) return null;
  return parseChangeset(readFileSync(p, "utf-8"));
}

export function listChangesetIds(repoRoot: string): string[] {
  const dir = changesetsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .sort();
}

/* ------------------------------------------------------------------ */
/* Rejected sidecar                                                    */
/* ------------------------------------------------------------------ */

export type RejectedRecord = {
  changeset_id: string;
  rejected_at: string;
  candidates: Array<{
    entity_id: string;
    dimension: string;
    field: string;
    reasons: string[];
    raw: unknown;
  }>;
};

export function writeRejected(
  repoRoot: string,
  changesetId: string,
  record: RejectedRecord,
): string {
  const p = rejectedPath(repoRoot, changesetId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + "\n", "utf-8");
  return p;
}
