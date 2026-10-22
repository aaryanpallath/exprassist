// Does validation make generated expressions correct more often? Each of 20 intents has records with the expected
// result; an expression counts as correct only if it gives the right result on every one.
//
//   npm run eval        # needs Ollama with gemma4; writes results/generate-eval.json
//
// "First answer" takes the model's first reply as-is (what you'd get without the checks). "Validated" parses and
// type-checks each reply and sends the errors back, up to 3 tries.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generate } from "../src/assistant/generate.js";
import { run, type Record_, type Value } from "../src/lang/eval.js";
import { parse } from "../src/lang/parser.js";
import { SCHEMA, TABLES } from "../src/schema.js";

type Case = { intent: string; checks: [Record_, Value][] };
const set = process.argv[2] ?? "cases"; // "cases" (the 20 used during development) or "holdout" (10 written afterwards)
const cases = JSON.parse(readFileSync(new URL(`./${set}.json`, import.meta.url), "utf8")) as Case[];

const close = (a: Value, b: Value) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

function correct(text: string | undefined, c: Case): { parsed: boolean; correct: boolean; failure?: string } {
  if (!text) return { parsed: false, correct: false, failure: "no expression" };
  let node;
  try {
    node = parse(text);
  } catch (e) {
    return { parsed: false, correct: false, failure: `does not parse: ${(e as Error).message}` };
  }
  for (const [record, want] of c.checks) {
    const got = run(node, { record, tables: TABLES });
    if (!got.ok || !close(got.value, want))
      return { parsed: true, correct: false, failure: `on ${JSON.stringify(record)} gave ${got.ok ? JSON.stringify(got.value) : `error: ${got.error}`}, expected ${JSON.stringify(want)}` };
  }
  return { parsed: true, correct: true };
}

const rows = [];
for (const [i, c] of cases.entries()) {
  const first = await generate(c.intent, SCHEMA, undefined, 1);
  const validated = await generate(c.intent, SCHEMA, undefined, 3);
  const a = correct(first.raw, c);
  const b = correct(validated.expression, c);
  rows.push({ intent: c.intent, first: { text: first.raw, ...a }, validated: { text: validated.expression ?? validated.raw, tries: validated.tries, problems: validated.problems, ...b, seconds: validated.seconds } });
  console.log(`${i + 1}/${cases.length} first ${a.correct ? "ok " : "BAD"} validated ${b.correct ? "ok " : "BAD"} (${validated.tries} tries) ${c.intent.slice(0, 60)}`);
}
const n = rows.length;
const summary = {
  model: process.env.EXPRASSIST_MODEL ?? "gemma4",
  set,
  cases: n,
  first_answer: { parses: rows.filter((r) => r.first.parsed).length, correct: rows.filter((r) => r.first.correct).length },
  validated: {
    passes_checks: rows.filter((r) => r.validated.text && r.validated.parsed).length,
    correct: rows.filter((r) => r.validated.correct).length,
    needed_retry: rows.filter((r) => r.validated.tries > 1).length,
    mean_seconds: Math.round((rows.reduce((s, r) => s + r.validated.seconds, 0) / n) * 10) / 10,
  },
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync("results", { recursive: true });
writeFileSync(`results/generate-eval-${set}.json`, JSON.stringify({ summary, rows }, null, 2) + "\n");
