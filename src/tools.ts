/**
 * The agent's tools. These stand in for the real research APIs — same shapes,
 * local data, plus a little latency so the app behaves like the real thing.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { companies, documents, financials, type Company } from "./data.ts";

/** Thrown when a tool cannot service a request. */
export class ToolError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const COMPANY_PARAM = "Company name or ticker, e.g. \"Globex Inc\" or \"GLBX\".";

/**
 * Map whatever the model passed (name, ticker, partial name, any casing) to one
 * company. Ambiguous or unknown input is an error that names the candidates, so
 * the model can recover in one step instead of guessing.
 */
export function resolveCompany(input: unknown): Company {
  const raw = String(input ?? "").trim();
  const needle = raw.toLowerCase();
  if (!needle) throw new ToolError("a company name or ticker is required");

  // An upper-case ticker is unambiguous, but "Acme" as a word is not: it is
  // ACME's ticker and also part of "Acme Robotics".
  const exact = companies.find((c) => c.name.toLowerCase() === needle || c.ticker === raw);
  if (exact) return exact;

  const partial = companies.filter((c) => c.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];

  const byTicker = partial.length === 0 && companies.find((c) => c.ticker.toLowerCase() === needle);
  if (byTicker) return byTicker;

  const list = (cs: Company[]) => cs.map((c) => `${c.name} (${c.ticker})`).join(", ");
  if (partial.length > 1) {
    throw new ToolError(
      `"${input}" is ambiguous; it matches ${list(partial)}. These are unrelated companies — ask the analyst which one they mean.`,
    );
  }
  throw new ToolError(`"${input}" is not in the coverage universe. Covered companies: ${list(companies)}.`);
}

export const toolSchemas: Anthropic.Tool[] = [
  {
    name: "searchCompanies",
    description:
      "Search the coverage universe for companies matching a name or ticker. Returns the company name, ticker and sector for each match.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A company name, part of one, or a ticker." },
      },
      required: ["query"],
    },
  },
  {
    name: "getCompanyProfile",
    description:
      "Get a company's profile: description, sector, headquarters, headcount, business segments and the filings we hold.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", description: COMPANY_PARAM },
      },
      required: ["company"],
    },
  },
  {
    name: "getFinancials",
    description:
      "Get annual and quarterly financials for a company: revenue, gross margin, operating income, net income and free cash flow.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", description: COMPANY_PARAM },
      },
      required: ["company"],
    },
  },
  {
    name: "searchDocuments",
    description:
      "Keyword search over earnings call transcripts, filing excerpts and press releases. Matching is literal (\"risks\" does not match \"risk\"). To read everything we hold on one company, pass only `company` and omit `query` — there are only a few documents per company, so prefer this over guessing keywords.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional when `company` is given. At most 6 keywords — the index rejects longer queries.",
        },
        company: {
          type: "string",
          description: `Optional. Restrict the search to one company. ${COMPANY_PARAM}`,
        },
      },
    },
  },
];

async function searchCompanies(query: string) {
  await sleep(250);
  const needle = String(query).toLowerCase();
  const matches = companies.filter(
    (c) => c.name.toLowerCase().includes(needle) || c.ticker.toLowerCase() === needle,
  );
  return matches.map((c) => ({
    name: c.name,
    ticker: c.ticker,
    sector: c.sector,
  }));
}

async function getCompanyProfile(company: string) {
  await sleep(450);
  return resolveCompany(company);
}

async function getFinancials(company: string) {
  await sleep(800);
  const { name } = resolveCompany(company);
  return financials.find((f) => f.company === name)!;
}

async function searchDocuments(query?: string, company?: string) {
  await sleep(700);

  const terms = String(query ?? "").trim().split(/\s+/).filter(Boolean);
  // The upstream document index rejects long queries.
  if (terms.length > 6) {
    throw new ToolError(
      `document search accepts at most 6 terms (received ${terms.length})`,
    );
  }

  const name = company ? resolveCompany(company).name : undefined;
  const pool = name ? documents.filter((d) => d.company === name) : documents;

  if (terms.length === 0) {
    if (!name) throw new ToolError("provide a query, a company, or both");
    return pool;
  }

  const scored = pool.map((doc) => {
    const haystack = `${doc.title} ${doc.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) score += 1;
    }
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.doc);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "searchCompanies":
      return searchCompanies(input.query as string);
    case "getCompanyProfile":
      return getCompanyProfile(input.company as string);
    case "getFinancials":
      return getFinancials(input.company as string);
    case "searchDocuments":
      return searchDocuments(input.query as string, input.company as string | undefined);
    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}
