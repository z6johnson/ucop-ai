import { NextResponse } from "next/server";

import { isValidChangesetId } from "@/lib/enrich/changeset-format";
import { APPLY_WORKFLOW, githubConfigured, loadChangeset } from "@/lib/enrich/source";
import { listWorkflowRuns } from "@/lib/github";

export const runtime = "nodejs";

/** A dispatched run can take a few seconds to appear; don't miss it by a hair. */
const RUN_MATCH_SLACK_MS = 10_000;

/**
 * Progress for a publish in flight.
 *
 * The changeset's own status is the authoritative answer — it flips to
 * `applied` in the same commit the workflow pushes, so if it says applied,
 * the data landed. The workflow run is supplementary: it gives the reviewer
 * something to watch while waiting, and a link to the logs when it fails.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidChangesetId(id)) {
    return NextResponse.json({ error: "Invalid changeset id." }, { status: 400 });
  }

  let loaded;
  try {
    loaded = await loadChangeset(id);
  } catch (err) {
    console.error("[api/enrich] status load failed:", err);
    return NextResponse.json({ error: "Could not read the changeset." }, { status: 502 });
  }
  if (!loaded) {
    return NextResponse.json({ error: `Changeset ${id} not found.` }, { status: 404 });
  }
  const { changeset } = loaded.parsed;

  const since = new URL(req.url).searchParams.get("since");
  let run = null;
  if (since && githubConfigured()) {
    const cutoff = Date.parse(since) - RUN_MATCH_SLACK_MS;
    try {
      const runs = await listWorkflowRuns(APPLY_WORKFLOW, { perPage: 10 });
      run =
        runs.find(
          (r) =>
            r.event === "workflow_dispatch" &&
            Number.isFinite(cutoff) &&
            Date.parse(r.created_at) >= cutoff,
        ) ?? null;
    } catch (err) {
      // A missing workflow or a token without Actions:read shouldn't break the
      // page — the changeset status alone still answers "did it publish?".
      console.error("[api/enrich] run lookup failed:", err);
    }
  }

  return NextResponse.json({
    changesetStatus: changeset.status,
    appliedAt: changeset.applied_at,
    targetVersion: changeset.target_version,
    reviewedBy: changeset.reviewed_by,
    run,
  });
}
