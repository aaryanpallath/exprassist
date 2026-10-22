import { type ReactElement, useMemo, useState } from "react";
import { explain } from "../src/analyze/explain";
import { analyze, type Finding } from "../src/analyze/rules";
import { describe, verify, type Verdict } from "../src/analyze/verify";
import type { Node } from "../src/lang/ast";
import { type Record_, run } from "../src/lang/eval";
import { ParseError, parse } from "../src/lang/parser";
import { print } from "../src/lang/print";
import { SCHEMA, TABLES } from "../src/schema";

const START = `IF(Agreement.Type = "NDA", "auto-approve",
  IF(Agreement.Type = "MSA",
    IF(Agreement.Amount > LOOKUP("Approvers", Agreement.Region, "Limit"),
      LOOKUP("Approvers", Agreement.Region, "Email") & " (over by " & (Agreement.Amount - LOOKUP("Approvers", Agreement.Region, "Limit")) & ")",
      "legal@example.com"),
    IF(Agreement.Type = "SOW",
      IF(Agreement.Amount * (1 - Agreement.DiscountPct / 100) > LOOKUP("Approvers", Agreement.Region, "Limit"), LOOKUP("Approvers", Agreement.Region, "Email"), "pm@example.com"),
      IF(Agreement.AutoRenew = TRUE, "renewals@example.com", "legal@example.com"))))`;

const SAMPLE: Record_ = {
  "Agreement.Amount": 180000,
  "Agreement.Type": "MSA",
  "Agreement.Region": "EU",
  "Agreement.TermMonths": 24,
  "Agreement.DiscountPct": null,
  "Agreement.AutoRenew": true,
  "Agreement.Title": "Master Services Agreement",
  "Counterparty.Name": "Globex GmbH",
  "Counterparty.Country": "DE",
  "Counterparty.Tier": "Enterprise",
  "Signer.Email": "a.smith@globex.example",
  "Signer.Title": "VP Legal",
};

type Parsed = { node?: Node; error?: { message: string; start: number; end: number } };

function useParsed(src: string): Parsed {
  return useMemo(() => {
    try {
      return { node: parse(src) };
    } catch (e) {
      if (e instanceof ParseError) return { error: { message: e.message, ...e.span } };
      throw e;
    }
  }, [src]);
}

function Highlighted({ src, findings, active }: { src: string; findings: Finding[]; active?: number }) {
  // mark each finding's span in the source; overlapping spans keep the first
  const marks = findings
    .map((f, i) => ({ ...f.span, i, sev: f.severity }))
    .filter((m) => m.start >= 0)
    .sort((a, b) => a.start - b.start);
  const parts: ReactElement[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    parts.push(<span key={`t${at}`}>{src.slice(at, m.start)}</span>);
    parts.push(
      <mark key={`m${m.i}`} className={`sev-${m.sev} ${active === m.i ? "active" : ""}`}>
        {src.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  parts.push(<span key="end">{src.slice(at)}</span>);
  return <pre className="code">{parts}</pre>;
}

export function App() {
  const [src, setSrc] = useState(START);
  const [preview, setPreview] = useState<{ i: number; after: Node; verdict: Verdict } | null>(null);
  const [recordText, setRecordText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [intent, setIntent] = useState("");
  const [gen, setGen] = useState<{ busy?: boolean; expression?: string; note?: string }>({});
  const parsed = useParsed(src);
  const findings = useMemo(() => (parsed.node ? analyze(parsed.node, SCHEMA) : []), [parsed.node]);
  const explanation = useMemo(() => (parsed.node ? explain(parsed.node, SCHEMA) : []), [parsed.node]);

  let record: Record_ | undefined;
  try {
    record = JSON.parse(recordText) as Record_;
  } catch {
    record = undefined;
  }
  const result = parsed.node && record ? run(parsed.node, { record, tables: TABLES }) : undefined;

  const showFix = (i: number) => {
    const f = findings[i];
    if (!f?.fix || !parsed.node) return;
    const after = f.fix.apply(parsed.node);
    setPreview({ i, after, verdict: verify(parsed.node, after, SCHEMA, TABLES) });
  };
  const applyFix = () => {
    if (!preview) return;
    setSrc(print(preview.after));
    setPreview(null);
  };
  const runGenerate = async () => {
    setGen({ busy: true });
    try {
      const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent }) });
      const data = (await r.json()) as { expression?: string | null; raw?: string; tries?: number; problems?: string[][]; error?: string };
      if (!r.ok) setGen({ note: data.error ?? `error ${r.status}` });
      else if (data.expression) setGen({ expression: data.expression, note: data.tries && data.tries > 1 ? `Fixed after ${data.tries} tries: ${data.problems?.flat().join("; ")}` : "Passed every check on the first try." });
      else setGen({ note: `No valid expression after ${data.tries} tries. Last problems: ${data.problems?.at(-1)?.join("; ")}` });
    } catch {
      setGen({ note: "The generator isn't running (npm run server)." });
    }
  };

  return (
    <main>
      <header>
        <h1>Expression Assistant</h1>
        <p>Analyze, explain and safely improve a workflow expression.</p>
      </header>
      <section className="editor">
        <label htmlFor="expr">Expression</label>
        <textarea id="expr" value={src} spellCheck={false} rows={7} onChange={(e) => (setSrc(e.target.value), setPreview(null))} />
        {parsed.error ? (
          <p className="error">
            Syntax error at character {parsed.error.start}: {parsed.error.message}
          </p>
        ) : (
          <Highlighted src={src} findings={findings} active={preview?.i} />
        )}
      </section>

      <div className="grid">
        <section>
          <h2>Findings ({findings.length})</h2>
          {findings.length === 0 && parsed.node && <p className="muted">No problems found.</p>}
          <ul className="findings">
            {findings.map((f, i) => (
              <li key={i} className={preview?.i === i ? "selected" : ""}>
                <span className={`badge sev-${f.severity}`}>{f.severity}</span> <code>{f.rule}</code>
                <p>{f.message}</p>
                {f.fix && <button onClick={() => showFix(i)}>Preview: {f.fix.title}</button>}
              </li>
            ))}
          </ul>
          {preview && (
            <div className={`preview ${preview.verdict.safe ? "safe" : "unsafe"}`}>
              <h3>{preview.verdict.safe ? "Safe to apply" : "Review before applying"}</h3>
              <pre className="code">{print(preview.after)}</pre>
              <p>{describe(preview.verdict, parsed.node!)}</p>
              {preview.verdict.lookupsBefore !== preview.verdict.lookupsAfter && (
                <p className={preview.verdict.lookupsAfter > preview.verdict.lookupsBefore ? "error" : ""}>
                  LOOKUP calls per run: {preview.verdict.lookupsBefore.toFixed(2)} → {preview.verdict.lookupsAfter.toFixed(2)}
                  {preview.verdict.lookupsAfter > preview.verdict.lookupsBefore && " (this makes the expression slower)"}
                </p>
              )}
              <button onClick={applyFix}>{preview.verdict.safe ? "Apply" : "Apply anyway"}</button>{" "}
              <button className="secondary" onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          )}
        </section>

        <section>
          <h2>What it does</h2>
          <pre className="explain">{explanation.join("\n")}</pre>
          <h2>Try it on a record</h2>
          <textarea value={recordText} rows={8} spellCheck={false} onChange={(e) => setRecordText(e.target.value)} />
          <p className="result">
            {!record ? "The record isn't valid JSON." : !result ? "" : result.ok ? <>Result: <code>{JSON.stringify(result.value)}</code></> : <span className="error">Fails: {result.error}</span>}
          </p>
        </section>
      </div>

      <section>
        <h2>Write it for me</h2>
        <div className="row">
          <input value={intent} placeholder='e.g. "Legal" if the discount is over 20%, otherwise "Sales"' onChange={(e) => setIntent(e.target.value)} />
          <button disabled={!intent.trim() || gen.busy} onClick={runGenerate}>
            {gen.busy ? "Writing…" : "Generate"}
          </button>
        </div>
        {gen.expression && (
          <div className="preview safe">
            <pre className="code">{gen.expression}</pre>
            <button onClick={() => (setSrc(gen.expression!), setGen({}))}>Use this</button>
          </div>
        )}
        {gen.note && <p className="muted">{gen.note}</p>}
      </section>
    </main>
  );
}
