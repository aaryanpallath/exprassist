// The expression language: the kind of formula a workflow author writes to route an agreement, compute a value or
// decide a branch, e.g.
//
//   IF(Agreement.Amount > 50000, "Legal review", IF(Agreement.Region = "EU", "GDPR review", "Standard"))
//
// Literals (numbers, "strings", TRUE, FALSE, NULL), dotted field references, operators (+ - * / for numbers,
// & for text, = <> < <= > >= for comparison, unary -), and function calls such as IF, AND, SWITCH, LET.

export type Span = { start: number; end: number };

export type Node =
  | { kind: "num"; value: number; span: Span }
  | { kind: "str"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "field"; path: string; span: Span }
  | { kind: "var"; name: string; span: Span } // a name bound by LET
  | { kind: "unary"; op: "-"; arg: Node; span: Span }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node; span: Span }
  | { kind: "call"; fn: string; args: Node[]; span: Span };

export type BinaryOp = "+" | "-" | "*" | "/" | "&" | "=" | "<>" | "<" | "<=" | ">" | ">=";

export const SYNTH: Span = { start: -1, end: -1 }; // nodes built by a fix, not parsed from source

export const call = (fn: string, ...args: Node[]): Node => ({ kind: "call", fn, args, span: SYNTH });

// Structural equality, ignoring spans.
export function same(a: Node, b: Node): boolean {
  return key(a) === key(b);
}

export function key(n: Node): string {
  switch (n.kind) {
    case "num":
      return `n:${n.value}`;
    case "str":
      return `s:${JSON.stringify(n.value)}`;
    case "bool":
      return `b:${n.value}`;
    case "null":
      return "null";
    case "field":
      return `f:${n.path}`;
    case "var":
      return `v:${n.name}`;
    case "unary":
      return `(-${key(n.arg)})`;
    case "binary":
      return `(${key(n.left)}${n.op}${key(n.right)})`;
    case "call":
      return `${n.fn}(${n.args.map(key).join(",")})`;
  }
}

export function children(n: Node): Node[] {
  switch (n.kind) {
    case "unary":
      return [n.arg];
    case "binary":
      return [n.left, n.right];
    case "call":
      return n.args;
    default:
      return [];
  }
}

export function* walk(n: Node): Generator<Node> {
  yield n;
  for (const c of children(n)) yield* walk(c);
}

// Rebuild a tree, replacing each node for which f returns a replacement (and not descending into it). f sees the
// original nodes, so a fix can target a node by identity. (An earlier version called f on the rebuilt copies,
// which never matched by identity, and every fix that replaced a whole subexpression silently did nothing.)
export function transform(n: Node, f: (n: Node) => Node | undefined): Node {
  const r = f(n);
  if (r) return r;
  if (n.kind === "unary") return { ...n, arg: transform(n.arg, f) };
  if (n.kind === "binary") return { ...n, left: transform(n.left, f), right: transform(n.right, f) };
  if (n.kind === "call") return { ...n, args: n.args.map((a) => transform(a, f)) };
  return n;
}
