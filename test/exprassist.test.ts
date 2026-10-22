import { describe as group, expect, it } from "vitest";
import { explain } from "../src/analyze/explain";
import { analyze } from "../src/analyze/rules";
import { describe, sampleRecords, verify } from "../src/analyze/verify";
import { generate } from "../src/assistant/generate";
import { run } from "../src/lang/eval";
import { ParseError, parse } from "../src/lang/parser";
import { print } from "../src/lang/print";
import { check } from "../src/lang/types";
import { SCHEMA, TABLES } from "../src/schema";

const val = (src: string, record: Record<string, unknown> = {}) => {
  const r = run(parse(src), { record: record as never, tables: TABLES });
  return r.ok ? r.value : `ERR ${r.error}`;
};
const rules = (src: string) => analyze(parse(src), SCHEMA).map((f) => f.rule);
const fixOf = (src: string, rule: string) => {
  const n = parse(src);
  const f = analyze(n, SCHEMA).find((x) => x.rule === rule)!;
  const after = f.fix!.apply(n);
  return { text: print(after), verdict: verify(n, after, SCHEMA, TABLES) };
};

group("language", () => {
  it("parses with precedence and left associativity, and prints back to the same tree", () => {
    for (const src of ["1 - 2 - 3", "1 - (2 - 3)", "2 * 3 + 4 * 5", '"a" & 1 + 2', '-(1 + 2) * 3', 'IF(A.B > 1, "x", "y") & "!"']) {
      const n = parse(src);
      expect(print(parse(print(n)))).toBe(print(n));
    }
    expect(val("1 - 2 - 3")).toBe(-4);
    expect(val("1 - (2 - 3)")).toBe(2);
    expect(val('"n=" & 1 + 2')).toBe("n=3");
  });

  it("gives errors an author (or a model) can act on", () => {
    const err = (src: string) => {
      try {
        parse(src);
      } catch (e) {
        return (e as ParseError).message;
      }
      return "parsed";
    };
    expect(err("a = b = c")).toMatch(/can't be chained; use AND/);
    expect(err('Agreement.Type = "NDA" OR Agreement.Type = "MSA"')).toBe("OR is a function here: write OR(a, b) instead of a OR b");
    expect(err('IF(1 > 2, "a"')).toMatch(/expected ',' or '\)'/);
    expect(err('"open')).toBe("unterminated string");
  });

  it("evaluates blanks, lookups, LET scoping and SWITCH defaults", () => {
    expect(val("Agreement.TermMonths > 12", { "Agreement.TermMonths": null })).toBe(false);
    expect(val("Agreement.TermMonths + 1", {})).toMatch(/^ERR \+ needs a number, got blank/);
    expect(val('LOOKUP("Approvers", Agreement.Region, "Limit")', { "Agreement.Region": "EU" })).toBe(150000);
    expect(val("LET(x, 2, x * LET(x, 5, x))")).toBe(10);
    expect(val('SWITCH(Counterparty.Tier, "Strategic", 1, 0)', { "Counterparty.Tier": null })).toBe(0);
    expect(val("AND(FALSE, 1 / 0 > 1)")).toBe(false); // short-circuits
  });

  it("type-checks against the schema", () => {
    const msgs = (src: string) => check(parse(src), SCHEMA).diagnostics.map((d) => d.message);
    expect(msgs("LEN(Agreement.Amount)")).toEqual(["LEN expects text, but this is number"]);
    expect(msgs('Agreement.Amount = "100"')).toEqual(["comparing number with text is always false or an error"]);
    expect(msgs("IF(TRUE)")).toEqual(["IF takes 2 to 3 arguments, got 1"]);
    expect(msgs("LET(x, 1, x + y)")).toEqual(["unknown field y"]);
  });
});

group("analyzer and verified fixes", () => {
  it("rewrites an IF chain as SWITCH and proves it equivalent", () => {
    const src = 'IF(Agreement.Type = "NDA", 1, IF(Agreement.Type = "MSA", 2, IF(Agreement.Type = "SOW", 3, 4)))';
    const { text, verdict } = fixOf(src, "nested-if");
    expect(text).toBe('SWITCH(Agreement.Type, "NDA", 1, "MSA", 2, "SOW", 3, 4)');
    expect(verdict.safe).toBe(true);
    expect(verdict.outcomes).toBe(4); // the samples reached every branch
  });

  it("hoists a repeated LOOKUP into LET and halves the lookups", () => {
    const src = 'IF(Agreement.Amount > LOOKUP("Approvers", Agreement.Region, "Limit"), Agreement.Amount - LOOKUP("Approvers", Agreement.Region, "Limit"), 0)';
    const { text, verdict } = fixOf(src, "repeated-lookup");
    expect(text).toBe('LET(approverLimit, LOOKUP("Approvers", Agreement.Region, "Limit"), IF(Agreement.Amount > approverLimit, Agreement.Amount - approverLimit, 0))');
    expect(verdict.safe).toBe(true);
    expect(verdict.lookupsAfter).toBe(1);
    expect(verdict.lookupsBefore).toBeGreaterThan(1);
  });

  it("doesn't hoist lookups that sit in different branches, and hoists only as far as needed", () => {
    // each branch runs at most one copy, so a LET at the top would make every evaluation pay for a lookup
    expect(rules('IF(Agreement.Type = "MSA", LOOKUP("Approvers", Agreement.Region, "Limit"), IF(Agreement.Type = "SOW", LOOKUP("Approvers", Agreement.Region, "Limit"), 0))')).not.toContain("repeated-lookup");
    const src = 'IF(Agreement.Type = "NDA", 0, IF(Agreement.Amount > LOOKUP("Approvers", Agreement.Region, "Limit"), Agreement.Amount - LOOKUP("Approvers", Agreement.Region, "Limit"), 0))';
    const { text, verdict } = fixOf(src, "repeated-lookup");
    expect(text).toBe('IF(Agreement.Type = "NDA", 0, LET(approverLimit, LOOKUP("Approvers", Agreement.Region, "Limit"), IF(Agreement.Amount > approverLimit, Agreement.Amount - approverLimit, 0)))');
    expect(verdict.safe).toBe(true);
    expect(verdict.lookupsAfter).toBeLessThan(verdict.lookupsBefore);
  });

  it("refuses to call a fix safe when it changes behavior, and shows the record where it does", () => {
    const src = "Agreement.Amount * (1 - Agreement.DiscountPct / 100)";
    const { verdict } = fixOf(src, "unguarded-blank");
    expect(verdict.safe).toBe(false);
    expect(verdict.counterexample!.record["Agreement.DiscountPct"]).toBeNull();
    expect(describe(verdict, parse(src))).toMatch(/the original gives error \(\/ needs a number, got blank\)/);
  });

  it("catches impossible values with a suggestion, redundant booleans, constant conditions and double negation", () => {
    const f = analyze(parse('Agreement.Region = "Europe"'), SCHEMA)[0]!;
    expect(f.message).toMatch(/never "Europe".*did you mean "EU"\?/);
    expect(fixOf("IF(Agreement.AutoRenew = TRUE, TRUE, FALSE)", "compare-to-boolean").text).toBe("IF(Agreement.AutoRenew, TRUE, FALSE)");
    expect(fixOf("IF(Agreement.AutoRenew, FALSE, TRUE)", "if-returns-boolean").text).toBe("NOT(Agreement.AutoRenew)");
    expect(fixOf('IF(FALSE, "a", "b")', "constant-condition").text).toBe('"b"');
    expect(fixOf("NOT(NOT(Agreement.AutoRenew))", "double-negation").verdict.safe).toBe(true);
    expect(rules("SWITCH(Agreement.Amount, 10000, 1, 2)")).toContain("switch-on-number");
    expect(rules("COALESCE(Agreement.DiscountPct, 0) * 2")).not.toContain("unguarded-blank");
  });

  it("never calls a fix that changes nothing safe", () => {
    const n = parse("Agreement.Amount > 1");
    const v = verify(n, n, SCHEMA, TABLES);
    expect(v.safe).toBe(false);
    expect(describe(v, n)).toBe("The fix leaves the expression unchanged.");
  });

  it("suggests the field the author meant", () => {
    const { text } = fixOf("Agreement.Amout > 10", "unknown-field");
    expect(text).toBe("Agreement.Amount > 10");
  });

  it("samples records that reach every literal the expression compares against", () => {
    const recs = sampleRecords(SCHEMA, [parse("Agreement.Amount > 50000")], 200);
    const amounts = new Set(recs.map((r) => r["Agreement.Amount"]));
    expect(amounts.has(50000) && amounts.has(50001) && amounts.has(49999)).toBe(true);
  });
});

group("explanations", () => {
  it("reads IF chains and LET as steps", () => {
    const lines = explain(parse('LET(limit, LOOKUP("Approvers", Agreement.Region, "Limit"), IF(Agreement.Amount > limit, "VP", "auto"))'), SCHEMA);
    expect(lines).toEqual([
      "Let limit be the Limit for Agreement.Region (sales region) in the Approvers table.",
      "If Agreement.Amount (total contract value in USD) is more than limit:",
      '  The result is "VP".',
      "Otherwise:",
      '  The result is "auto".',
    ]);
  });
});

group("generation", () => {
  it("sends parse and type errors back to the model and accepts only a checked answer", async () => {
    const replies = ['Agreement.Type = "NDA" OR Agreement.Type = "MSA"', '```\nOR(Agreement.Type = "NDA", Agreement.Type = "MSA")\n```'];
    const seen: string[] = [];
    const g = await generate("NDA or MSA", SCHEMA, async (messages) => {
      seen.push(messages.at(-1)!.content);
      return replies.shift()!;
    });
    expect(g.expression).toBe('OR(Agreement.Type = "NDA", Agreement.Type = "MSA")');
    expect(g.tries).toBe(2);
    expect(seen[1]).toMatch(/OR is a function here: write OR\(a, b\)/);
  });

  it("gives up after the last try without returning an unchecked expression", async () => {
    const g = await generate("x", SCHEMA, async () => "LEN(Agreement.Amount)", 2);
    expect(g.expression).toBeUndefined();
    expect(g.problems).toEqual([["LEN expects text, but this is number"], ["LEN expects text, but this is number"]]);
  });
});
