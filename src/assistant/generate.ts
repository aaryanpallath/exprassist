// Generate an expression from a plain-language description of what the author wants. The model's answer is never
// trusted as-is: it must parse, type-check against the schema and pass the analyzer's error rules. When it
// doesn't, the exact errors go back to the model for another try.

import { analyze } from "../analyze/rules.js";
import type { Node } from "../lang/ast.js";
import { ParseError, parse } from "../lang/parser.js";
import { print } from "../lang/print.js";
import { FUNCTIONS, type Schema } from "../lang/types.js";

export type Chat = (messages: { role: "system" | "user" | "assistant"; content: string }[]) => Promise<string>;

export const OLLAMA = process.env.OLLAMA_HOST ?? "http://localhost:11434";
export const MODEL = process.env.EXPRASSIST_MODEL ?? "gemma4";

export const ollamaChat: Chat = async (messages) => {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: false, think: false, options: { temperature: 0, seed: 7, num_ctx: 8192 } }),
  });
  if (!r.ok) throw new Error(`Ollama returned ${r.status}`);
  const data = (await r.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
};

export function systemPrompt(schema: Schema): string {
  const fields = Object.entries(schema.fields)
    .map(([p, f]) => `- ${p} (${f.type}${f.required ? "" : ", can be blank"}): ${f.description}` + (f.values ? `; one of ${f.values.map((v) => `"${v}"`).join(", ")}` : ""))
    .join("\n");
  const tables = Object.entries(schema.tables)
    .map(([t, d]) => `- ${t}: keyed by ${d.key}; columns ${Object.keys(d.columns).map((c) => `"${c}"`).join(", ")}`)
    .join("\n");
  const fns = Object.values(FUNCTIONS).map((f) => `- ${f.doc}`).join("\n");
  return `You write expressions for a contract workflow designer. Reply with one expression only: no explanation, no code fences.

Syntax: numbers, "text", TRUE, FALSE, field references like Agreement.Amount, operators + - * / (numbers), & (join text), = <> < <= > >= (compare; they don't chain, use AND), and these functions:
${fns}

Fields:
${fields}

Lookup tables:
${tables}

A blank field makes arithmetic and text functions fail; use COALESCE or ISBLANK when a field can be blank.

Examples:
TRUE if the agreement is an amendment -> Agreement.Type = "Amendment"
The amount in thousands, rounded -> ROUND(Agreement.Amount / 1000)
"High" if the amount is at least 1,000,000, otherwise "Normal" -> IF(Agreement.Amount >= 1000000, "High", "Normal")`;
}

// expression is set only when an answer passed every check; raw is the model's last answer either way
export type Generation = { expression?: string; node?: Node; raw: string; tries: number; problems: string[][]; seconds: number };

const FEEDBACK = new Set(["impossible-value", "switch-on-number", "unguarded-blank"]);

const clean = (s: string) =>
  s
    .trim()
    .replace(/^```[a-z]*\s*|```$/g, "")
    .replace(/^`|`$/g, "")
    .trim();

function problemsWith(text: string, schema: Schema): { node?: Node; problems: string[] } {
  try {
    const node = parse(text);
    // errors, plus the warnings that mean the expression won't do what was asked
    const errors = analyze(node, schema).filter((f) => f.severity === "error" || FEEDBACK.has(f.rule));
    return { node, problems: errors.map((e) => e.message) };
  } catch (e) {
    if (e instanceof ParseError) return { problems: [`syntax error: ${e.message} at character ${e.span.start}`] };
    throw e;
  }
}

export async function generate(intent: string, schema: Schema, chat: Chat = ollamaChat, maxTries = 3): Promise<Generation> {
  const t0 = performance.now();
  const messages: Parameters<Chat>[0] = [
    { role: "system", content: systemPrompt(schema) },
    { role: "user", content: intent },
  ];
  const all: string[][] = [];
  let last = { text: "" };
  for (let tries = 1; tries <= maxTries; tries++) {
    const text = clean(await chat(messages));
    const { node, problems } = problemsWith(text, schema);
    last = { text };
    all.push(problems);
    if (node && problems.length === 0)
      return { expression: print(node), node, raw: text, tries, problems: all, seconds: (performance.now() - t0) / 1000 };
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: `That expression has problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nReply with a corrected expression only.` });
  }
  return { raw: last.text, tries: maxTries, problems: all, seconds: (performance.now() - t0) / 1000 };
}
