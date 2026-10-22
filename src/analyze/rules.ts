import { call, type Node, SYNTH, same, key, transform, walk } from "../lang/ast.js";
import { check, type Diagnostic, type Schema } from "../lang/types.js";
import { print } from "../lang/print.js";

export type Fix = { title: string; apply: (root: Node) => Node };
export type Finding = Diagnostic & { fix?: Fix };

const isLiteral = (n: Node) => n.kind === "num" || n.kind === "str" || n.kind === "bool" || n.kind === "null";
const hasFreeInputs = (n: Node) => [...walk(n)].some((m) => m.kind === "field" || m.kind === "var" || (m.kind === "call" && m.fn === "LOOKUP"));
const replace = (root: Node, target: Node, by: Node) => transform(root, (m) => (m === target ? by : undefined));
const not = (n: Node) => call("NOT", n);

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const [w, v] = [word.toLowerCase(), o.toLowerCase()];
    // an exact match ignoring case, an abbreviation ("Europe" for "EU"), or a near-miss spelling
    const dist = w === v ? 0 : w.startsWith(v) || v.startsWith(w) ? 1 : levenshtein(v, w);
    if (dist < bestD) [best, bestD] = [o, dist];
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

// A chain IF(S = v1, r1, IF(S = v2, r2, ... else)) testing one subject against literals: [subject, pairs, else].
function ifChain(n: Node): { subject: Node; pairs: [Node, Node][]; otherwise: Node | undefined } | undefined {
  const pairs: [Node, Node][] = [];
  let subject: Node | undefined;
  let cur: Node | undefined = n;
  while (cur && cur.kind === "call" && cur.fn === "IF" && cur.args.length >= 2) {
    const c = cur.args[0]!;
    if (c.kind !== "binary" || c.op !== "=") break;
    const [s, v] = isLiteral(c.right) ? [c.left, c.right] : isLiteral(c.left) ? [c.right, c.left] : [undefined, undefined];
    if (!s || !v || isLiteral(s) || (subject && !same(subject, s))) break;
    subject = s;
    pairs.push([v, cur.args[1]!]);
    cur = cur.args[2];
  }
  return subject && pairs.length >= 3 ? { subject, pairs, otherwise: cur } : undefined;
}

function depth(n: Node): number {
  return n.kind === "call" ? 1 + Math.max(0, ...n.args.map(depth)) : n.kind === "binary" ? Math.max(depth(n.left), depth(n.right)) : 0;
}

function letName(n: Node, taken: Set<string>): string {
  let base = "value";
  if (n.kind === "call" && n.fn === "LOOKUP" && n.args[0]?.kind === "str" && n.args[2]?.kind === "str")
    base = (n.args[0].value.replace(/s$/, "") + n.args[2].value).replace(/[^A-Za-z0-9]/g, "");
  base = base.charAt(0).toLowerCase() + base.slice(1);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

export function analyze(root: Node, schema: Schema): Finding[] {
  const out: Finding[] = [];
  const { diagnostics } = check(root, schema);
  for (const d of diagnostics) {
    if (d.rule === "unknown-field") {
      const path = d.message.replace(/^unknown field (\S+).*$/, "$1");
      const near = closest(path, Object.keys(schema.fields));
      const target = [...walk(root)].find((n) => n.kind === "field" && n.path === path);
      out.push({
        ...d,
        message: `unknown field ${path}` + (near ? `; did you mean ${near}?` : ""),
        fix: near && target ? { title: `Use ${near}`, apply: (r) => transform(r, (m) => (m.kind === "field" && m.path === path ? { ...m, path: near } : undefined)) } : undefined,
      });
    } else out.push(d);
  }
  if (diagnostics.some((d) => d.rule === "unknown-function" || d.rule === "arity")) return out;

  const guarded = new Set<string>(); // fields the author already checks for blanks
  for (const n of walk(root))
    if (n.kind === "call" && (n.fn === "ISBLANK" || n.fn === "COALESCE")) for (const a of n.args) if (a.kind === "field") guarded.add(a.path);
  const vars = new Set([...walk(root)].filter((n) => n.kind === "var").map((n) => (n.kind === "var" ? n.name : "")));
  const seen = new Map<string, Node[]>();

  for (const n of walk(root)) {
    // a comparison with a literal the field can never hold, such as Agreement.Region = "Europe"
    if (n.kind === "binary" && (n.op === "=" || n.op === "<>")) {
      const [f, lit] = n.left.kind === "field" ? [n.left, n.right] : [n.right, n.left];
      const values = f.kind === "field" ? schema.fields[f.path]?.values : undefined;
      if (f.kind === "field" && lit.kind === "str" && values && !values.includes(lit.value)) {
        const near = closest(lit.value, values);
        out.push({
          rule: "impossible-value",
          severity: "warning",
          message: `${f.path} is never "${lit.value}" (its values are ${values.join(", ")}), so this is always ${n.op === "=" ? "false" : "true"}` + (near ? `; did you mean "${near}"?` : ""),
          span: n.span,
          fix: near ? { title: `Compare with "${near}"`, apply: (r) => replace(r, lit, { ...lit, value: near }) } : undefined,
        });
      }
      // X = TRUE  ->  X
      const [x, b] = n.right.kind === "bool" ? [n.left, n.right] : n.left.kind === "bool" ? [n.right, n.left] : [undefined, undefined];
      if (x && b && b.kind === "bool" && !isLiteral(x)) {
        const positive = (n.op === "=") === b.value;
        out.push({
          rule: "compare-to-boolean",
          severity: "info",
          message: `comparing with ${b.value ? "TRUE" : "FALSE"} is redundant`,
          span: n.span,
          fix: { title: positive ? `Use ${print(x)}` : `Use NOT(${print(x)})`, apply: (r) => replace(r, n, positive ? x : not(x)) },
        });
      }
    }
    if (n.kind === "call" && n.fn === "IF" && n.args.length === 3) {
      const [c, t, e] = n.args as [Node, Node, Node];
      // IF(c, TRUE, FALSE) -> c
      if (t.kind === "bool" && e.kind === "bool" && t.value !== e.value)
        out.push({
          rule: "if-returns-boolean",
          severity: "info",
          message: "this IF just returns its condition",
          span: n.span,
          fix: { title: t.value ? `Use the condition` : `Use NOT(condition)`, apply: (r) => replace(r, n, t.value ? c : not(c)) },
        });
      // a condition with no inputs always goes the same way
      else if (!hasFreeInputs(c) && c.kind !== "bool")
        out.push({ rule: "constant-condition", severity: "warning", message: "this condition never changes, so one branch is dead code", span: c.span });
      else if (c.kind === "bool")
        out.push({
          rule: "constant-condition",
          severity: "warning",
          message: `the condition is always ${c.value ? "TRUE" : "FALSE"}, so the other branch never runs`,
          span: c.span,
          fix: { title: "Keep only the branch that runs", apply: (r) => replace(r, n, c.value ? t : e) },
        });
    }
    if (n.kind === "call" && n.fn === "NOT" && n.args[0]?.kind === "call" && n.args[0].fn === "NOT")
      out.push({
        rule: "double-negation",
        severity: "info",
        message: "NOT(NOT(x)) is just x",
        span: n.span,
        fix: { title: "Remove both NOTs", apply: (r) => replace(r, n, (n.args[0] as Extract<Node, { kind: "call" }>).args[0]!) },
      });
    // optional fields used where a blank is an error
    if ((n.kind === "binary" && "+-*/".includes(n.op)) || (n.kind === "call" && ["LEN", "UPPER", "LOWER", "TRIM", "CONTAINS", "ROUND", "ABS", "MIN", "MAX"].includes(n.fn))) {
      const operands = n.kind === "binary" ? [n.left, n.right] : n.args;
      for (const a of operands) {
        const f = a.kind === "field" ? schema.fields[a.path] : undefined;
        if (a.kind === "field" && f && !f.required && !guarded.has(a.path)) {
          const fallback: Node = f.type === "number" ? { kind: "num", value: 0, span: SYNTH } : { kind: "str", value: "", span: SYNTH };
          out.push({
            rule: "unguarded-blank",
            severity: "warning",
            message: `${a.path} is blank for some agreements, and then this step fails`,
            span: a.span,
            fix: { title: `Treat blank as ${print(fallback)}`, apply: (r) => replace(r, a, call("COALESCE", a, fallback)) },
          });
        }
      }
    }
    if (n.kind === "call" && n.fn === "LOOKUP" && !hasVar(n)) {
      const k = key(n);
      seen.set(k, [...(seen.get(k) ?? []), n]);
    }
  }

  // The same lookup repeated: compute it once with LET, at the closest node enclosing every copy. Copies in
  // different branches of one IF or SWITCH never run in the same evaluation; hoisting those would make every
  // evaluation pay for a lookup only one branch needed (the verifier's lookup count caught exactly that).
  for (const nodes of seen.values()) {
    if (nodes.length < 2) continue;
    // over every pair of copies that can run together, the deepest node enclosing both: the LET goes there
    const paths = nodes.map((n) => pathTo(root, n)!);
    let lca: Node | undefined;
    let best = -1;
    for (let i = 0; i < paths.length; i++)
      for (let j = i + 1; j < paths.length; j++) {
        const [p, q] = [paths[i]!, paths[j]!];
        let k = 0;
        while (k + 1 < p.length && k + 1 < q.length && p[k + 1] === q[k + 1]) k++;
        if (!exclusiveBranches(p[k]!, [p[k + 1]!, q[k + 1]!]) && k > best) [lca, best] = [p[k]!, k];
      }
    if (!lca) continue;
    const inside = nodes.filter((n) => pathTo(lca!, n)).length;
    const scope = lca;
    const first = nodes[0]!;
    const name = letName(first, vars);
    out.push({
      rule: "repeated-lookup",
      severity: "warning",
      message: `${print(first)} can run ${inside} times in one evaluation; each LOOKUP is a query`,
      span: first.span,
      fix: {
        title: `Look it up once as ${name}`,
        apply: (r) => {
          const v: Node = { kind: "var", name, span: SYNTH };
          const wrapped = call("LET", v, first, transform(scope, (m) => (m.kind === "call" && same(m, first) ? v : undefined)));
          return scope === r ? wrapped : replace(r, scope, wrapped);
        },
      },
    });
  }

  // SWITCH matches exact values: on a number, cases like 10000 don't mean "up to 10,000"
  for (const n of walk(root))
    if (n.kind === "call" && n.fn === "SWITCH" && n.args.length > 2 && n.args.slice(1, -1).some((a, i) => i % 2 === 0 && a.kind === "num")) {
      const subjectType = n.args[0]!.kind === "field" ? schema.fields[n.args[0]!.path]?.type : undefined;
      if (subjectType === "number" || n.args[0]!.kind === "binary")
        out.push({ rule: "switch-on-number", severity: "warning", message: "SWITCH only matches exact numbers; for ranges use IF with < or >", span: n.span });
    }

  const chain = root.kind === "call" ? findChain(root) : undefined;
  if (chain) {
    const { node, subject, pairs, otherwise } = chain;
    out.push({
      rule: "nested-if",
      severity: "warning",
      message: `${pairs.length} nested IFs test ${print(subject)} against fixed values; SWITCH is easier to read and to extend`,
      span: node.span,
      fix: { title: "Rewrite as SWITCH", apply: (r) => replace(r, node, call("SWITCH", subject, ...pairs.flat(), ...(otherwise ? [otherwise] : []))) },
    });
  }
  if (depth(root) > 5)
    out.push({ rule: "deep-nesting", severity: "info", message: `functions are nested ${depth(root)} deep; consider splitting this into steps`, span: root.span });
  return out;
}

// The chain of nodes from root down to target (inclusive of both).
function pathTo(root: Node, target: Node): Node[] | undefined {
  if (root === target) return [root];
  for (const c of root.kind === "call" ? root.args : root.kind === "binary" ? [root.left, root.right] : root.kind === "unary" ? [root.arg] : []) {
    const p = pathTo(c, target);
    if (p) return [root, ...p];
  }
  return undefined;
}

// Are these children of node (one per copy) all different branches that can't run together?
function exclusiveBranches(node: Node, kids: Node[]): boolean {
  if (node.kind !== "call" || new Set(kids).size !== kids.length) return false;
  const idx = kids.map((k) => node.args.indexOf(k));
  if (node.fn === "IF") return idx.every((i) => i >= 1); // then/else, never the condition
  if (node.fn === "SWITCH") return idx.every((i) => i >= 2 && (i % 2 === 0 || i === node.args.length - 1)); // results
  return false;
}

function hasVar(n: Node) {
  return [...walk(n)].some((m) => m.kind === "var");
}

function findChain(root: Node) {
  for (const n of walk(root)) {
    const c = ifChain(n);
    if (c) return { node: n, ...c };
  }
  return undefined;
}
