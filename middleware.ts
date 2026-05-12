import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Auth-protected by default. Anything that should be reachable while signed
// out goes in `isPublicRoute`.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

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
