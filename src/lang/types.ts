import { type Node, type Span, walk } from "./ast.js";

export type Type = "number" | "text" | "boolean" | "any";

export type Field = { type: Exclude<Type, "any">; required: boolean; description: string; values?: string[] };
export type Schema = { fields: Record<string, Field>; tables: Record<string, { key: string; columns: Record<string, Type> }> };

export type Diagnostic = {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  span: Span;
};

type Sig = { min: number; max: number; params: (i: number) => Type; returns: (args: Type[]) => Type };

const fixed = (params: Type[], returns: Type): Sig => ({
  min: params.length,
  max: params.length,
  params: (i) => params[i] ?? "any",
  returns: () => returns,
});
const variadic = (min: number, param: Type, returns: Type): Sig => ({ min, max: Infinity, params: () => param, returns: () => returns });
const unify = (ts: Type[]): Type => {
  const real = ts.filter((t) => t !== "any");
  return real.length > 0 && real.every((t) => t === real[0]) ? real[0]! : "any";
};

export const FUNCTIONS: Record<string, Sig & { doc: string }> = {
  IF: { min: 2, max: 3, params: (i) => (i === 0 ? "boolean" : "any"), returns: (a) => unify(a.slice(1)), doc: "IF(condition, then, else)" },
  AND: { ...variadic(2, "boolean", "boolean"), doc: "AND(a, b, ...): TRUE if all are TRUE" },
  OR: { ...variadic(2, "boolean", "boolean"), doc: "OR(a, b, ...): TRUE if any is TRUE" },
  NOT: { ...fixed(["boolean"], "boolean"), doc: "NOT(a)" },
  ISBLANK: { ...fixed(["any"], "boolean"), doc: "ISBLANK(value): TRUE if the value is blank or empty text" },
  COALESCE: { min: 2, max: Infinity, params: () => "any", returns: (a) => unify(a), doc: "COALESCE(a, b, ...): the first value that is not blank" },
  SWITCH: {
    min: 3,
    max: Infinity,
    params: () => "any",
    returns: (a) => unify(a.filter((_, i) => i > 0 && (i % 2 === 0 || i === a.length - 1))),
    doc: "SWITCH(value, match1, result1, ..., default)",
  },
  LET: { min: 3, max: 3, params: () => "any", returns: (a) => a[2] ?? "any", doc: "LET(name, value, body): compute value once and use it as name in body" },
  LEN: { ...fixed(["text"], "number"), doc: "LEN(text)" },
  UPPER: { ...fixed(["text"], "text"), doc: "UPPER(text)" },
  LOWER: { ...fixed(["text"], "text"), doc: "LOWER(text)" },
  TRIM: { ...fixed(["text"], "text"), doc: "TRIM(text)" },
  CONTAINS: { ...fixed(["text", "text"], "boolean"), doc: "CONTAINS(text, part): case-insensitive" },
  CONCAT: { ...variadic(1, "any", "text"), doc: "CONCAT(a, b, ...): join as text" },
  ROUND: { min: 1, max: 2, params: () => "number", returns: () => "number", doc: "ROUND(number, [places])" },
  MIN: { ...variadic(1, "number", "number"), doc: "MIN(a, b, ...)" },
  MAX: { ...variadic(1, "number", "number"), doc: "MAX(a, b, ...)" },
  ABS: { ...fixed(["number"], "number"), doc: "ABS(number)" },
  LOOKUP: { ...fixed(["text", "any", "text"], "any"), doc: 'LOOKUP("Table", key, "Column"): a query against a related table' },
};

// Infer each node's type and report errors: unknown fields and functions, wrong argument counts and types.
export function check(root: Node, schema: Schema): { type: Type; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const err = (message: string, span: Span, rule = "type-error") => diagnostics.push({ rule, severity: "error", message, span });
  const vars: Map<string, Type>[] = [];

  function infer(n: Node): Type {
    switch (n.kind) {
      case "num":
        return "number";
      case "str":
        return "text";
      case "bool":
        return "boolean";
      case "null":
        return "any";
      case "var":
        for (let i = vars.length - 1; i >= 0; i--) if (vars[i]!.has(n.name)) return vars[i]!.get(n.name)!;
        err(`unknown name ${n.name}`, n.span);
        return "any";
      case "field": {
        const f = schema.fields[n.path];
        if (!f) {
          const near = Object.keys(schema.fields).find((k) => k.toLowerCase() === n.path.toLowerCase());
          err(`unknown field ${n.path}` + (near ? `; did you mean ${near}?` : ""), n.span, "unknown-field");
          return "any";
        }
        return f.type;
      }
      case "unary": {
        expect(n.arg, "number", "-");
        return "number";
      }
      case "binary": {
        if (n.op === "&") {
          infer(n.left);
          infer(n.right);
          return "text";
        }
        if ("+-*/".includes(n.op)) {
          expect(n.left, "number", n.op);
          expect(n.right, "number", n.op);
          return "number";
        }
        const a = infer(n.left);
        const b = infer(n.right);
        if (a !== "any" && b !== "any" && a !== b) err(`comparing ${a} with ${b} is always false or an error`, n.span);
        return "boolean";
      }
      case "call": {
        const sig = FUNCTIONS[n.fn];
        if (!sig) {
          err(`unknown function ${n.fn}`, n.span, "unknown-function");
          n.args.forEach(infer);
          return "any";
        }
        if (n.args.length < sig.min || n.args.length > sig.max) {
          const want = sig.min === sig.max ? `${sig.min}` : sig.max === Infinity ? `at least ${sig.min}` : `${sig.min} to ${sig.max}`;
          err(`${n.fn} takes ${want} arguments, got ${n.args.length}`, n.span, "arity");
        }
        if (n.fn === "LET" && n.args.length === 3 && n.args[0]!.kind === "var") {
          const t = infer(n.args[1]!);
          vars.push(new Map([[n.args[0]!.name, t]]));
          const body = infer(n.args[2]!);
          vars.pop();
          return body;
        }
        const types = n.args.map((a, i) => expect(a, sig.params(i), n.fn));
        return sig.returns(types);
      }
    }
  }

  function expect(n: Node, want: Type, where: string): Type {
    const got = infer(n);
    if (want !== "any" && got !== "any" && got !== want) err(`${where} expects ${want}, but this is ${got}`, n.span);
    return got;
  }

  const type = infer(root);
  return { type, diagnostics };
}

export function fieldsUsed(root: Node): string[] {
  const out = new Set<string>();
  for (const n of walk(root)) if (n.kind === "field") out.add(n.path);
  return [...out];
}
