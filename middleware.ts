import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Auth-protected by default. Anything that should be reachable while signed
// out goes in `isPublicRoute`. Webhook receivers authenticate via per-vendor
// signatures (HMAC), not Clerk, so they live here too.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Run on every route except Next.js internals and static assets,
    // but always on API + tRPC routes (mirrors Clerk's docs).
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
