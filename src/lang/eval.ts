import type { Node } from "./ast.js";

export type Value = number | string | boolean | null;
export type Record_ = Record<string, Value>; // field path -> value, e.g. { "Agreement.Amount": 75000 }
export type Tables = Record<string, Record<string, Record<string, Value>>>; // LOOKUP(table, key, column)

export class EvalError extends Error {}

export type Env = { record: Record_; tables?: Tables; vars?: Map<string, Value>; lookups?: { count: number } };

const num = (v: Value, what: string): number => {
  if (typeof v !== "number") throw new EvalError(`${what} needs a number, got ${v === null ? "blank" : typeof v}`);
  return v;
};
const str = (v: Value, what: string): string => {
  if (typeof v !== "string") throw new EvalError(`${what} needs text, got ${v === null ? "blank" : typeof v}`);
  return v;
};
const bool = (v: Value, what: string): boolean => {
  if (typeof v !== "boolean") throw new EvalError(`${what} needs TRUE or FALSE, got ${v === null ? "blank" : typeof v}`);
  return v;
};

export function evaluate(n: Node, env: Env): Value {
  switch (n.kind) {
    case "num":
    case "str":
    case "bool":
      return n.value;
    case "null":
      return null;
    case "field":
      return n.path in env.record ? env.record[n.path]! : null;
    case "var": {
      if (!env.vars?.has(n.name)) throw new EvalError(`unknown name ${n.name}`);
      return env.vars.get(n.name)!;
    }
    case "unary":
      return -num(evaluate(n.arg, env), "-");
    case "binary": {
      const a = evaluate(n.left, env);
      const b = evaluate(n.right, env);
      switch (n.op) {
        case "+":
          return num(a, "+") + num(b, "+");
        case "-":
          return num(a, "-") - num(b, "-");
        case "*":
          return num(a, "*") * num(b, "*");
        case "/": {
          const d = num(b, "/");
          if (d === 0) throw new EvalError("division by zero");
          return num(a, "/") / d;
        }
        case "&":
          return `${a ?? ""}${b ?? ""}`;
        case "=":
          return a === b;
        case "<>":
          return a !== b;
        default: {
          if (a === null || b === null) return false; // comparisons with a blank are false, not errors
          if (typeof a !== typeof b) throw new EvalError(`can't compare ${typeof a} with ${typeof b}`);
          if (n.op === "<") return a < b;
          if (n.op === "<=") return a <= b;
          if (n.op === ">") return a > b;
          return a >= b;
        }
      }
    }
    case "call":
      return call(n.fn, n.args, env);
  }
}

function call(fn: string, args: Node[], env: Env): Value {
  const ev = (i: number) => evaluate(args[i]!, env);
  const all = () => args.map((a) => evaluate(a, env));
  switch (fn) {
    case "IF":
      return bool(ev(0), "IF") ? ev(1) : args.length > 2 ? ev(2) : null;
    case "AND":
      return args.every((_, i) => bool(ev(i), "AND")); // short-circuits
    case "OR":
      return args.some((_, i) => bool(ev(i), "OR"));
    case "NOT":
      return !bool(ev(0), "NOT");
    case "ISBLANK": {
      const v = ev(0);
      return v === null || v === "";
    }
    case "COALESCE": {
      for (let i = 0; i < args.length; i++) {
        const v = ev(i);
        if (v !== null) return v;
      }
      return null;
    }
    case "SWITCH": {
      // SWITCH(value, match1, result1, match2, result2, ..., [default])
      const v = ev(0);
      let i = 1;
      for (; i + 1 < args.length; i += 2) if (ev(i) === v) return ev(i + 1);
      return i < args.length ? ev(i) : null;
    }
    case "LET": {
      const name = args[0]!.kind === "var" ? args[0]!.name : "";
      const vars = new Map(env.vars ?? []);
      vars.set(name, ev(1));
      return evaluate(args[2]!, { ...env, vars });
    }
    case "LEN":
      return str(ev(0), "LEN").length;
    case "UPPER":
      return str(ev(0), "UPPER").toUpperCase();
    case "LOWER":
      return str(ev(0), "LOWER").toLowerCase();
    case "TRIM":
      return str(ev(0), "TRIM").trim();
    case "CONTAINS":
      return str(ev(0), "CONTAINS").toLowerCase().includes(str(ev(1), "CONTAINS").toLowerCase());
    case "CONCAT":
      return all().map((v) => v ?? "").join("");
    case "ROUND": {
      const places = args.length > 1 ? num(ev(1), "ROUND") : 0;
      const f = 10 ** places;
      return Math.round(num(ev(0), "ROUND") * f) / f;
    }
    case "MIN":
      return Math.min(...all().map((v) => num(v, "MIN")));
    case "MAX":
      return Math.max(...all().map((v) => num(v, "MAX")));
    case "ABS":
      return Math.abs(num(ev(0), "ABS"));
    case "LOOKUP": {
      // LOOKUP("Table", key, "Column"): a query against a related list; the expensive operation in a workflow
      if (env.lookups) env.lookups.count++;
      const table = env.tables?.[str(ev(0), "LOOKUP")];
      const row = table?.[String(ev(1))];
      return row?.[str(ev(2), "LOOKUP")] ?? null;
    }
    default:
      throw new EvalError(`unknown function ${fn}`);
  }
}

// Evaluate to a comparable outcome: a value, or the error message.
export type Outcome = { ok: true; value: Value } | { ok: false; error: string };

export function run(n: Node, env: Env): Outcome {
  try {
    return { ok: true, value: evaluate(n, env) };
  } catch (e) {
    if (e instanceof EvalError) return { ok: false, error: e.message };
    throw e;
  }
}
