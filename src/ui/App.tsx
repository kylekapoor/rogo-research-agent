import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Step {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ms?: number;
  error?: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  steps?: Step[];
  error?: boolean;
}

/** Lines the server streams back, one JSON object per line. */
type ServerEvent =
  | { type: "iteration"; n: number }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; ms: number; error?: string }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

const EXAMPLES = [
  "Compare Acme and Globex and tell me which one appears to be growing faster.",
  "What are the biggest risks Umbrella Health flags in its filings?",
  "How is Initech's subscription transition going?",
  "Which company in the universe is growing fastest?",
];

const TOOL_LABELS: Record<string, string> = {
  searchCompanies: "Searching companies",
  getCompanyProfile: "Reading profile",
  getFinancials: "Pulling financials",
  searchDocuments: "Searching documents",
};

function describe(step: Step): string {
  const { company, query } = step.input;
  const subject = [company, query && `“${query}”`].filter(Boolean).join(" · ");
  return `${TOOL_LABELS[step.name] ?? step.name}${subject ? ` — ${subject}` : ""}`;
}

/** Model output is untrusted: render no images, so a remote URL can't leak data on load. */
function Answer({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>{text}</Markdown>;
}

function Steps({ steps, open }: { steps: Step[]; open: boolean }) {
  if (steps.length === 0) return null;
  return (
    <details className="steps" open={open}>
      <summary>
        {steps.length} research step{steps.length === 1 ? "" : "s"}
      </summary>
      <ul>
        {steps.map((step) => (
          <li key={step.id} className={step.error ? "failed" : step.ms === undefined ? "running" : "done"}>
            {describe(step)}
            {step.ms !== undefined && <span className="ms">{(step.ms / 1000).toFixed(1)}s</span>}
            {step.error && <div className="step-error">{step.error}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Memoized: each streamed token re-renders App, and re-parsing every past answer's markdown adds up. */
const Bubble = memo(function Bubble({ message }: { message: Message }) {
  return (
    <div className={`bubble ${message.role}${message.error ? " error" : ""}`}>
      {message.steps && <Steps steps={message.steps} open={false} />}
      {message.role === "assistant" && !message.error ? (
        <div className="markdown">
          <Answer text={message.text} />
        </div>
      ) : (
        message.text
      )}
    </div>
  );
});

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The input is disabled while busy, which drops focus; give it back afterwards.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, steps, draft]);

  async function send(question: string) {
    if (!question.trim() || busy) return;

    // Send prior answers too, so follow-ups ("what about Initech?") and answers to
    // clarifying questions keep their context. Failed or stopped exchanges (the
    // error and the question that caused it) are left out. Only the last 20 turns
    // go up: that's all the server keeps, and the full transcript eventually
    // exceeds the server's 100 KB request limit.
    const answered = messages.filter((m, i) => !m.error && !messages[i + 1]?.error);
    const history = [...answered, { role: "user" as const, text: question }].slice(-20);
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setBusy(true);
    setSteps([]);
    setDraft("");

    const abort = new AbortController();
    abortRef.current = abort;
    const collected: Step[] = [];
    const finish = (message: Omit<Message, "role" | "steps">) =>
      setMessages((prev) => [...prev, { role: "assistant", steps: collected, ...message }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.text })) }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`server responded ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += chunk.value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as ServerEvent;
          if (event.type === "text") {
            setDraft((prev) => prev + event.delta);
          } else if (event.type === "tool_start") {
            // Any text so far was preamble to these tool calls, not the answer;
            // drop it so the live steps stay visible.
            setDraft("");
            collected.push({ id: event.id, name: event.name, input: event.input });
            setSteps([...collected]);
          } else if (event.type === "tool_end") {
            const i = collected.findIndex((s) => s.id === event.id);
            if (i >= 0) collected[i] = { ...collected[i], ms: event.ms, error: event.error };
            setSteps([...collected]);
          } else if (event.type === "answer") {
            finish({ text: event.text });
            done = true;
          } else if (event.type === "error") {
            finish({ text: event.message, error: true });
            done = true;
          }
        }
      }
      if (!done) throw new Error("the connection closed before an answer arrived");
    } catch (err) {
      if (abort.signal.aborted) {
        finish({ text: "Stopped.", error: true });
      } else {
        finish({ text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`, error: true });
      }
    }

    abortRef.current = null;
    setBusy(false);
  }

  return (
    <div className="app">
      <header>
        <h1>Rogo Research</h1>
        <p>Ask a question about a company in our coverage universe.</p>
      </header>

      <div className="transcript">
        {messages.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}

        {messages.map((message, i) => (
          <Bubble key={i} message={message} />
        ))}

        {busy && (
          <div className="bubble assistant pending" aria-live="polite">
            <Steps steps={steps} open={!draft} />
            {draft ? (
              <div className="markdown streaming">
                <Answer text={draft} />
              </div>
            ) : (
              <span className="thinking">
                {steps.some((s) => s.ms === undefined) ? "Researching…" : steps.length ? "Analyzing…" : "Thinking…"}
              </span>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          ref={inputRef}
          aria-label="Research question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={messages.length ? "Ask a follow-up…" : "Ask a research question…"}
          disabled={busy}
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
