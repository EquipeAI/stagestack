// The Convex isolate has no Node types; functions read deployment env vars via
// process.env. One shared declaration instead of per-file repeats.
declare const process: { env: Record<string, string | undefined> };
