/**
 * Shared outbound-HTTP constants.
 *
 * One home for the User-Agent / Accept pairs the fetchers use, so a change to
 * how we identify ourselves happens in a single place rather than drifting
 * across lib/scan/feeds.ts, lib/enrich/fetch.ts, and whatever comes next.
 *
 * Two agents, deliberately:
 *
 * - BOT_USER_AGENT for machine endpoints (RSS/Atom). Feeds exist to be polled
 *   by robots; identifying plainly is correct and nothing blocks it.
 *
 * - BROWSER_USER_AGENT for ordinary HTML pages. Campus sites are largely
 *   Drupal behind Cloudflare/Imperva, and those WAFs 403 a bare tool UA. That
 *   403 used to be recorded as a fetch failure and — after two runs — as
 *   evidence the page was GONE, which is how the enrichment pipeline came to
 *   propose "this campus no longer has an AI policy" for pages that were
 *   serving fine in a browser. The string leads with the usual browser tokens
 *   so it clears UA-prefix rules, then names the project and links the repo,
 *   so an administrator reading their logs can see exactly who we are and
 *   contact us. We only ever GET public pages this project already cites in
 *   data/inventory_urls.json, once a month.
 *
 * Note this is a mitigation, not the fix: lib/enrich/ledger.ts no longer
 * treats a 403 as death regardless of what UA we send.
 */

export const FETCH_TIMEOUT_MS = 15_000;

export const BOT_USER_AGENT =
  "ucnfi-activity-scan/0.1 (+https://github.com/z6johnson/ucnfi)";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 " +
  "ucnfi-baseline-enrich/0.2 (+https://github.com/z6johnson/ucnfi)";

export const HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export const FEED_ACCEPT =
  "application/atom+xml, application/rss+xml, application/xml, text/xml, */*";
