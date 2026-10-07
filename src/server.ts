import "dotenv/config";
import express from "express";
import { runAgent, type AgentEvent, type ChatTurn } from "./agent.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\nANTHROPIC_API_KEY is not set.\nCopy .env.example to .env and add your key, then run `npm run dev` again.\n",
  );
  process.exit(1);
}

/** How many prior turns we send back to the model. Older context is dropped. */
const MAX_TURNS = 20;

function parseHistory(body: unknown): ChatTurn[] | null {
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns = raw.slice(-MAX_TURNS);
  const valid = turns.every(
    (t) =>
      (t?.role === "user" || t?.role === "assistant") &&
      typeof t.content === "string" &&
      t.content.trim() !== "",
  );
  if (!valid || turns[0].role !== "user" || turns.at(-1).role !== "user") return null;
  return turns.map((t) => ({ role: t.role, content: t.content }));
}

function log(event: AgentEvent) {
  switch (event.type) {
    case "iteration":
      console.log(`[agent] iteration ${event.n}`);
      break;
    case "model_call": {
      const u = event.usage;
      console.log(
        `[model] ${event.ms}ms — in ${u.input_tokens}, cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens}`,
      );
      break;
    }
    case "tool_start":
      console.log(`[tool]  → ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case "tool_end":
      console.log(
        event.error
          ? `[tool]  ! ${event.name} (${event.ms}ms): ${event.error}`
          : `[tool]  ← ${event.name} (${event.ms}ms)`,
      );
      break;
  }
}

const app = express();
app.use(express.json());

/**
 * Streams newline-delimited JSON: one line per agent event, then a final
 * `{type:"answer"}` or `{type:"error"}` line.
 */
app.post("/api/chat", async (req, res) => {
  const history = parseHistory(req.body);
  if (!history) {
    res.status(400).json({ error: "Expected { messages: [{ role, content }] } ending with a user message." });
    return;
  }
  console.log(`\n[chat] ${history.at(-1)!.content}`);

  // Stop calling the model if the analyst navigates away or presses Stop.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (line: object) => res.write(JSON.stringify(line) + "\n");

  const startedAt = Date.now();
  try {
    const result = await runAgent(
      history,
      (event) => {
        log(event);
        if (event.type !== "model_call") send(event);
      },
      { signal: abort.signal },
    );
    console.log(`[agent] answered in ${Date.now() - startedAt}ms, ${result.iterations} iteration(s)`);
    send({ type: "answer", text: result.answer });
  } catch (err) {
    if (abort.signal.aborted) {
      console.log("[agent] cancelled by client");
    } else {
      console.error(err);
      send({ type: "error", message: "The research agent hit an error. Please try again." });
    }
  }
  res.end();
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
