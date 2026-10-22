// Serves the built assistant panel and the one endpoint that needs a model:
//
//   POST /api/generate {"intent": "..."}  ->  {"expression": "...", "tries": 1, "problems": [[]]}
//
// Everything else (parsing, analysis, fix verification, explanations) runs in the browser.
//   npm run build && npm run server     # http://localhost:5174

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { SCHEMA } from "../schema.js";
import { generate } from "./generate.js";

const DIST = resolve(import.meta.dirname, "../../dist");
const PORT = Number(process.env.PORT ?? 5174);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  });
});

async function handle(req: IncomingMessage, res: ServerResponse) {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/api/generate") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4000) return send(413, { error: "request too large" });
    }
    let intent: unknown;
    try {
      intent = (JSON.parse(body) as { intent?: unknown }).intent;
    } catch {
      return send(400, { error: "body must be JSON" });
    }
    if (typeof intent !== "string" || !intent.trim()) return send(400, { error: "intent must be non-empty text" });
    try {
      const g = await generate(intent.slice(0, 1000), SCHEMA);
      return send(200, { expression: g.expression ?? null, raw: g.raw, tries: g.tries, problems: g.problems });
    } catch (e) {
      return send(502, { error: `the model is unavailable: ${(e as Error).message}` });
    }
  }
  if (req.method !== "GET") return send(405, { error: "method not allowed" });
  // static files, confined to dist/
  let decoded: string;
  try {
    decoded = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  } catch {
    return send(400, { error: "malformed path" }); // e.g. "/%": decoding throws, and would crash the server
  }
  const path = normalize(join(DIST, decoded));
  const file = path.startsWith(DIST + "/") && extname(path) ? path : join(DIST, "index.html");
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    send(404, { error: "not found" });
  }
}

server.listen(PORT, "127.0.0.1", () => console.log(`exprassist on http://localhost:${PORT}`));
