// Runs the TypeScript 7 (native) compiler explicitly. Two packages in this
// workspace expose a `tsc` bin ("typescript" = TS6 alias for tooling that
// needs it, "@typescript/native" = TS7); which one wins the .bin link is
// install-order dependent, and TS6's inference collapses on convex-helpers'
// custom-function generics (implicit-any errors on Vercel but not locally).
// Resolving the package directly removes the ambiguity.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require.resolve("@typescript/native/package.json");
const tsc = join(dirname(pkg), "bin", "tsc");
try {
  execFileSync(process.execPath, [tsc, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}
