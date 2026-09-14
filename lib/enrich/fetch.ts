/**
 * Source re-fetcher.
 *
 * Re-fetches a known source URL and returns a content hash so the ledger can
 * detect change / staleness / death. Reuses the resilient fetch shape from
 * lib/scan/feeds.ts (AbortController, 15s timeout) and never throws — one
 * dead PDF must not sink the whole monthly sweep.
 *
 * Sends the browser-leaning UA from lib/http.ts: campus WAFs 403 a bare tool
 * UA, and lib/enrich/ledger.ts used to read that 403 as the page being gone.
 *
 * PDFs are not parsed here. The hash is computed over the raw bytes so we can
 * tell when a PDF changed; the model reads the live document itself during
 * extraction (via web_search / the URL), avoiding a new PDF dependency.
 */

import { createHash } from "node:crypto";

import { BROWSER_USER_AGENT, FETCH_TIMEOUT_MS, HTML_ACCEPT } from "../http.ts";
import type { InventorySource } from "./types.ts";

export type FetchOutcome = {
  ok: boolean;
  status: number | "error";
  /** Decoded text for web pages; null on failure. */
  body: string | null;
  /** sha256 hex of the fetched bytes, or null on failure. */
  contentHash: string | null;
};

export async function fetchSource(src: Pick<InventorySource, "url" | "type">): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(src.url, {
      signal: controller.signal,
      headers: { "user-agent": BROWSER_USER_AGENT, accept: HTML_ACCEPT },
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, contentHash: null };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentHash = createHash("sha256").update(buf).digest("hex");
    // Only decode text for non-PDF sources; PDFs are hashed as bytes only.
    const body = src.type === "pdf" ? null : buf.toString("utf-8");
    return { ok: true, status: res.status, body, contentHash };
  } catch {
    return { ok: false, status: "error", body: null, contentHash: null };
  } finally {
    clearTimeout(timer);
  }
}
