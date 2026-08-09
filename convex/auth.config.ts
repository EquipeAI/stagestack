// process.env typing comes from convex/env.d.ts (no Node types in the isolate).
export default {
  providers: [
    {
      // Clerk issuer domain — set per deployment (dev/prod) in Convex env vars.
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};
