// Before a fix is offered as safe, run the original and the fixed expression on many sample records and compare.
// Records are built from the schema and from the expression itself: every literal compared with a field is tried
// (so each branch is reached), numbers just above and below each threshold, enumerated values, and blanks for
// optional fields.

import { type Node, walk } from "../lang/ast.js";
import { type Outcome, type Record_, type Tables, type Value, run } from "../lang/eval.js";
import type { Schema } from "../lang/types.js";
import { print } from "../lang/print.js";

export type Verdict = {
  changed: boolean; // a fix that leaves the expression as it was is a bug in the fix, not a safe change
  safe: boolean; // changed, and the same outcome on every sample record
  records: number;
  counterexample?: { record: Record_; before: Outcome; after: Outcome };
  lookupsBefore: number; // average LOOKUP calls per evaluation
  lookupsAfter: number;
  outcomes: number; // distinct outcomes the samples reached, a rough coverage measure
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function sampleRecords(schema: Schema, exprs: Node[], n = 400, seed = 7): Record_[] {
  const literals = new Map<string, Value[]>(); // field -> values the expression compares it with
  for (const e of exprs)
    for (const m of walk(e))
      if (m.kind === "binary") {
        const pairs: [Node, Node][] = [[m.left, m.right], [m.right, m.left]];
        for (const [f, v] of pairs)
          if (f.kind === "field" && (v.kind === "num" || v.kind === "str" || v.kind === "bool")) {
            const vals = literals.get(f.path) ?? [];
            vals.push(v.value);
            if (v.kind === "num") vals.push(v.value - 1, v.value + 1, v.value + 0.5);
            literals.set(f.path, vals);
          }
      }
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const out: Record_[] = [];
  for (let i = 0; i < n; i++) {
    const rec: Record_ = {};
    for (const [path, f] of Object.entries(schema.fields)) {
      if (!f.required && r() < 0.2) {
        rec[path] = null;
        continue;
      }
      const lits = literals.get(path) ?? [];
      if (lits.length && r() < 0.5) {
        rec[path] = pick(lits);
        continue;
      }
      if (f.type === "boolean") rec[path] = r() < 0.5;
      else if (f.type === "number") rec[path] = pick([0, 1, 12, 36, 99, 1000, 50000, 99999, 100000, 250000, 1e6, Math.round(r() * 500000)]);
      else rec[path] = f.values ? pick(f.values) : pick(["", "Acme Corp", "a@example.com", "Globex GmbH", "VP Legal"]);
    }
    out.push(rec);
  }
  return out;
}

const sameOutcome = (a: Outcome, b: Outcome) => (a.ok && b.ok ? Object.is(a.value, b.value) || a.value === b.value : !a.ok && !b.ok);

export function verify(before: Node, after: Node, schema: Schema, tables: Tables, n = 400): Verdict {
  const records = sampleRecords(schema, [before, after], n);
  const lb = { count: 0 };
  const la = { count: 0 };
  const seen = new Set<string>();
  let counterexample: Verdict["counterexample"];
  for (const record of records) {
    const b = run(before, { record, tables, lookups: lb });
    const a = run(after, { record, tables, lookups: la });
    seen.add(JSON.stringify(b));
    if (!counterexample && !sameOutcome(a, b)) counterexample = { record, before: b, after: a };
  }
  const changed = print(before) !== print(after);
  return {
    changed,
    safe: changed && !counterexample,
    records: records.length,
    counterexample,
    lookupsBefore: lb.count / records.length,
    lookupsAfter: la.count / records.length,
    outcomes: seen.size,
  };
}

export function describe(v: Verdict, before: Node): string {
  if (!v.changed) return "The fix leaves the expression unchanged.";
  if (v.safe) return `Same result on all ${v.records} sample records (${v.outcomes} distinct outcomes).`;
  const c = v.counterexample!;
  const fields = [...new Set([...walk(before)].flatMap((m) => (m.kind === "field" ? [m.path] : [])))];
  const shown = fields.map((f) => `${f} = ${JSON.stringify(c.record[f] ?? null)}`).join(", ");
  const fmt = (o: Outcome) => (o.ok ? JSON.stringify(o.value) : `error (${o.error})`);
  return `Changes behavior: when ${shown}, the original gives ${fmt(c.before)} and the fix gives ${fmt(c.after)}.`;
}

