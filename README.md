# ollama-sdk-starter

A runnable starter for [`@nemesis-oss/ollama-sdk`](https://www.npmjs.com/package/@nemesis-oss/ollama-sdk) — the production-grade TypeScript SDK for Ollama. Six focused demos covering the patterns developers reach for first:

| Demo | What it shows | SDK features |
|---|---|---|
| `src/01-structured-output.ts` | Unstructured support ticket → typed, validated data | `chatWithSchema` + Zod, `formatTelemetry` |
| `src/02-tool-calling-agent.ts` | Autonomous loop that chains two tools across turns | `Agent`, `defineTool`, `ToolRegistry`, guardrails (`maxIterations`, `maxToolCalls`, cycle detection), loop hooks |
| `src/03-streaming-reasoning.ts` | Token-by-token answers with visible chain-of-thought | streaming `thinking`/`token` events, `think: true`, `stream.finalResult` |
| `src/04-rag-embed-batch.ts` | Full RAG loop: embed corpus → rank → answer from context | `embedBatch` (bounded batches + progress), `embed`, cosine retrieval, context injection |
| `src/05-mcp-tools.ts` | MCP tools discovered and executed inside an Agent | `loadMcpTools`, paginated discovery, JSON-Schema argument validation, `structuredContent` results |
| `src/06-filesystem-mcp.ts` | **Real** filesystem MCP server over stdio (never mocked) | `connectStdioMcpClient`, `@modelcontextprotocol/server-filesystem`, real tool execution |

## Quick start (zero daemon required)

```bash
npm install
npm run demo
```

With no environment variables set, the starter runs in **DEMO mode**: it boots the SDK's own in-memory mock server (`@nemesis-oss/ollama-sdk/testing`) with scripted routes, so every demo executes end-to-end with **no network, no Ollama daemon, no GPU**. The route registrations in each demo file are themselves working examples of how to script the mock server in your own tests.

## Live mode (real Ollama)

```bash
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=qwen3:8b        # default: llama3.2

npm run demo
```

Notes for live mode:

- Demo 3 passes `think: true` — use a reasoning model (`qwen3:8b`, `deepseek-r1:8b`, …) to see thinking deltas; non-reasoning models simply skip them.
- Demo 1's schema works on any model that supports `format` (structured output).
- Demo 2 and 5 need any tools-capable model; the agent auto-validates that via `/api/show` before starting.
- Demo 4 needs an embedding model — set `OLLAMA_EMBED_MODEL` (default: `nomic-embed-text`).
- Demo 6's MCP side is **always real**: it spawns the official filesystem MCP server over stdio (requires only Node — the two `@modelcontextprotocol/*` packages are already dependencies). In live mode a real model decides which filesystem tools to call; in demo mode the scripted chat still executes real tools against `mcp-workspace/`. Swap in any other stdio MCP server by changing `command`/`args` in `connectStdioMcpClient`.
- Demo 5's in-memory MCP server can be swapped for a real one via `@nemesis-oss/ollama-sdk/mcp/stdio` or `/mcp/http` — demo 6 shows exactly how.
- Ollama Cloud: point `OLLAMA_BASE_URL` at the cloud host and set `OLLAMA_API_KEY` instead.

## One-at-a-time

```bash
npm run demo:structured
npm run demo:agent
npm run demo:streaming
npm run demo:rag
npm run demo:mcp
npm run demo:filesystem
```

## Where to go next

Each demo file is ~100 lines of commented, copy-pasteable code. From there, the SDK's own docs-site (in the repo's `docs-site/`) has dedicated guides for every feature surface: agents, streaming, structured output, failover, MCP integration, testing, and the OpenAI/Anthropic compatibility bridges. The repo's `examples/` directory covers ~20 more scenarios (vision, embeddings, custom GGUF publishing, speculative decoding, sessions with KV-cache stats…), and `lab/` is a runnable tour of everything.

## Requirements

- Node.js >= 20
- No other services — unless you opt into live mode
