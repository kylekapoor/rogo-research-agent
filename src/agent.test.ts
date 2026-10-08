import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseHistory, runAgent } from "./agent.ts";
import { executeTool, resolveCompany } from "./tools.ts";

describe("resolveCompany", () => {
  it("accepts exact names, tickers in any case, and unique partial names", () => {
    expect(resolveCompany("globex inc").ticker).toBe("GLBX");
    expect(resolveCompany("GLBX").name).toBe("Globex Inc");
    expect(resolveCompany("itch").name).toBe("Initech"); // lower-case ticker; not part of any name
    expect(resolveCompany("robotics").name).toBe("Acme Robotics");
  });

  it("treats an upper-case ticker as exact but refuses to guess on a shared name", () => {
    expect(resolveCompany("ACME").name).toBe("Acme Corp");
    expect(() => resolveCompany("Acme")).toThrow(/ambiguous.*Acme Corp.*Acme Robotics/);
    expect(() => resolveCompany("acme")).toThrow(/ambiguous/);
  });

  it("lists the universe for unknown companies", () => {
    expect(() => resolveCompany("Hooli")).toThrow(/not in the coverage universe/);
  });
});

describe("searchDocuments", () => {
  it("returns every document for a company when no query is given", async () => {
    const docs = (await executeTool("searchDocuments", { company: "UMBR" })) as { id: string }[];
    expect(docs.map((d) => d.id)).toEqual(["DOC-UMBR-001", "DOC-UMBR-002"]);
  });
});

type Params = Anthropic.MessageCreateParamsNonStreaming;

describe("parseHistory", () => {
  const conversation = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));

  it("keeps long conversations working by trimming to a window that starts on a user turn", () => {
    const turns = parseHistory({ messages: conversation(41) })!;
    expect(turns.length).toBeLessThanOrEqual(20);
    expect(turns[0].role).toBe("user");
    expect(turns.at(-1)!.content).toBe("turn 40");
  });

  it("rejects malformed bodies", () => {
    expect(parseHistory({ message: "old shape" })).toBeNull();
    expect(parseHistory({ messages: conversation(2) })).toBeNull(); // ends on assistant
    expect(parseHistory({ messages: [{ role: "system", content: "x" }] })).toBeNull();
  });
});

/** A fake client that answers each request with `respond` and records the requests. */
function fakeClient(respond: (params: Params, n: number) => object) {
  const requests: Params[] = [];
  const client = {
    messages: {
      stream: (params: Params) => {
        // Snapshot: the agent keeps mutating its messages array after the call.
        requests.push(structuredClone(params));
        const message = respond(params, requests.length);
        return { on: () => {}, finalMessage: async () => message };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const text = (t: string) => ({ content: [{ type: "text", text: t, citations: null }], stop_reason: "end_turn" }) as const;

const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input }) as const;

describe("runAgent", () => {
  it("runs a turn's tool calls together and returns all results in one message, flagging failures", async () => {
    const { client, requests } = fakeClient((_, n) =>
      n === 1
        ? {
            content: [
              toolUse("a", "getFinancials", { company: "Acme Robotics" }),
              toolUse("b", "getFinancials", { company: "Acme" }),
            ],
            stop_reason: "tool_use",
          }
        : text("Which Acme?"),
    );

    const order: string[] = [];
    const result = await runAgent(
      [{ role: "user", content: "q" }],
      (e) => (e.type === "tool_start" || e.type === "tool_end") && order.push(`${e.type}:${e.id}`),
      { client },
    );

    expect(result.answer).toBe("Which Acme?");
    // Both tools start before either finishes, i.e. they ran concurrently.
    expect(order.slice(0, 2).sort()).toEqual(["tool_start:a", "tool_start:b"]);
    const toolResults = requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("forces a final answer instead of giving up when the iteration cap is reached", async () => {
    // A model that never stops calling tools unless tools are disabled.
    const { client, requests } = fakeClient((params, n) =>
      params.tool_choice?.type === "none"
        ? text("best effort")
        : { content: [toolUse(`t${n}`, "searchCompanies", { query: "x" })], stop_reason: "tool_use" },
    );

    const result = await runAgent([{ role: "user", content: "q" }], () => {}, { client });

    expect(result.answer).toBe("best effort");
    expect(requests.at(-1)!.tool_choice).toEqual({ type: "none" });
    expect(requests.slice(0, -1).every((r) => r.tool_choice === undefined)).toBe(true);
  }, 20_000);
});
