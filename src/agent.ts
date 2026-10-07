/**
 * The research agent: a tool-use loop over the mocked research tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies } from "./data.ts";
import { executeTool, toolSchemas } from "./tools.ts";

const MODEL = process.env.ROGO_MODEL ?? "claude-sonnet-5";
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are Rogo Research, an assistant that answers questions about companies for financial analysts.

Use the tools to look up companies, profiles, financials and source documents, then answer the analyst's question.

How to research:
- If a company reference could mean more than one company (e.g. "Acme" matches both Acme Corp and Acme Robotics, which are unrelated), do not guess. Ask the analyst which one they mean, in one short sentence, before researching.
- Request independent lookups together in a single turn (e.g. financials for every company you are comparing) rather than one at a time.
- To read a company's documents, call searchDocuments with only \`company\`; there are only a few per company. Don't fish with many keyword searches.
- Stop researching once you can answer. If the data doesn't cover something, say so instead of searching further.

How to answer:
- Lead with the direct answer in one or two sentences, then the supporting numbers. Use a markdown table when comparing figures across companies or periods.
- Every figure must come from a tool result. Show your working for derived figures (growth rates, CAGRs) and state the periods used.
- Call out data gaps and caveats explicitly: unfiled or preliminary periods, unaudited figures, acquisition-driven vs organic growth.
- Cite sources inline: document IDs like [DOC-ACME-001] for documents, and the filing or fiscal period for financials.
- Be concise. Analysts want the answer, not a tour of the data.

Our coverage universe:
${companies
  .map(
    (c) =>
      `- ${c.name} (${c.ticker}) — ${c.sector}, HQ ${c.hq}, ${c.employees} employees. ${c.description}`,
  )
  .join("\n")}
`;

export type AgentEvent =
  | { type: "iteration"; n: number }
  | { type: "model_call"; ms: number; usage: Anthropic.Usage }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ms: number; error?: string };

export interface AgentResult {
  answer: string;
  iterations: number;
}

/** Prior turns of the conversation, as plain text. The last one is the new question. */
export type ChatTurn = { role: "user" | "assistant"; content: string };

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function runTool(
  use: Anthropic.ToolUseBlock,
  onEvent: (event: AgentEvent) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const startedAt = Date.now();
  onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });
  try {
    const output = await executeTool(use.name, use.input as Record<string, unknown>);
    onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt });
    return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt, error: message });
    return { type: "tool_result", tool_use_id: use.id, content: message, is_error: true };
  }
}

let sharedClient: Anthropic | undefined;

export async function runAgent(
  history: ChatTurn[],
  onEvent: (event: AgentEvent) => void,
  { client = (sharedClient ??= new Anthropic()), signal }: { client?: Anthropic; signal?: AbortSignal } = {},
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = history.map((turn) => ({ ...turn }));

  for (let iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    onEvent({ type: "iteration", n: iterations });
    const lastChance = iterations === MAX_ITERATIONS;
    const startedAt = Date.now();

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        // Two cache breakpoints: the system prompt (shared by every conversation)
        // and the end of the transcript (reused by the next loop iteration).
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: toolSchemas,
        // On the last iteration, forbid tools so the model answers with what it has
        // instead of us throwing the research away.
        ...(lastChance && { tool_choice: { type: "none" } }),
        cache_control: { type: "ephemeral" },
        messages,
      },
      { signal },
    );

    onEvent({ type: "model_call", ms: Date.now() - startedAt, usage: response.usage });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const answer = textOf(response).trim();
      if (response.stop_reason === "refusal" || !answer) {
        return { answer: "I wasn't able to produce an answer to that. Try rephrasing the question.", iterations };
      }
      return { answer, iterations };
    }

    // Tools are independent reads, so run them concurrently and return every result
    // in one user message (splitting them discourages parallel calls).
    const toolResults = await Promise.all(toolUses.map((use) => runTool(use, onEvent)));
    messages.push({ role: "user", content: toolResults });
  }

  // Unreachable: the last iteration disallows tools, so it always returns above.
  throw new Error("agent loop exited without an answer");
}
