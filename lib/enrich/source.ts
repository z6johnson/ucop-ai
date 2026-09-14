/**
 * Changeset reads for the app.
 *
 * The review queue cannot read changesets off disk. On Vercel the bundled
 * filesystem is a snapshot of the last build, so a decision saved a moment
 * ago would not appear until the rebuild finished — the reviewer would click
 * Approve, reload, and watch their work vanish. Reading through the Contents
 * API instead makes a save visible immediately.
 *
 * It also fixes a quieter bug: pages that read changesets via readdirSync are
 * not traced into the serverless bundle by next.config.ts, so /about's data
 * status section has most likely been showing nothing at all in production.
 *
 * Falls back to the filesystem when GitHub isn't configured, so local dev and
 * the CLI scripts behave identically without a token.
 */

import "server-only";

import { getFileSha, getRepoFileText, listRepoDir } from "../github.ts";
import {
  changesetRepoPath,
  isValidChangesetId,
  parseChangeset,
  type ParsedChangeset,
} from "./changeset-format.ts";
import { summarizeChangeset, type ChangesetSummary } from "./history.ts";
import { readChangeset } from "./storage.ts";

const CHANGESETS_DIR = "data/enrich/changesets";

/**
 * The workflow the app dispatches to publish a reviewed changeset. Lives here
 * rather than in a route file so both the publish and status routes can share
 * it — Next.js route modules should only export request handlers and config.
 */
export const APPLY_WORKFLOW = "enrich-apply.yml";

export type LoadedChangeset = {
  parsed: ParsedChangeset;
  /**
   * Blob sha of the file as read. Passed back on save so a concurrent edit
   * conflicts instead of being overwritten. Null when read from disk, where
   * there is nothing to be concurrent with.
   */
  sha: string | null;
  source: "github" | "fs";
};

/** Whether the GitHub-backed path is available; otherwise we read from disk. */
export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

export async function loadChangeset(changesetId: string): Promise<LoadedChangeset | null> {
  if (!isValidChangesetId(changesetId)) return null;

  if (!githubConfigured()) {
    const parsed = readChangeset(process.cwd(), changesetId);
    return parsed ? { parsed, sha: null, source: "fs" } : null;
  }

  const path = changesetRepoPath(changesetId);
  const [text, sha] = await Promise.all([getRepoFileText(path), getFileSha(path)]);
  if (text === null) return null;
  return { parsed: parseChangeset(text), sha, source: "github" };
}

/**
 * Every changeset, summarized. Fetched in parallel — there are a handful of
 * files totalling a few hundred KB, so the round trips dominate, not the
 * bytes.
 */
export async function allChangesetSummaries(): Promise<ChangesetSummary[]> {
  const ids = await listChangesetIdsRemote();
  const loaded = await Promise.all(
    ids.map(async (id) => {
      try {
        return await loadChangeset(id);
      } catch {
        // One malformed changeset must not blank the whole status page.
        console.error(`[enrich/source] failed to load changeset ${id}`);
        return null;
      }
    }),
  );
  return loaded
    .filter((l): l is LoadedChangeset => l !== null)
    .map((l) => summarizeChangeset(l.parsed.changeset, l.parsed.decisions));
}

async function listChangesetIdsRemote(): Promise<string[]> {
  if (!githubConfigured()) {
    const { listChangesetIds } = await import("./storage.ts");
    return listChangesetIds(process.cwd());
  }
  const entries = await listRepoDir(CHANGESETS_DIR);
  return entries
    .filter((e) => e.name.endsWith(".md"))
    .map((e) => e.name.slice(0, -".md".length))
    .filter(isValidChangesetId)
    .sort();
}

/* ------------------------------------------------------------------ */
/* Convenience views                                                   */
/* ------------------------------------------------------------------ */

/** Drafts a human still has to work through — the review inbox. */
export async function pendingReview(): Promise<ChangesetSummary[]> {
  return (await allChangesetSummaries())
    .filter((s) => s.status === "draft" && s.approval_mode === "human")
    .sort((a, b) => b.run_date.localeCompare(a.run_date));
}

/** Applied refreshes, newest first, both lanes. */
export async function appliedRefreshes(): Promise<ChangesetSummary[]> {
  return (await allChangesetSummaries())
    .filter((s) => s.status === "applied")
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at));
}
