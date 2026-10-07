import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runAgent } from "./agent.ts";
import { executeTool, resolveCompany } from "./tools.ts";

describe("resolveCompany", () => {
  it("accepts names, tickers and unique partial names in any case", () => {
    expect(resolveCompany("Globex Inc").ticker).toBe("GLBX");
    expect(resolveCompany("itch").name).toBe("Initech");
    expect(resolveCompany("umbrella").name).toBe("Umbrella Health");
  });

  it("refuses to guess between companies that share a name", () => {
    expect(() => resolveCompany("Acme")).toThrow(/ambiguous.*Acme Corp.*Acme Robotics/);
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

/** A fake client that answers each request with `respond` and records the requests. */
function fakeClient(respond: (params: Params, n: number) => object) {
  const requests: Params[] = [];
  const client = {
    messages: {
      create: async (params: Params) => {
        // Snapshot: the agent keeps mutating its messages array after the call.
        requests.push(structuredClone(params));
        return respond(params, requests.length);
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

    const startedAt = Date.now();
    const result = await runAgent([{ role: "user", content: "q" }], () => {}, { client });

    expect(result.answer).toBe("Which Acme?");
    expect(Date.now() - startedAt).toBeLessThan(1500); // two 800ms tools, run concurrently
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
