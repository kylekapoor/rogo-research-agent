# Research Agent

A chat-based research assistant for financial analysts. Ask a question about a company and the agent pulls profiles, financials and filings through a set of research tools, then answers with cited figures, explicit caveats and the working behind any derived numbers.

The data is a small fictional coverage universe (`src/data.ts`), so everything runs locally and deterministically. Only the model call goes over the network.

## Features

- **Tool-using agent loop** on the Anthropic API. Independent lookups run in parallel, failures are reported back to the model as errors, and the agent always answers even if it hits its step limit.
- **Company resolution** by name, ticker or partial name. When a name is ambiguous (Acme Corp vs Acme Robotics), the agent asks which one you mean instead of guessing.
- **Multi-turn chat.** Follow-ups and answers to clarifying questions keep their context.
- **Live progress.** Each research step and the answer stream to the UI as they happen, and every answer keeps a collapsible trace of the steps behind it.
- **Readable answers.** Markdown rendering with tables, inline source citations, and data gaps such as unfiled or unaudited periods called out.
- **Stop button** that cancels the in-flight model call on the server.
- **Prompt caching**, plus per-call latency, token usage and cache hits in the server logs.

## Getting started

Requires Node 22 (or Node 20.19+) and an Anthropic API key.

```bash
npm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:5173. The server logs every model call and tool call to the terminal, which is the fastest way to see what the agent is doing.

The model defaults to `claude-sonnet-5`. Set `ROGO_MODEL` in `.env` to change it.

## Example questions

- "Compare Acme and Globex and tell me which one appears to be growing faster."
- "What are the biggest risks Umbrella Health flags in its filings?"
- "How is Initech's subscription transition going?"
- "Which company in the universe is growing fastest?"
- "Is GLBX a better business than ITCH?"

## How it works

| File | What it is |
| --- | --- |
| `src/server.ts` | Express server. `POST /api/chat` takes the conversation and streams newline-delimited JSON events. |
| `src/agent.ts` | The agent: system prompt, tool-use loop, history validation |
| `src/tools.ts` | Tool schemas, company resolution and tool execution |
| `src/data.ts` | The research data: companies, financials and documents |
| `src/ui/App.tsx` | The chat interface |
| `src/agent.test.ts` | Tests for the tools and the agent loop. They use a fake model client, so no API key is needed. |

`POST /api/chat` takes `{ messages: [{ role, content }] }`, ending with a user turn. It streams one JSON object per line: `tool_start`, `tool_end` and `text` events while the agent works, then a final `answer` or `error`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the agent server and the web UI together |
| `npm run dev:server` | Agent server only, on port 8787 |
| `npm run dev:web` | Web UI only, on port 5173 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Runs the Vitest suite |

See [NOTES.md](NOTES.md) for design decisions, measurements and known limitations.
