import type { Node } from "./ast.js";

const BP: Record<string, number> = { "=": 1, "<>": 1, "<": 1, "<=": 1, ">": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4 };

// Source text for a tree, with only the parentheses the grammar needs. parse(print(n)) rebuilds n.
export function print(n: Node, parentBp = 0, rightSide = false): string {
  switch (n.kind) {
    case "num":
      return String(n.value);
    case "str":
      return JSON.stringify(n.value);
    case "bool":
      return n.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "field":
      return n.path;
    case "var":
      return n.name;
    case "unary":
      return `-${print(n.arg, 5)}`;
    case "binary": {
      const bp = BP[n.op]!;
      const s = `${print(n.left, bp)} ${n.op} ${print(n.right, bp, true)}`;
      // parenthesize a lower-binding child, or an equal one on the right (operators are left-associative)
      return bp < parentBp || (bp === parentBp && rightSide) ? `(${s})` : s;
    }
    case "call":
      return `${n.fn}(${n.args.map((a) => print(a)).join(", ")})`;
  }
}
