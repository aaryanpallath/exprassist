import type { BinaryOp, Node, Span } from "./ast.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(message);
  }
}

type Tok =
  | { t: "num"; v: number; span: Span }
  | { t: "str"; v: string; span: Span }
  | { t: "ident"; v: string; span: Span }
  | { t: "op"; v: string; span: Span }
  | { t: "eof"; span: Span };

const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "&", "=", "<", ">", "(", ")", ","];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]), span: { start: i, end: i + m[0].length } });
      i += m[0].length;
    } else if (c === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) j++; // \" and \\ escapes
        v += src[j];
        j++;
      }
      if (j >= src.length) throw new ParseError("unterminated string", { start: i, end: src.length });
      out.push({ t: "str", v, span: { start: i, end: j + 1 } });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: "ident", v: m[0], span: { start: i, end: i + m[0].length } });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new ParseError(`unexpected character '${c}'`, { start: i, end: i + 1 });
      out.push({ t: "op", v: op, span: { start: i, end: i + op.length } });
      i += op.length;
    }
  }
  out.push({ t: "eof", span: { start: src.length, end: src.length } });
  return out;
}

// binding power: comparison < concatenation < additive < multiplicative
const BP: Record<string, number> = { "=": 1, "<>": 1, "<": 1, "<=": 1, ">": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4 };

export function parse(src: string, letNames: ReadonlySet<string> = new Set()): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos]!;
  const next = () => toks[pos++]!;
  const expect = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new ParseError(`expected '${v}'`, t.span);
    return t;
  };
  const scopes: Set<string>[] = [new Set(letNames)];
  const bound = (name: string) => scopes.some((s) => s.has(name));

  function expr(minBp: number): Node {
    let left = prefix();
    for (;;) {
      const t = peek();
      // a common slip, from SQL and spreadsheets: a AND b. Say exactly how to write it here.
      if (t.t === "ident" && ["AND", "OR", "NOT"].includes(t.v.toUpperCase())) {
        const fn = t.v.toUpperCase();
        throw new ParseError(fn === "NOT" ? "NOT is a function here: write NOT(condition)" : `${fn} is a function here: write ${fn}(a, b) instead of a ${fn} b`, t.span);
      }
      if (t.t !== "op" || !(t.v in BP) || BP[t.v]! < minBp) return left;
      next();
      // comparisons don't chain: a = b = c is an error, as in most formula languages
      const bp = BP[t.v]!;
      const right = expr(bp + 1); // left-associative
      left = { kind: "binary", op: t.v as BinaryOp, left, right, span: { start: left.span.start, end: right.span.end } };
      if (bp === 1) {
        const n = peek();
        if (n.t === "op" && BP[n.v] === 1) throw new ParseError("comparisons can't be chained; use AND", n.span);
      }
    }
  }

  function prefix(): Node {
    const t = next();
    switch (t.t) {
      case "num":
        return { kind: "num", value: t.v, span: t.span };
      case "str":
        return { kind: "str", value: t.v, span: t.span };
      case "eof":
        throw new ParseError("unexpected end of expression", t.span);
      case "op":
        if (t.v === "(") {
          const e = expr(0);
          const close = expect(")");
          return { ...e, span: { start: t.span.start, end: close.span.end } };
        }
        if (t.v === "-") {
          const arg = expr(5);
          return { kind: "unary", op: "-", arg, span: { start: t.span.start, end: arg.span.end } };
        }
        throw new ParseError(`unexpected '${t.v}'`, t.span);
      case "ident": {
        const upper = t.v.toUpperCase();
        if (upper === "TRUE" || upper === "FALSE") return { kind: "bool", value: upper === "TRUE", span: t.span };
        if (upper === "NULL") return { kind: "null", span: t.span };
        const after = peek();
        if (after.t === "op" && after.v === "(") {
          next();
          return callRest(upper, t.span);
        }
        if (!t.v.includes(".") && bound(t.v)) return { kind: "var", name: t.v, span: t.span };
        return { kind: "field", path: t.v, span: t.span };
      }
    }
  }

  function callRest(fn: string, start: Span): Node {
    const args: Node[] = [];
    if (fn === "LET") {
      // LET(name, value, body): the name is in scope only in body
      const name = next();
      if (name.t !== "ident" || name.v.includes(".")) throw new ParseError("LET needs a simple name first", name.span);
      expect(",");
      const value = expr(0);
      expect(",");
      scopes.push(new Set([name.v]));
      const body = expr(0);
      scopes.pop();
      const close = expect(")");
      return {
        kind: "call",
        fn,
        args: [{ kind: "var", name: name.v, span: name.span }, value, body],
        span: { start: start.start, end: close.span.end },
      };
    }
    const p = peek();
    if (!(p.t === "op" && p.v === ")")) {
      for (;;) {
        args.push(expr(0));
        const sep = next();
        if (sep.t === "op" && sep.v === ")") return { kind: "call", fn, args, span: { start: start.start, end: sep.span.end } };
        if (!(sep.t === "op" && sep.v === ",")) throw new ParseError("expected ',' or ')'", sep.span);
      }
    }
    const close = next();
    return { kind: "call", fn, args, span: { start: start.start, end: close.span.end } };
  }

  const e = expr(0);
  const rest = peek();
  if (rest.t !== "eof") throw new ParseError("unexpected input after the expression", rest.span);
  return e;
}
