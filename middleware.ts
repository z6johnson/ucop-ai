import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySession } from "@/lib/adminSession";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isEnrichApi = pathname.startsWith("/api/enrich");
  const isApi =
    isEnrichApi ||
    pathname.startsWith("/api/memos") ||
    pathname.startsWith("/api/activity");

  // Only gate mutating API calls. GET/HEAD (e.g. revalidation probes) pass.
  // The enrichment routes are the exception: their GETs expose proposals that
  // have not been published, so they are gated on every method.
  if (isApi && !isEnrichApi && req.method !== "POST") {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  const ok = await verifySession(cookie);
  if (ok) return NextResponse.next();

  if (isApi) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/admin/login", req.url);
  loginUrl.searchParams.set("redirect", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // An explicit allowlist, not a prefix: a broad "/admin/:path*" would also
  // catch /admin/login and bounce it to itself forever.
  matcher: [
    "/memos/new",
    "/api/memos/:path*",
    "/activity/new",
    "/api/activity/:path*",
    "/admin/enrich",
    "/admin/enrich/:path*",
    "/api/enrich/:path*",
  ],
};
