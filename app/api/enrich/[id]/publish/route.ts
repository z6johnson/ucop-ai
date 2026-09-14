import { NextResponse } from "next/server";

import {
  applyReview,
  changesetRepoPath,
  isValidChangesetId,
  mergeDecisions,
} from "@/lib/enrich/changeset-format";
import { APPLY_WORKFLOW, githubConfigured, loadChangeset } from "@/lib/enrich/source";
import { changeId } from "@/lib/enrich/types";
import { GitHubApiError, dispatchWorkflow, putFile } from "@/lib/github";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Publishes a reviewed changeset.
 *
 * Two steps, in this order and not the other: stamp `reviewed_by` into the
 * changeset and commit it, THEN dispatch the workflow. The workflow checks
 * out the branch and re-reads the file, so the sign-off has to be on the
 * branch before the run starts or apply.ts refuses its own gate.
 *
 * The app never mutates canonical data itself. It records the human's
 * decision; lib/enrich/apply.ts remains the only thing that writes the
 * baseline, and it runs in Actions where there's a checkout to mutate and a
 * python3 for the derived analytics.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidChangesetId(id)) {
    return NextResponse.json({ error: "Invalid changeset id." }, { status: 400 });
  }
  if (id.endsWith("-auto")) {
    return NextResponse.json(
      { error: "The automatic lane is applied unattended and is not publishable here." },
      { status: 409 },
    );
  }
  if (!githubConfigured()) {
    return NextResponse.json(
      {
        error:
          "Publishing commits to the repository and starts a GitHub Actions run, which needs GITHUB_TOKEN and GITHUB_REPO.",
      },
      { status: 503 },
    );
  }

  let body: { baseSha?: unknown; reviewedBy?: unknown; decisions?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const baseSha = typeof body.baseSha === "string" ? body.baseSha : "";
  const reviewedBy = typeof body.reviewedBy === "string" ? body.reviewedBy.trim() : "";
  if (!baseSha) {
    return NextResponse.json({ error: "baseSha is required." }, { status: 400 });
  }
  if (!reviewedBy) {
    return NextResponse.json(
      { error: "Add your name — published data records who approved it." },
      { status: 400 },
    );
  }

  let loaded;
  try {
    loaded = await loadChangeset(id);
  } catch (err) {
    console.error("[api/enrich] publish load failed:", err);
    return NextResponse.json({ error: "Could not read the changeset." }, { status: 502 });
  }
  if (!loaded) {
    return NextResponse.json({ error: `Changeset ${id} not found.` }, { status: 404 });
  }

  const { changeset, decisions: current } = loaded.parsed;
  if (changeset.status !== "draft") {
    return NextResponse.json(
      { error: `Changeset ${id} is already ${changeset.status}.` },
      { status: 409 },
    );
  }
  if (changeset.approval_mode !== "human") {
    return NextResponse.json(
      { error: "This changeset was applied by policy and cannot be published by hand." },
      { status: 409 },
    );
  }

  // Fold in any decisions still unsaved on the client, so Publish never
  // silently drops the last few calls the reviewer made before clicking.
  const validIds = new Set(changeset.changes.map((c) => changeId(c)));
  let merged = current;
  if (typeof body.decisions === "object" && body.decisions !== null && !Array.isArray(body.decisions)) {
    const res = mergeDecisions(current, body.decisions as Record<string, unknown>, validIds);
    if (res.rejected.length > 0) {
      return NextResponse.json(
        { error: "Unknown or invalid decisions.", rejected: res.rejected.slice(0, 20) },
        { status: 400 },
      );
    }
    merged = res.merged;
  }

  const accepted = [...validIds].filter((cid) => merged[cid] === "accept").length;
  if (accepted === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing is approved, so publishing would change nothing. Approve at least one proposal first.",
      },
      { status: 400 },
    );
  }

  const reviewedAt = new Date().toISOString();
  const content = applyReview(loaded.parsed, {
    overlay: merged,
    reviewedBy,
    reviewedAt,
  });

  let commit;
  try {
    commit = await putFile({
      path: changesetRepoPath(id),
      message: `Sign off enrichment changeset ${id} (${reviewedBy})`,
      content,
      sha: baseSha,
      committer: { name: "ucnfi-review", email: "ucnfi-review@users.noreply.github.com" },
    });
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 409 || err.status === 422)) {
      return NextResponse.json(
        {
          error:
            "This changeset changed since you opened it. Reload, re-check your decisions, then publish.",
          conflict: true,
        },
        { status: 409 },
      );
    }
    console.error("[api/enrich] publish commit failed:", err);
    return NextResponse.json({ error: "Could not record the sign-off." }, { status: 500 });
  }

  try {
    await dispatchWorkflow({
      workflowFile: APPLY_WORKFLOW,
      inputs: { changeset_id: id },
    });
  } catch (err) {
    console.error("[api/enrich] dispatch failed:", err);
    const hint =
      err instanceof GitHubApiError && err.status === 403
        ? " The token may be missing the Actions: Read and write permission."
        : "";
    // The sign-off is committed, so this is recoverable — say how.
    return NextResponse.json(
      {
        error:
          `Sign-off was saved, but the publish run could not be started.${hint} ` +
          `Run the "Apply reviewed enrichment changeset" workflow with changeset_id=${id}, ` +
          `or apply it locally with: npm run enrich:apply -- --changeset ${id}`,
        signedOff: true,
        commitUrl: commit.htmlUrl,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    commitSha: commit.commitSha,
    commitUrl: commit.htmlUrl,
    reviewedBy,
    dispatchedAt: reviewedAt,
    accepted,
  });
}
