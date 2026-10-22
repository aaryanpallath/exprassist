// Explain an expression in plain English, straight from the syntax tree. Deterministic: the explanation can't
// describe something the expression doesn't do, which an LLM paraphrase could.

import type { Node } from "../lang/ast.js";
import type { Schema } from "../lang/types.js";

const OPS: Record<string, string> = {
  "=": "is",
  "<>": "is not",
  "<": "is less than",
  "<=": "is at most",
  ">": "is more than",
  ">=": "is at least",
  "+": "plus",
  "-": "minus",
  "*": "times",
  "/": "divided by",
};

export function explain(root: Node, schema: Schema): string[] {
  const lines: string[] = [];
  const field = (path: string) => {
    const f = schema.fields[path];
    return f ? `${path} (${f.description})` : path;
  };

  function phrase(n: Node): string {
    switch (n.kind) {
      case "num":
        return n.value.toLocaleString("en-US");
      case "str":
        return `"${n.value}"`;
      case "bool":
        return n.value ? "true" : "false";
      case "null":
        return "blank";
      case "field":
        return field(n.path);
      case "var":
        return n.name;
      case "unary":
        return `minus ${phrase(n.arg)}`;
      case "binary":
        if (n.op === "&") return `${phrase(n.left)} followed by ${phrase(n.right)}`;
        return `${phrase(n.left)} ${OPS[n.op]} ${phrase(n.right)}`;
      case "call":
        return callPhrase(n);
    }
  }

  function callPhrase(n: Extract<Node, { kind: "call" }>): string {
    const a = n.args.map(phrase);
    switch (n.fn) {
      case "AND":
        return a.join(" and ");
      case "OR":
        return a.join(" or ");
      case "NOT":
        return `not (${a[0]})`;
      case "ISBLANK":
        return `${a[0]} is blank`;
      case "COALESCE":
        return `${a[0]}, or ${a.slice(1).join(", or ")} if that is blank`;
      case "LEN":
        return `the length of ${a[0]}`;
      case "UPPER":
      case "LOWER":
      case "TRIM":
        return `${a[0]} (${n.fn.toLowerCase()}case)`.replace("(trimcase)", "(trimmed)");
      case "CONTAINS":
        return `${a[0]} contains ${a[1]}`;
      case "CONCAT":
        return a.join(" followed by ");
      case "ROUND":
        return `${a[0]} rounded${n.args.length > 1 ? ` to ${a[1]} decimal places` : ""}`;
      case "MIN":
        return `the smallest of ${a.join(", ")}`;
      case "MAX":
        return `the largest of ${a.join(", ")}`;
      case "ABS":
        return `the absolute value of ${a[0]}`;
      case "LOOKUP":
        return `the ${a[2]?.replace(/"/g, "")} for ${a[1]} in the ${a[0]?.replace(/"/g, "")} table`;
      case "IF":
        return `(${a[1]} if ${a[0]}, otherwise ${a[2] ?? "blank"})`;
      case "SWITCH":
        return `(depends on ${a[0]})`;
      case "LET":
        return `(${a[2]})`;
      default:
        return `${n.fn}(${a.join(", ")})`;
    }
  }

  // The top level reads as steps: IF chains become one line per branch, SWITCH one line per case.
  function steps(n: Node, indent: string) {
    if (n.kind === "call" && n.fn === "IF") {
      lines.push(`${indent}If ${phrase(n.args[0]!)}:`);
      steps(n.args[1]!, indent + "  ");
      lines.push(`${indent}Otherwise:`);
      steps(n.args[2] ?? { kind: "null", span: n.span }, indent + "  ");
    } else if (n.kind === "call" && n.fn === "SWITCH") {
      lines.push(`${indent}Depending on ${phrase(n.args[0]!)}:`);
      let i = 1;
      for (; i + 1 < n.args.length; i += 2) {
        lines.push(`${indent}  When it is ${phrase(n.args[i]!)}:`);
        steps(n.args[i + 1]!, indent + "    ");
      }
      lines.push(`${indent}  Anything else:`);
      steps(i < n.args.length ? n.args[i]! : { kind: "null", span: n.span }, indent + "    ");
    } else if (n.kind === "call" && n.fn === "LET" && n.args[0]?.kind === "var") {
      lines.push(`${indent}Let ${n.args[0].name} be ${phrase(n.args[1]!)}.`);
      steps(n.args[2]!, indent);
    } else {
      lines.push(`${indent}The result is ${phrase(n)}.`);
    }
  }

  steps(root, "");
  return lines;
}
