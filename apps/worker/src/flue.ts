// One Flue runtime per process (start() throws on a second call), so every
// agent registers here and runners share this lazy bootstrap. In-memory
// persistence is fine: each job re-dispatches from scratch on retry.
import { start } from "@flue/runtime/node";
import { HelloAgent } from "./hello-agent";
import { ImportPlanner } from "./import-agent";

let fluePromise: ReturnType<typeof start> | null = null;

export function ensureFlue() {
  fluePromise ??= start({ agents: [HelloAgent, ImportPlanner] });
  return fluePromise;
}
