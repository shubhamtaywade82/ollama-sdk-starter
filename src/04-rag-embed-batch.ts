/**
 * Demo 4 — Retrieval-Augmented Generation (RAG) with `embedBatch`.
 *
 * The complete minimal RAG loop in ~30 lines of SDK calls:
 *   1. embed the corpus   → `client.embedBatch()` (bounded batches,
 *      concurrency, backpressure — a big corpus can't OOM the daemon)
 *   2. embed the query    → `client.embed()`
 *   3. rank by cosine similarity, keep the top-k
 *   4. chat with the retrieved chunks injected as context
 *
 * DEMO mode: the mock server needs vectors, so a request-aware responder
 * generates deterministic keyword-vectors — each text lights up the
 * dimensions of its topic keywords. Cosine similarity then genuinely ranks
 * by topical overlap, exactly like a real embedding model would, and the
 * final chat responder inspects the request body to prove the retrieved
 * context actually reached the prompt.
 */
import { resolveRuntime, section } from './support/runtime.js';

// ---- The corpus: the SDK's own feature notes -----------------------------
const CORPUS: readonly string[] = [
  'The retry layer honors the Retry-After header on HTTP 429 rate limit responses, sleeping exactly the server-declared delay before retrying cloud balance and usage endpoints.',
  'embedBatch splits corpora of any size into bounded /api/embed batches with concurrency control, preserving input order and reporting progress per batch.',
  'Streaming chat exposes discrete thinking and token events; the final result aggregates message, thinking, tool calls, and telemetry counters.',
  'The Agent class runs multi-turn tool-calling loops with guardrails: max iterations, tool-call budgets, and cycle detection for repeated identical calls.',
  'The MCP bridge converts Model Context Protocol tool descriptors into Ollama function tools, validating arguments against the advertised JSON Schema before the server is called.',
  'Conversation sessions keep a prefix-stable history to maximize KV-cache reuse and expose per-turn cache hit ratios.',
  'Failover routes requests across a registry of endpoints with circuit breakers, health checks, and model-affinity ordering.',
  'Structured outputs validate model replies against Zod schemas, with resilient parsing of markdown-fenced JSON.',
];

const QUERY = 'What does the SDK do when a cloud endpoint answers 429 rate limit?';

// ---- cosine similarity (any vector store in real life) -------------------
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---- DEMO mode: deterministic keyword-vectors ------------------------------
const KEYWORDS = [
  'retry', 'rate', '429', 'delay', 'embed', 'batch', 'stream', 'token',
  'thinking', 'agent', 'tool', 'loop', 'mcp', 'schema', 'validate',
  'session', 'cache', 'failover', 'health', 'endpoint', 'context', 'zod',
];
function fakeEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return KEYWORDS.map((kw) => (lower.includes(kw) ? 1 : 0));
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();

  // ---- Scripted routes (demo mode only) ----------------------------------
  if (rt.server) {
    rt.server.register('/api/embed', {
      responder: (record) => {
        const body = record.body as { input?: string[] | string } | undefined;
        const input = Array.isArray(body?.input) ? body.input : [String(body?.input ?? '')];
        return {
          chunks: [
            JSON.stringify({ model: 'mock-embed', embeddings: input.map(fakeEmbedding) }),
          ],
        };
      },
    });
    // The retrieval-augmented chat: prove the retrieved context reached the
    // prompt by reading it back out of the request body.
    rt.server.register('/api/chat', {
      responder: (record) => {
        const body = record.body as { messages?: { role: string; content: string }[] };
        const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
        const cited = CORPUS.find((doc) => system.includes(doc.slice(0, 40)));
        return {
          chunks: [
            JSON.stringify({
              model: rt.model,
              created_at: new Date().toISOString(),
              done: true,
              message: {
                role: 'assistant',
                content: cited
                  ? `From the retrieved context: ${cited}`
                  : 'No relevant context was retrieved.',
              },
              total_duration: 900_000_000,
              load_duration: 120_000_000,
              prompt_eval_count: 180,
              prompt_eval_duration: 240_000_000,
              eval_count: 42,
              eval_duration: 520_000_000,
            }),
          ],
        };
      },
    });
  }

  // ---- 1 · embed the corpus (identical in live and demo mode) ------------
  section(`embedBatch — embedding ${CORPUS.length} docs (bounded batches)`);

  const corpus = await rt.client.embedBatch({
    model: rt.mode === 'live' ? (process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text') : rt.model,
    input: CORPUS,
    batchSize: 3, // 8 docs → 3 batch requests (3+3+2)
    onBatchComplete: (done, total) => console.log(`  batch ${done}/${total} embedded`),
  });
  console.log(`  → ${corpus.embeddings.length} vectors in ${corpus.batchCount} requests`);

  // ---- 2 · embed the query ------------------------------------------------
  const query = await rt.client.embed({
    model: corpus.model,
    input: QUERY,
  });
  const qVec = query.embeddings[0] ?? [];

  // ---- 3 · rank ------------------------------------------------------------
  section(`retrieval — ranking ${CORPUS.length} docs for the query`);
  console.log(`  query: "${QUERY}"\n`);
  const ranked = CORPUS.map((doc, i) => ({
    doc,
    similarity: cosine(qVec, corpus.embeddings[i] ?? []),
  }))
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, 3); // top-k
  for (const { doc, similarity } of ranked) {
    console.log(`  ${(similarity * 100).toFixed(1)}%  ${doc.slice(0, 72)}…`);
  }

  // ---- 4 · chat with the retrieved context ---------------------------------
  section('generation — answering from the retrieved context');
  const context = ranked.map((r, i) => `[${i + 1}] ${r.doc}`).join('\n\n');

  const res = await rt.client.chat({
    model: rt.model,
    messages: [
      {
        role: 'system',
        content: `Answer using ONLY the retrieved context:\n\n${context}`,
      },
      { role: 'user', content: QUERY },
    ],
  });
  console.log(`  ${res.message.content.trim()}`);

  await rt.shutdown();
}

void main();
