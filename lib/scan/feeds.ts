/**
 * Tier-1 collectors: structured feeds with deterministic shape.
 *
 * - RSS / Atom feeds (member personal site, lab page, Substack)
 * - arXiv public Atom API, queried by author
 *
 * Google Scholar has no public API, so it's intentionally skipped here;
 * Scholar items, when they matter, surface via Tier-2 web search.
 *
 * Items returned by these collectors are filtered to AI-relevant
 * keywords as a coarse pre-filter before the weekly digest reasons
 * about them more carefully.
 */

import { XMLParser } from "fast-xml-parser";

import {
  type ActivityItem,
  type ActivityScope,
  type FeedConfig,
  itemId,
  isoNowUTC,
} from "../activity.ts";
import { BOT_USER_AGENT, FEED_ACCEPT, FETCH_TIMEOUT_MS } from "../http.ts";

/* ------------------------------------------------------------------ */
/* Generic XML parser                                                  */
/* ------------------------------------------------------------------ */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

type RawEntry = {
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
};

/* ------------------------------------------------------------------ */
/* Keyword pre-filter                                                  */
/* ------------------------------------------------------------------ */

const AI_KEYWORDS = [
  "artificial intelligence",
  "machine learning",
  "deep learning",
  "neural network",
  "neural networks",
  "transformer",
  "generative",
  "large language model",
  "large language models",
  "foundation model",
  "foundation models",
  "responsible ai",
  "ai governance",
  "ai safety",
  "ai policy",
  "ai ethics",
  "ai literacy",
  "chatbot",
  "llm",
  "llms",
  "gpt",
  "claude",
  "gemini",
];

const AI_TOKEN_REGEX = /\b(ai|a\.i\.)\b/i;

function isAiRelevant(text: string): boolean {
  const lower = text.toLowerCase();
  for (const k of AI_KEYWORDS) {
    if (lower.includes(k)) return true;
  }
  return AI_TOKEN_REGEX.test(text);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": BOT_USER_AGENT, Accept: FEED_ACCEPT },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* RSS / Atom                                                          */
/* ------------------------------------------------------------------ */

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function pickText(node: unknown): string {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    const t = (node as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t : "";
  }
  return "";
}

function pickLink(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    const alt = node.find((l) => typeof l === "object" && l && "@_rel" in l && l["@_rel"] === "alternate");
    const chosen = alt ?? node[0];
    if (chosen && typeof chosen === "object" && "@_href" in chosen) {
      return String(chosen["@_href"] ?? "");
    }
    return "";
  }
  if (node && typeof node === "object" && "@_href" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["@_href"] ?? "");
  }
  return "";
}

function parseFeed(xml: string): RawEntry[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }
  const root = parsed as Record<string, unknown>;

  // RSS 2.0
  const rss = root.rss as Record<string, unknown> | undefined;
  if (rss?.channel) {
    const channel = rss.channel as Record<string, unknown>;
    return asArray<Record<string, unknown>>(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined).map((item) => ({
      title: pickText(item.title) || String(item.title ?? ""),
      url: pickText(item.link) || String(item.link ?? ""),
      publishedAt: parseDate(String(item.pubDate ?? item["dc:date"] ?? "")),
      summary: stripHtml(pickText(item.description) || String(item.description ?? "")),
    }));
  }

  // Atom
  if (root.feed) {
    const feed = root.feed as Record<string, unknown>;
    return asArray<Record<string, unknown>>(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined).map((entry) => ({
      title: pickText(entry.title) || String(entry.title ?? ""),
      url: pickLink(entry.link),
      publishedAt: parseDate(String(entry.published ?? entry.updated ?? "")),
      summary: stripHtml(pickText(entry.summary) || pickText(entry.content) || ""),
    }));
  }

  return [];
}

function parseDate(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/* ------------------------------------------------------------------ */
/* Public collectors                                                   */
/* ------------------------------------------------------------------ */

export type CollectOptions = {
  /** Only return items published within this many days. Default 2. */
  lookbackDays?: number;
  /** When true, skip the AI-keyword pre-filter (used for arXiv where the query already targets the author). */
  skipKeywordFilter?: boolean;
  /** Scope to stamp on emitted items. Defaults to "member". */
  scope?: ActivityScope;
};

function withinLookback(publishedAt: string | null, lookbackDays: number): boolean {
  if (!publishedAt) return true; // unknown date — include conservatively
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return true;
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return t >= cutoff;
}

async function collectFromRss(
  memberId: string,
  feedUrl: string,
  opts: CollectOptions,
): Promise<ActivityItem[]> {
  const lookback = opts.lookbackDays ?? 2;
  const xml = await fetchText(feedUrl);
  const entries = parseFeed(xml);
  const out: ActivityItem[] = [];
  for (const e of entries) {
    if (!e.url) continue;
    if (!withinLookback(e.publishedAt, lookback)) continue;
    const blob = `${e.title} ${e.summary}`;
    if (!opts.skipKeywordFilter && !isAiRelevant(blob)) continue;
    out.push({
      id: itemId(e.url),
      member_id: memberId,
      scope: opts.scope ?? "member",
      tier: 1,
      source_kind: "rss",
      title: e.title.trim().slice(0, 300),
      url: e.url,
      published_at: e.publishedAt,
      snippet: e.summary,
      match_reason: `rss feed: ${feedUrl}`,
      discovered_at: isoNowUTC(),
    });
  }
  return out;
}

async function collectFromArxiv(
  memberId: string,
  authorQuery: string,
  opts: CollectOptions,
): Promise<ActivityItem[]> {
  // arXiv API: au: prefix, quoted phrase, descending by submission date.
  // The author query in feeds.json is a plain name with spaces (e.g.
  // "Aric Hagberg"); encodeURIComponent turns spaces into %20.
  const q = encodeURIComponent(`au:"${authorQuery.replace(/"/g, "")}"`);
  const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=15`;
  const xml = await fetchText(url);
  const entries = parseFeed(xml);
  const lookback = opts.lookbackDays ?? 7; // arXiv submissions are slower-cadence; widen
  const out: ActivityItem[] = [];
  for (const e of entries) {
    if (!e.url) continue;
    if (!withinLookback(e.publishedAt, lookback)) continue;
    // The author query already targets the right person, so we skip
    // the AI-keyword pre-filter here. The weekly digest's grounding
    // rules drop non-AI papers when assembling the digest.
    out.push({
      id: itemId(e.url),
      member_id: memberId,
      scope: opts.scope ?? "member",
      tier: 1,
      source_kind: "arxiv",
      title: e.title.trim().slice(0, 300),
      url: e.url,
      published_at: e.publishedAt,
      snippet: e.summary,
      match_reason: `arxiv author: ${authorQuery}`,
      discovered_at: isoNowUTC(),
    });
  }
  return out;
}

/**
 * Run all configured Tier-1 sources for a single member. Errors on
 * individual feeds are logged and swallowed so one broken URL doesn't
 * starve the rest of the run.
 */
export async function collectTier1(
  memberId: string,
  config: FeedConfig | undefined,
  opts: CollectOptions = {},
): Promise<ActivityItem[]> {
  if (!config) return [];
  const results: ActivityItem[] = [];

  const tasks: Promise<ActivityItem[]>[] = [];
  for (const rssUrl of config.rss ?? []) {
    tasks.push(
      collectFromRss(memberId, rssUrl, opts).catch((err: unknown) => {
        console.warn(`[scan] rss failed member=${memberId} url=${rssUrl} err=${(err as Error).message}`);
        return [];
      }),
    );
  }
  if (config.arxiv_author) {
    tasks.push(
      collectFromArxiv(memberId, config.arxiv_author, opts).catch((err: unknown) => {
        console.warn(`[scan] arxiv failed member=${memberId} author=${config.arxiv_author} err=${(err as Error).message}`);
        return [];
      }),
    );
  }

  for (const r of await Promise.all(tasks)) results.push(...r);
  return results;
}
