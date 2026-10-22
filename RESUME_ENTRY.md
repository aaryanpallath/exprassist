# exprassist — AI Assistant for Workflow Expressions
Tech: TypeScript, React, Vite, Node.js, Ollama, Vitest, GitHub Actions
- Built an assistant for contract-workflow expressions: a parser, type checker and evaluator, a static analyzer for 10+ anti-patterns with one-click fixes, plain-English explanations and a React panel.
- Verified every fix by running the original and fixed expression on 400 generated records before offering it; this caught a lookup optimization that nearly doubled lookups (0.59 to 1.09 per run), now 0.68 to 0.59.
- Added LLM expression generation that accepts only answers that parse and type-check, feeding errors back; actionable error messages raised accuracy from 16/20 to 18/20 requests.
