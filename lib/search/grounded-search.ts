/**
 * Grounded web search over the UCSD TritonAI LiteLLM proxy, using a
 * Google-Search-grounded Gemini model (default `gemini-3.5-flash`) via the
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * Replaces the retired `internet_tool` MCP path. The TritonAI gateway
 * stopped advertising that MCP server (tools/list returns an empty list),
 * so tier-2 went silent in mid-June. We enable grounding explicitly by
 * passing Gemini's `googleSearch` tool (a plain chat call answers from
 * training data — no search, no citations); Gemini then does the searching
 * server-side in a single completion — no client-driven tool loop. We send
 * the same "return strict JSON" prompt, read the model's answer, and take
 * each item's backing from the response's grounding citations. Corroborating
 * item URLs against those citations keeps a hallucinated URL from reaching
 * the ledger.
 *
 * Transport is hand-rolled `fetch` (no OpenAI SDK dependency): the scan runs
 * under `node --experimental-strip-types` with `npm ci`, and all we need is
 * one POST.
 *
 * This module also hosts the shared response-parsing and date helpers the
 * committee scan (lib/scan/websearch.ts) and the weekly Brief
 * (lib/brief/sources/web.ts) use to turn the model's JSON answer into items.
 *
 * No "server-only" import: callers run under --experimental-strip-types in
 * Node CLI scripts, not just Next.js.
 */

import { canonicalUrl } from "../activity.ts";
import { LITELLM_BASE_URL } from "../litellm.ts";

/* ------------------------------------------------------------------ */
/* Model + endpoint                                                    */
/* ------------------------------------------------------------------ */

// `||` (not `??`) so an empty-string env var — what GitHub Actions produces
// from an unset `vars.X` interpolation — falls back to the default.
export const SEARCH_MODEL = process.env.SEARCH_MODEL || "gemini-3.5-flash";

/** OpenAI-compatible chat endpoint on the LiteLLM proxy. Override with
 *  `LITELLM_OPENAI_URL` if the gateway serves it at a different path. */
function chatEndpoint(): string {
  return (
    process.env.LITELLM_OPENAI_URL ||
    `${LITELLM_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`
  );
}

function authToken(): string {
  const key = process.env.LITELLM_API_KEY;
  if (!key) throw new Error("LITELLM_API_KEY is not set.");
  return key;
}

/**
 * Google Search grounding must be requested explicitly: without a search
 * tool in the request, Gemini answers from training data — no live search,
 * no citations (the failure we saw shipping the plain chat call). LiteLLM
 * maps the native `{ googleSearch: {} }` tool to Gemini's grounding on the
 * underlying generateContent request.
 *
 * The accepted tool shape varies across LiteLLM versions (some want
 * `{ web_search: {} }` or a typed entry), so allow an override via
 * `SEARCH_GROUNDING_TOOLS_JSON` (a raw JSON array). Set it to `[]` to send
 * no tool. Do NOT combine with `response_format`: on Gemini-3 that combo
 * makes LiteLLM emit raw tool-call tokens instead of the JSON answer, which
 * is why we ask for JSON in the prompt rather than via a schema param.
 */
export function groundingTools(): unknown[] {
  const raw = process.env.SEARCH_GROUNDING_TOOLS_JSON;
  if (raw && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v;
      console.warn("[search] SEARCH_GROUNDING_TOOLS_JSON is not a JSON array; using default");
    } catch {
      console.warn("[search] SEARCH_GROUNDING_TOOLS_JSON is not valid JSON; using default");
    }
  }
  return [{ googleSearch: {} }];
}

/* ------------------------------------------------------------------ */
/* Date pinning                                                        */
/* ------------------------------------------------------------------ */

/**
 * The model otherwise infers "now" from whatever dates show up in search
 * results and routinely gets it wrong (we saw it decide it was "late July
 * 2025"), which wrecks the lookback window. Pin the real date and the cutoff.
 */
export function dateContextLine(lookbackDays: number): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  return `Today's date is ${today} (UTC). "The past ${lookbackDays} day(s)" means published on or after ${start}; judge recency by this date, not by guessing from search results.`;
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

export type RawWebItem = {
  title?: unknown;
  url?: unknown;
  published_at?: unknown;
  snippet?: unknown;
  source_kind?: unknown;
  match_reason?: unknown;
};

export function tryParseJsonBlock(text: string): { items?: RawWebItem[] } | null {
  // Strip an accidental code fence if the model produced one despite instructions.
  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object") return v as { items?: RawWebItem[] };
  } catch {
    // Fall through.
  }
  // Last resort: find the first { ... } substring and try.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (v && typeof v === "object") return v as { items?: RawWebItem[] };
    } catch {
      // Give up.
    }
  }
  return null;
}

export function parseSearchItems(
  text: string,
  logTag: string,
  logPrefix = "[scan]",
): RawWebItem[] {
  if (!text) {
    console.warn(`${logPrefix} grounded-search empty response ${logTag}`);
    return [];
  }
  const parsed = tryParseJsonBlock(text);
  if (!parsed) {
    console.warn(`${logPrefix} grounded-search unparseable response ${logTag}: ${text.slice(0, 200)}`);
    return [];
  }
  return Array.isArray(parsed.items) ? parsed.items : [];
}

/* ------------------------------------------------------------------ */
/* Grounding citations                                                 */
/* ------------------------------------------------------------------ */

export type Citation = { url: string; title?: string };

function host(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Pull the grounded source URLs out of a chat/completions response.
 *
 * LiteLLM surfaces provider grounding metadata in more than one shape
 * depending on model and version, so we look in every documented spot and
 * fall back to a bounded deep scan:
 *   - OpenAI-style `message.annotations[]` of type `url_citation`
 *   - Gemini/Vertex `grounding_metadata.groundingChunks[].web.uri`
 *     (camelCase and snake_case, at message / choice / top level)
 *   - any remaining `{ web: { uri | url } }` or `url_citation` objects
 * Deduped by canonical URL. Non-http(s) entries are dropped.
 */
export function extractGroundingCitations(response: unknown): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  const add = (url: unknown, title?: unknown): void => {
    if (typeof url !== "string") return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    const key = canonicalUrl(u);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u, ...(typeof title === "string" && title ? { title } : {}) });
  };

  // Bounded recursive walk over the known citation shapes.
  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;

    // OpenAI url_citation annotation: { type: "url_citation", url_citation: { url, title } }
    // or the flattened { type: "url_citation", url, title }.
    if (obj.type === "url_citation") {
      const uc = obj.url_citation as Record<string, unknown> | undefined;
      if (uc) add(uc.url, uc.title);
      else add(obj.url, obj.title);
    }

    // Gemini/Vertex grounding chunk: { web: { uri | url, title } }.
    const web = obj.web as Record<string, unknown> | undefined;
    if (web && typeof web === "object") add(web.uri ?? web.url, web.title);

    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  visit(response, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Citation resolution, item↔citation anchoring, URL liveness          */
/* ------------------------------------------------------------------ */
/* The model reliably fabricates the `url` field — it knows an article's
 * content from live grounding but guesses the URL from the site's pattern,
 * routinely on the WRONG host (a real today.ucsd.edu story stored as
 * ucsd.edu/newsroom/…). So the guess can't be trusted whether it 404s or
 * soft-200s. The real URLs, though, are in the grounding citations. These
 * helpers use them as the source of truth:
 *   - resolveCitations turns the `vertexaisearch.cloud.google.com` redirect
 *     citations into real source URLs (+ the site's title);
 *   - anchorToCitations replaces each item's guessed URL with the resolved
 *     citation it belongs to (matched by registrable domain, then title),
 *     dropping items no citation grounds;
 *   - dropDeadUrls is a final safety net for a citation that resolved to a
 *     dead page. */

/** Google returns grounding citations as redirect links on this host; the
 *  real source URL is only revealed by following the redirect. */
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

const LIVENESS_TIMEOUT_MS = 10_000;
/** A browser-like UA: some outlets 403 an obviously-automated agent, and a
 *  spurious 403 would otherwise read as "alive but blocked" noise. */
const LIVENESS_USER_AGENT =
  "Mozilla/5.0 (compatible; ucnfi-link-check/0.1; +https://github.com/z6johnson/ucnfi)";

/** HTTP statuses we treat as a definitively dead link. Everything else —
 *  2xx/3xx and the ambiguous 401/403/405/429/5xx plus network/timeout
 *  errors — is kept, so bot-blocked or transient-error pages (valid links)
 *  are never falsely dropped. */
const DEAD_STATUSES = new Set([404, 410]);

/** Minimal Response surface the probe needs. `fetch`'s Response satisfies it
 *  structurally; tests inject a fake to exercise status handling offline. */
type ProbeResponse = { status: number; url?: string };
export type FetchLike = (url: string, init: RequestInit) => Promise<ProbeResponse>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * GET a URL following redirects, with a bounded timeout and a browser-like
 * UA. Returns the final status and resolved URL, or null on any transport
 * error (timeout, DNS, connection reset). Never throws.
 */
async function probeUrl(
  url: string,
  doFetch: FetchLike,
): Promise<{ status: number; finalUrl: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": LIVENESS_USER_AGENT, Accept: "*/*" },
      signal: ctrl.signal,
    });
    return { status: res.status, finalUrl: typeof res.url === "string" && res.url ? res.url : url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Replace `vertexaisearch.cloud.google.com` grounding-redirect citation URLs
 * with the real source URL they redirect to, so anchorToCitations can match
 * items against the true source domain. Non-redirect citations pass through
 * unchanged; a citation whose redirect can't be resolved keeps its original
 * URL (fail-open, never throws). Resolved in parallel — citation counts are
 * small (≤ ~20).
 */
export async function resolveCitations(
  citations: Citation[],
  doFetch: FetchLike = defaultFetch,
): Promise<Citation[]> {
  return Promise.all(
    citations.map(async (c) => {
      if (host(c.url) !== GROUNDING_REDIRECT_HOST) return c;
      const probed = await probeUrl(c.url, doFetch);
      const final = probed?.finalUrl;
      if (final && /^https?:\/\//i.test(final) && host(final) !== GROUNDING_REDIRECT_HOST) {
        return { ...c, url: final };
      }
      return c;
    }),
  );
}

/** Public suffixes with a second label (so the registrable domain is the
 *  last THREE labels, not two). Small hand-list — enough for the outlets we
 *  see; unknown suffixes fall back to the last two labels. */
const MULTI_PART_TLDS = new Set([
  "co.uk", "ac.uk", "gov.uk", "org.uk",
  "co.nz", "ac.nz", "com.au", "edu.au", "gov.au", "org.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp",
  "co.za", "co.in", "gov.in", "ac.in",
]);

/**
 * The registrable domain (eTLD+1) of a host: `today.ucsd.edu` → `ucsd.edu`,
 * `datax.ucla.edu` → `ucla.edu`, `www.latimes.com` → `latimes.com`. This is
 * the signal that survives the model guessing the wrong subdomain — the
 * guessed and real hosts differ but share the registrable domain.
 */
export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Stopwords stripped before comparing titles, so overlap reflects the
 *  distinctive words rather than filler. */
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "is", "are", "as", "how", "new", "this", "that", "its", "by", "from",
]);

function titleTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (w.length >= 2 && !TITLE_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Containment similarity of two titles in [0,1]: shared distinctive tokens
 * over the smaller token set, so a stored title that's a paraphrase or a
 * truncation of the citation's headline still scores. Returns 0 unless at
 * least two distinctive tokens overlap (guards against one-word coincidences).
 */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter < 2) return 0;
  return inter / Math.min(A.size, B.size);
}

/** Title similarity that alone (no domain corroboration) is strong enough to
 *  adopt a citation from a different domain. */
const STRONG_TITLE_SIM = 0.6;

/**
 * Replace each item's fabricated URL with the resolved grounding citation it
 * actually belongs to, and drop items no citation grounds. Citations must
 * already be resolved (resolveCitations).
 *
 * Matching, per item:
 *   1. Citations sharing the item's registrable domain are the candidates —
 *      the guessed and real hosts differ (ucsd.edu vs today.ucsd.edu) but
 *      share ucsd.edu. Among them, adopt the one with the best title overlap
 *      (any overlap, or the single candidate). A real same-domain URL always
 *      beats a fabricated one.
 *   2. Otherwise, if some citation's title strongly matches (≥ STRONG_TITLE_SIM),
 *      adopt it even across domains.
 *   3. Otherwise the item is ungroundable and is DROPPED. "Live but not
 *      citation-backed" is not enough: a fabricated URL that merely doesn't
 *      404 (e.g. a wrong-source iheart.com link that answers 200/403) must
 *      not enter the ledger. Every kept item's URL is a grounding citation.
 *
 * Only rewrites `url`; callers recompute the id (which derives from the URL).
 * Pure — no network. With no citations at all it fails open (keeps items
 * unchanged) rather than nuke the run on a grounding-extraction failure;
 * dropDeadUrls is the downstream net for those.
 */
export function anchorToCitations<T extends { url: string; title: string }>(
  items: T[],
  citations: Citation[],
  warn: (msg: string) => void,
): T[] {
  if (items.length === 0) return items;
  if (citations.length === 0) {
    warn(`no grounding citations — keeping ${items.length} item(s) with unverified URLs`);
    return items;
  }
  const cites = citations
    .map((c) => ({ url: c.url, title: c.title ?? "", dom: registrableDomain(host(c.url)) }))
    .filter((c) => c.dom !== "");

  const kept: T[] = [];
  let repaired = 0;
  let dropped = 0;
  for (const it of items) {
    const itemDom = registrableDomain(host(it.url));

    // 1. Same registrable domain as a citation → adopt the best such one.
    const sameDomain = itemDom ? cites.filter((c) => c.dom === itemDom) : [];
    if (sameDomain.length > 0) {
      const best = sameDomain.reduce((a, b) =>
        titleSimilarity(it.title, b.title) > titleSimilarity(it.title, a.title) ? b : a,
      );
      if (canonicalUrl(best.url) !== canonicalUrl(it.url)) repaired++;
      kept.push({ ...it, url: best.url });
      continue;
    }

    // 2. Strong cross-domain title match → adopt it.
    let bestCite = cites[0];
    let bestSim = 0;
    for (const c of cites) {
      const sim = titleSimilarity(it.title, c.title);
      if (sim > bestSim) {
        bestSim = sim;
        bestCite = c;
      }
    }
    if (bestSim >= STRONG_TITLE_SIM) {
      if (canonicalUrl(bestCite.url) !== canonicalUrl(it.url)) repaired++;
      kept.push({ ...it, url: bestCite.url });
      continue;
    }

    // 3. Ungroundable → drop.
    dropped++;
    warn(`dropped ungroundable item (no matching grounding citation) ${it.url}`);
  }
  if (repaired > 0) warn(`repaired ${repaired} item URL(s) from grounding citations`);
  if (dropped > 0) warn(`dropped ${dropped} ungroundable item(s)`);
  return kept;
}

/**
 * Fetch each item's URL and drop the ones that are definitively dead
 * (HTTP 404/410). Everything else is kept — see DEAD_STATUSES. Runs the
 * checks in parallel and warns on each drop.
 *
 * A final safety net after anchorToCitations: the adopted citation URLs
 * should be live (Gemini just read them), but this guards a citation that
 * resolved to a since-removed page. Known limitation: soft-404s that answer
 * 200 with a "not found" body (e.g. YouTube "video unavailable") aren't
 * caught by status; anchorToCitations having replaced the guessed URL with
 * the real citation is what handles those.
 */
export async function dropDeadUrls<T extends { url: string }>(
  items: T[],
  warn: (msg: string) => void,
  doFetch: FetchLike = defaultFetch,
): Promise<T[]> {
  if (items.length === 0) return items;
  const verdicts = await Promise.all(
    items.map(async (it) => {
      const probed = await probeUrl(it.url, doFetch);
      const deadStatus = probed && DEAD_STATUSES.has(probed.status) ? probed.status : null;
      return { it, deadStatus };
    }),
  );
  const kept: T[] = [];
  for (const { it, deadStatus } of verdicts) {
    if (deadStatus !== null) warn(`dropped dead link (HTTP ${deadStatus}) ${it.url}`);
    else kept.push(it);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* The grounded call                                                   */
/* ------------------------------------------------------------------ */

export type GroundedResult = {
  /** The model's final text — expected to be the strict JSON items object. */
  text: string;
  /** Grounded source URLs pulled from the response metadata. */
  citations: Citation[];
  /** finish_reason, for the run summary. */
  stop: string;
};

export type RunGroundedSearchArgs = {
  systemPrompt: string;
  userPrompt: string;
  /** Log tag for the summary/warn lines, e.g. a member id or "web". */
  logTag: string;
  /** Model id. Defaults to SEARCH_MODEL (gemini-3.5-flash). */
  model?: string;
  /**
   * Output token ceiling. Default 2048 is plenty for a handful of items; the
   * broad topic pass raises this so its longer list isn't truncated (a
   * truncated JSON answer is unparseable → 0 items).
   */
  maxTokens?: number;
  /** Log prefix, e.g. "[scan]" or "[brief]". */
  logPrefix?: string;
};

// Statuses worth retrying: rate limits (429) and the gateway/upstream
// errors (5xx) the LiteLLM proxy emits when the underlying provider (here,
// Vertex AI) is briefly out of quota or unreachable. Concurrency=5 across
// 23 members means bursts of parallel calls are routine, not exceptional.
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoff(
  logPrefix: string,
  logTag: string,
  attempt: number,
  reason: string | number,
): Promise<void> {
  // ~500ms, ~1s (+ up to 250ms jitter).
  const ms = 2 ** (attempt - 1) * 500 + Math.floor(Math.random() * 250);
  console.warn(
    `${logPrefix} grounded-search retrying ${logTag} attempt=${attempt} reason=${reason} in ${ms}ms`,
  );
  await sleep(ms);
}

/**
 * Run one grounded completion and return the model's answer plus the
 * grounding citations. Retries transient failures (429/5xx/network errors)
 * with backoff, and also retries once or twice on an empty/unparseable
 * answer — grounded search is stochastic enough, and the model's JSON
 * compliance flaky enough (see the module doc), that a second attempt often
 * succeeds where the first didn't. Returns `null` only on a non-retryable
 * or exhausted transport failure, so the caller skips rather than letting
 * the model invent URLs with no backing. An empty/unparseable answer that
 * survives every attempt is still returned (not null) so the caller's own
 * parseSearchItems() logs it consistently.
 */
export async function runGroundedSearch(
  args: RunGroundedSearchArgs,
): Promise<GroundedResult | null> {
  const logPrefix = args.logPrefix ?? "[scan]";
  const model = args.model || SEARCH_MODEL;
  const maxTokens = args.maxTokens ?? 2048;
  const tools = groundingTools();

  let lastResult: GroundedResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(chatEndpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken()}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.userPrompt },
          ],
          // Turn on live web search; without this Gemini answers from memory.
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await backoff(logPrefix, args.logTag, attempt, "connection");
        continue;
      }
      console.warn(`${logPrefix} grounded-search request failed ${args.logTag} err=${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        await backoff(logPrefix, args.logTag, attempt, res.status);
        continue;
      }
      console.warn(`${logPrefix} grounded-search HTTP ${res.status} ${args.logTag} ${body.slice(0, 200)}`);
      return null;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await backoff(logPrefix, args.logTag, attempt, "non-json-body");
        continue;
      }
      console.warn(`${logPrefix} grounded-search non-JSON body ${args.logTag}`);
      return null;
    }

    const choice = (data as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
    const message = choice?.message as { content?: unknown } | undefined;
    let text = "";
    if (typeof message?.content === "string") {
      text = message.content;
    } else if (Array.isArray(message?.content)) {
      // Some gateways return content as an array of parts.
      text = message.content
        .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
        .join("");
    }
    const stop = (choice?.finish_reason as string) ?? "?";
    const citations = extractGroundingCitations(data);
    const result: GroundedResult = { text: text.trim(), citations, stop };

    const usable = result.text.length > 0 && tryParseJsonBlock(result.text) !== null;
    if (!usable && attempt < MAX_ATTEMPTS) {
      lastResult = result;
      await backoff(logPrefix, args.logTag, attempt, result.text ? "unparseable" : "empty");
      continue;
    }
    return result;
  }
  return lastResult;
}
