// Walking-skeleton #5: minimal Flue 2.x agent that runs one tool call inside
// the worker. Model goes through OpenRouter (OPENROUTER_API_KEY in the env).
// Flue APIs verified against @flue/runtime 2.0.3 bundled docs
// (node_modules/@flue/runtime/docs) — see CLAUDE.md "Fresh-docs-first".

import { defineTool, init, useModel, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";

const MODEL = "openrouter/openai/gpt-5.6-luna";

export const getServerTime = defineTool({
  name: "get_server_time",
  description:
    "Returns the current time on the worker VM as an ISO 8601 string. " +
    "This is the only reliable source of the current time.",
  async run() {
    return { output: { serverTime: new Date().toISOString() } };
  },
});

// Agent function: the return value is the system prompt; hooks declare the
// model and tool set on every render.
export function HelloAgent() {
  useModel(MODEL, { thinkingLevel: "low" });
  useTool(getServerTime);
  return (
    "You are the StageStack hello agent. When asked about the current time " +
    "you MUST call the get_server_time tool and report its result verbatim."
  );
}

// Boot the embedded Flue runtime once per process, lazily, so a Flue/LLM
// problem cannot take down the rest of the worker (e.g. ping jobs).
// In-memory db is fine: hello-agent conversations are throwaway.
let fluePromise: ReturnType<typeof start> | null = null;
function ensureFlue() {
  fluePromise ??= start({ agents: [HelloAgent] });
  return fluePromise;
}

export async function runHelloAgent(jobId: string): Promise<unknown> {
  await ensureFlue();

  const agent = init(HelloAgent, { id: `hello-${jobId}` });
  const toolCalls: Array<{ toolName: string; input: unknown }> = [];
  const toolOutputs: unknown[] = [];

  const receipt = await agent.dispatch(
    "What time is it on the server right now?",
  );
  const reply = await agent.read(receipt, {
    onEvent: (chunk) => {
      if (chunk.type === "tool-input") {
        toolCalls.push({ toolName: chunk.toolName, input: chunk.input });
      } else if (chunk.type === "tool-output") {
        toolOutputs.push(chunk.output);
      }
    },
  });

  if (toolCalls.length === 0) {
    throw new Error(
      `hello-agent finished without a tool call (text: ${reply.text})`,
    );
  }

  return {
    model: MODEL,
    toolCalls,
    toolOutputs,
    finalText: reply.text,
  };
}
