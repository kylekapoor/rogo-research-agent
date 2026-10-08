# Notes

Before changing anything, I ran the README questions and read the server logs. The prototype answered, but it had three problems: it got the entity wrong, it was slow, and analysts couldn't see what it was doing. I worked on those first.

## Measured before / after

The same questions against `claude-sonnet-5`, wall clock:

| Question | Before | After |
| --- | --- | --- |
| Compare Acme and Globex… | 24s, silently picked Acme Corp | 2s clarifying question, then 9s |
| Umbrella Health risks | 30s, 10 sequential keyword searches | 8s, 1 call |
| Fastest-growing company | 27s | 15s |

## What I changed

**Agent correctness**
- **Entity resolution (`resolveCompany` in `tools.ts`).** Tools used to require the exact company name. "Acme", "GLBX" or "globex" all failed or quietly returned `[]`. They now accept a name, a ticker, or a unique partial name. Ambiguous input ("Acme" could be Acme Corp or Acme Robotics) and unknown input come back as errors that list the candidates, so the model can recover in one step. One subtlety: "ACME" is Acme Corp's ticker, so an upper-case ticker resolves exactly, but the word "Acme" is still treated as ambiguous.
- **Asks when the company is ambiguous.** Before, "Compare Acme and Globex" was answered using Acme Corp, and Acme Robotics was never mentioned, even though it's the fastest grower in the universe. That's a confidently wrong answer. The system prompt now tells the model to ask which one the analyst means. This only works because of the next change.
- **Multi-turn context.** The UI kept a transcript but the server only received the latest message, so follow-ups ("how do its margins compare?") and answers to clarifying questions had no context. The client now sends the conversation, which the server validates and trims to the last 20 turns. The trimmed window always starts on a user turn; a naive slice breaks the 11th question. Stopped or failed exchanges are left out, so they don't get merged into the next question. The browser also sends only the last 20 turns: sending the full transcript eventually exceeds Express's 100 KB request limit, and I reproduced an HTTP 413 at about 110 KB.
- **Tool failures are flagged as errors.** Failures used to come back as ordinary-looking text ("getFinancials returned: …"). They now use `is_error: true`.
- **Iteration cap degrades gracefully.** Running out of steps used to throw away all the research and return "ran out of steps". The final iteration now sets `tool_choice: none`, so the model answers with what it has. I also lowered the cap from 12 to 8. With parallel calls, every question I tried finished in 1–3 iterations, so 8 leaves headroom while limiting spend if the model loops.
- **Removed the "editor" pass.** It was a second model call on every answer, fed the whole JSON transcript, with instructions to be "brief and conversational". It added latency and cost, and it's exactly the step that drops caveats (unfiled FY2025, unaudited figures) or alters numbers. If answers need a different style, that belongs in the main prompt.
- **System prompt.** Answer first, show the working behind derived figures, cite document IDs, call out data gaps, batch independent lookups, and stop once the question is answerable.

**Performance**
- **Tools run in parallel.** All the tool calls from one turn run with `Promise.all` and go back in a single message. Five `getFinancials` calls take about 0.8s instead of 4s.
- **`searchDocuments` with only `company`** returns every document for that company. Keyword matching is literal ("risks" doesn't match "risk"), and Umbrella's risk excerpt doesn't contain the word "risk" at all, so the model was fishing with ten guesses. The tool description now also states the 6-term limit up front, so the model doesn't learn it by failing.
- **Prompt caching.** One cache breakpoint on the system prompt and one on the end of the transcript. The `[model]` log line shows about 2k cached tokens read per call.

**Product / UX**
- **Streams progress and the answer itself.** `/api/chat` now returns NDJSON events. While the agent works, the UI shows each research step as it runs and finishes ("Pulling financials — Acme Robotics ✓ 0.8s"), then streams the answer as it's written, instead of a blank "Thinking…" for 30s. The final answer call is most of the remaining time (9–12s of a 15s run), so the analyst can start reading at about 5s. The steps stay on each answer, collapsed, so analysts can check where numbers came from. Any text the model writes before its tool calls is dropped once the tools start, so it isn't mistaken for the answer and doesn't hide the live steps. Past answers are memoized, so streaming a new answer doesn't re-parse the markdown of every earlier one.
- **Markdown rendering** (`react-markdown` + `remark-gfm`). The model already wrote tables and bold text, and they were showing up as raw `|---|` text. Images are not rendered: model output is untrusted, and with real documents a prompt-injected `![](https://…?q=…)` could leak conversation data just by loading.
- **Stop button**, plus server-side abort: closing the request cancels the in-flight model call so nothing keeps spending tokens. Errors get their own styling, and the server no longer sends raw exception strings to the client. The input is labelled for screen readers and gets focus back after each answer.

**Engineering**
- **`npm test` now has tests** (it previously found none). They cover entity resolution (including "ACME" resolving while "Acme" stays ambiguous), document listing, history validation and trimming, concurrent tool calls with `is_error` results, and the forced final answer at the iteration cap. The loop is tested with an injected fake client, so no API key or network is needed. Concurrency is checked by event order rather than wall-clock time, so the test doesn't flake on a slow machine.
- **Server logs** now include per-call latency, token usage and cache hits, and total time per answer.

## Deliberately not done

- **`getFinancials` payload.** It's the biggest token cost (5 companies ≈ 7.5k tokens): full quarterly series plus provenance and checksums. I'd trim it or add a `fields`/period parameter, but I'd want evals first so I can see whether the model ever uses the quarterlies.
- **No eval harness.** The tests cover how the loop works, not answer quality. A small set of golden questions with graded answers (ambiguity, unfiled periods, organic vs acquired growth) is the next thing I'd build. Prompt changes are unverified without it.
- **Tool results aren't carried across turns.** Only the text of each turn is kept, so a follow-up re-fetches data. That's cheap here and keeps context bounded. With real APIs I'd cache tool results server-side per conversation.
- **Model and effort are unchanged.** Lower effort, or a faster model for the tool-calling turns, would cut latency further. That's a quality trade-off I'd only make with evals in place.
- **Auto-scroll while streaming** pulls the view down even if the analyst has scrolled up to read. It needs a "stick to bottom only if already at bottom" check.
- **Document search is still literal keyword matching.** The real fix is semantic search upstream, not more prompt workarounds.
- **Truncated responses (`stop_reason: "max_tokens"`) aren't handled.** A cut-off answer would be shown as-is. That's unlikely at 16k tokens when answers run about 1k; the fix is to flag it or retry.
- **No persistence, auth or rate limiting, and the `npm audit` warnings are unchanged.** Because the browser holds the history, a client could also send fabricated "assistant" turns. A real deployment would keep the conversation server-side. All of this is out of scope for now.
- **Note:** the `/api/chat` request body changed from `{ message }` to `{ messages: [{ role, content }] }`.
