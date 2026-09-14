import { NextResponse } from "next/server";

import { isoNowUTC } from "@/lib/activity";
import {
  applyReview,
  isValidChangesetId,
  mergeDecisions,
  changesetRepoPath,
} from "@/lib/enrich/changeset-format";
import { githubConfigured, loadChangeset } from "@/lib/enrich/source";
import { GitHubApiError, putFile } from "@/lib/github";
import { changeId } from "@/lib/enrich/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Saves a batch of reviewer decisions onto a draft changeset.
 *
 * Decisions are batched deliberately: the client holds them until the
 * reviewer saves, so working through forty proposals is one commit rather
 * than forty. `baseSha` is the sha the client read, and it is passed straight
 * through to the Contents API — if the file moved in the meantime GitHub
 * refuses the write and we report a conflict instead of overwriting whoever
 * got there first.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidChangesetId(id)) {
    return NextResponse.json({ error: "Invalid changeset id." }, { status: 400 });
  }
  if (!githubConfigured()) {
    // Saving means committing. Say so plainly rather than failing generically
    // and leaving the reviewer wondering whether their decisions were lost.
    return NextResponse.json(
      {
        error:
          "Decisions are saved by committing to the repository, which needs GITHUB_TOKEN and GITHUB_REPO. Reviewing works without them; saving does not.",
      },
      { status: 503 },
    );
  }

  let body: { baseSha?: unknown; decisions?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const baseSha = typeof body.baseSha === "string" ? body.baseSha : "";
  if (!baseSha) {
    return NextResponse.json(
      { error: "baseSha is required — reload the changeset and try again." },
      { status: 400 },
    );
  }
  if (typeof body.decisions !== "object" || body.decisions === null || Array.isArray(body.decisions)) {
    return NextResponse.json({ error: "decisions must be an object." }, { status: 400 });
  }
  const overlay = body.decisions as Record<string, unknown>;
  if (Object.keys(overlay).length === 0) {
    return NextResponse.json({ error: "No decisions to save." }, { status: 400 });
  }

  let loaded;
  try {
    loaded = await loadChangeset(id);
  } catch (err) {
    console.error("[api/enrich] load failed:", err);
    return NextResponse.json({ error: "Could not read the changeset." }, { status: 502 });
  }
  if (!loaded) {
    return NextResponse.json({ error: `Changeset ${id} not found.` }, { status: 404 });
  }

  const { changeset, decisions: current } = loaded.parsed;
  if (changeset.status !== "draft") {
    return NextResponse.json(
      { error: `Changeset ${id} is ${changeset.status} — decisions can no longer change.` },
      { status: 409 },
    );
  }
  if (changeset.approval_mode !== "human") {
    return NextResponse.json(
      { error: "This changeset was applied by policy and is a read-only audit record." },
      { status: 409 },
    );
  }

  const validIds = new Set(changeset.changes.map((c) => changeId(c)));
  const { merged, rejected } = mergeDecisions(current, overlay, validIds);
  if (rejected.length > 0) {
    // Reported rather than dropped: a decision that silently fails to land is
    // worse than an error, because the reviewer believes they decided.
    return NextResponse.json(
      { error: "Unknown or invalid decisions.", rejected: rejected.slice(0, 20) },
      { status: 400 },
    );
  }

  const content = applyReview(loaded.parsed, { overlay: merged });

  try {
    const res = await putFile({
      path: changesetRepoPath(id),
      message: `Review decisions — ${id}`,
      content,
      sha: baseSha,
      committer: { name: "ucnfi-review", email: "ucnfi-review@users.noreply.github.com" },
    });
    const counts = { accept: 0, reject: 0, review: 0 };
    for (const cid of validIds) counts[merged[cid] ?? "review"] += 1;
    return NextResponse.json({
      sha: res.sha,
      commitSha: res.commitSha,
      commitUrl: res.htmlUrl,
      counts,
      savedAt: isoNowUTC(),
    });
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 409 || err.status === 422)) {
      // Someone else wrote to this changeset since it was loaded.
      return NextResponse.json(
        {
          error:
            "This changeset changed since you opened it. Reload to pick up the current decisions, then re-apply yours.",
          conflict: true,
        },
        { status: 409 },
      );
    }
    console.error("[api/enrich] save failed:", err);
    return NextResponse.json({ error: "Could not save decisions." }, { status: 500 });
  }
}
