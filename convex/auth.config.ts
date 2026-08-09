export default {
  providers: [
    {
      // Clerk issuer domain — set per deployment (dev/prod) in Convex env vars.
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};
