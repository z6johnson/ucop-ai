/**
 * Minimal GitHub API wrapper — the repo is the database.
 *
 * On Vercel the serverless filesystem is read-only, so every write goes
 * through the Contents / Git Data API and lands as a commit on the configured
 * branch; the standard Git integration then rebuilds the site. That is how
 * memos publish, how the activity feed grows, and how enrichment decisions
 * are recorded.
 *
 * Reads matter too: anything written this way is invisible to the deployed
 * bundle until the rebuild finishes (~60s), so surfaces that must reflect a
 * just-saved write read back through getRepoFileText rather than the disk.
 *
 * Also wraps workflow_dispatch, so the app can hand work that needs a real
 * checkout — applying a reviewed changeset, running Python — to Actions.
 */

import "server-only";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "ucnfi-memos";

export class GitHubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitHubApiError";
  }
}

type GitHubConfig = {
  token: string;
  repo: string; // owner/repo
  branch: string;
};

function config(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token) throw new GitHubApiError(500, "GITHUB_TOKEN is not set.");
  if (!repo || !repo.includes("/")) {
    throw new GitHubApiError(
      500,
      "GITHUB_REPO must be set in the form owner/repo.",
    );
  }
  return {
    token,
    repo,
    branch: process.env.GITHUB_BRANCH?.trim() || "main",
  };
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

export async function getFileSha(path: string): Promise<string | null> {
  const { token, repo, branch } = config();
  const url = `${API_BASE}/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub GET contents failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? null;
}

/**
 * Read a file's current UTF-8 text from the configured branch, or null if it
 * doesn't exist (404). Used to read the append-only activity JSONL and the
 * seen ledger before adding a manually-curated item.
 */
export async function getRepoFileText(path: string): Promise<string | null> {
  const { token, repo, branch } = config();
  const url = `${API_BASE}/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub GET contents failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (typeof data.content !== "string") return "";
  // The Contents API returns base64 (newline-wrapped) regardless of encoding.
  return Buffer.from(data.content, "base64").toString("utf-8");
}

/**
 * One file to include in a multi-file commit. Provide either UTF-8 `content`
 * (text) or pre-encoded `contentBase64` (binary, e.g. an uploaded PDF).
 */
export type CommitFile =
  | { path: string; content: string }
  | { path: string; contentBase64: string };

export type CommitFilesResult = {
  commitSha: string;
  htmlUrl: string;
};

/**
 * Commit several files (text and/or binary) in a single atomic commit via the
 * Git Data API. One commit → one Vercel rebuild, and no per-file read-modify-
 * write race: only the final ref update can conflict, which we retry once.
 *
 * Used by the manual "add to activity feed" flow to land an uploaded asset,
 * the appended items JSONL, and the updated seen ledger together.
 */
export async function commitFiles(params: {
  message: string;
  files: CommitFile[];
  committer?: { name: string; email: string };
}): Promise<CommitFilesResult> {
  const { token, repo, branch } = config();
  const h = headers(token);
  const jsonHeaders = { ...h, "Content-Type": "application/json" };

  async function gh<T>(
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${API_BASE}/repos/${repo}${apiPath}`, {
      method,
      headers: body ? jsonHeaders : h,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubApiError(
        res.status,
        `GitHub ${method} ${apiPath} failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  // Create the blobs once — they're content-addressed and independent of the
  // branch tip, so they survive a ref-conflict retry.
  const blobs = await Promise.all(
    params.files.map(async (f) => {
      const isBinary = "contentBase64" in f;
      const blob = await gh<{ sha: string }>("POST", "/git/blobs", {
        content: isBinary ? f.contentBase64 : f.content,
        encoding: isBinary ? "base64" : "utf-8",
      });
      return { path: f.path, sha: blob.sha };
    }),
  );

  // Branch names may contain slashes (e.g. "release/1.x"); percent-encoding
  // them would break the ref path, so encode each segment but keep the "/".
  const branchRef = branch.split("/").map(encodeURIComponent).join("/");

  const attempt = async (): Promise<CommitFilesResult> => {
    const ref = await gh<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${branchRef}`,
    );
    const parentSha = ref.object.sha;
    const parentCommit = await gh<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${parentSha}`,
    );
    const tree = await gh<{ sha: string }>("POST", "/git/trees", {
      base_tree: parentCommit.tree.sha,
      tree: blobs.map((b) => ({
        path: b.path,
        mode: "100644",
        type: "blob",
        sha: b.sha,
      })),
    });
    const commit = await gh<{ sha: string; html_url: string }>(
      "POST",
      "/git/commits",
      {
        message: params.message,
        tree: tree.sha,
        parents: [parentSha],
        ...(params.committer ? { committer: params.committer } : {}),
      },
    );
    await gh("PATCH", `/git/refs/heads/${branchRef}`, {
      sha: commit.sha,
      force: false,
    });
    return { commitSha: commit.sha, htmlUrl: commit.html_url };
  };

  try {
    return await attempt();
  } catch (err) {
    // A concurrent write (another manual add, or the daily scan pushing to the
    // same branch) moves the tip and the non-fast-forward PATCH 422s. Rebuild
    // the tree on the new tip and retry once.
    if (err instanceof GitHubApiError && (err.status === 422 || err.status === 409)) {
      return await attempt();
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Directory listing                                                   */
/* ------------------------------------------------------------------ */

export type RepoDirEntry = {
  name: string;
  path: string;
  sha: string;
  size: number;
};

/**
 * Lists a directory on the configured branch. Empty when the path is missing
 * or is a file rather than a directory — callers treat "no changesets" and
 * "no changesets directory" identically.
 */
export async function listRepoDir(path: string): Promise<RepoDirEntry[]> {
  const { token, repo, branch } = config();
  const url = `${API_BASE}/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub GET contents (dir) failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>)
    .filter((e) => e.type === "file")
    .map((e) => ({
      name: String(e.name ?? ""),
      path: String(e.path ?? ""),
      sha: String(e.sha ?? ""),
      size: Number(e.size ?? 0),
    }));
}

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

/**
 * Triggers a workflow_dispatch run.
 *
 * The fine-grained PAT needs `Actions: Read and write` on top of `Contents`;
 * without it this 403s with a message that reads like a bad token. The
 * workflow file must also already exist on the repo's default branch —
 * GitHub resolves workflow_dispatch there regardless of `ref`.
 *
 * Returns 204 with an empty body and no run id, so callers poll
 * listWorkflowRuns to find the run they started.
 */
export async function dispatchWorkflow(params: {
  workflowFile: string;
  ref?: string;
  inputs?: Record<string, string>;
}): Promise<void> {
  const { token, repo, branch } = config();
  const url = `${API_BASE}/repos/${repo}/actions/workflows/${encodeURIComponent(params.workflowFile)}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: params.ref ?? branch,
      ...(params.inputs ? { inputs: params.inputs } : {}),
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub workflow dispatch failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  // 204 No Content — deliberately not parsed.
}

export type WorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  event: string;
};

export async function listWorkflowRuns(
  workflowFile: string,
  opts: { perPage?: number; branch?: string } = {},
): Promise<WorkflowRun[]> {
  const { token, repo, branch } = config();
  const params = new URLSearchParams({
    per_page: String(opts.perPage ?? 10),
    branch: opts.branch ?? branch,
  });
  const url = `${API_BASE}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${params}`;
  const res = await fetch(url, { headers: headers(token), cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub list workflow runs failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  return (data.workflow_runs ?? []).map((r) => ({
    id: Number(r.id ?? 0),
    status: String(r.status ?? ""),
    conclusion: r.conclusion == null ? null : String(r.conclusion),
    html_url: String(r.html_url ?? ""),
    created_at: String(r.created_at ?? ""),
    event: String(r.event ?? ""),
  }));
}

export type PutFileResult = {
  sha: string;
  commitSha: string;
  htmlUrl: string;
};

/**
 * Creates or updates a single file.
 *
 * `sha` is required by GitHub to update an existing path — omitting it gets a
 * 422 — and it doubles as the concurrency check: pass the sha the caller
 * read, and a file that moved underneath them fails loudly instead of being
 * clobbered. Callers that genuinely mean "create" omit it.
 */
export async function putFile(params: {
  path: string;
  message: string;
  content: string; // raw UTF-8
  sha?: string;
  committer?: { name: string; email: string };
}): Promise<PutFileResult> {
  const { token, repo, branch } = config();
  const url = `${API_BASE}/repos/${repo}/contents/${encodeURI(params.path)}`;
  const body = {
    message: params.message,
    content: Buffer.from(params.content, "utf-8").toString("base64"),
    branch,
    ...(params.sha ? { sha: params.sha } : {}),
    ...(params.committer ? { committer: params.committer } : {}),
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub PUT contents failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    content?: { sha?: string };
    commit?: { sha?: string; html_url?: string };
  };
  return {
    sha: data.content?.sha ?? "",
    commitSha: data.commit?.sha ?? "",
    htmlUrl: data.commit?.html_url ?? "",
  };
}
