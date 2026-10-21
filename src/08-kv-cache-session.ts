/**
 * Demo 8 — KV-Cache Session & Compaction (`client.session` + `compact`).
 *
 * Demonstrates Ollama's prompt-prefix caching across multi-turn sessions:
 *   1. Pinned system prompt + initial large context (cold turn: 0% hit rate)
 *   2. Follow-up turns reuse the prefix from memory (warm turns: cached tokens grow)
 *   3. `session.compact()` prunes older turns when budget is reached while
 *      preserving the system prompt prefix
 *   4. `session.cacheStats` aggregates cumulative hit rates and token savings
 *
 * In DEMO mode: mock server simulates KV-cache token counts in done frames.
 */
import { resolveRuntime, section } from './support/runtime.js';
import type { StarterRuntime } from './support/runtime.js';
import type { SessionTurn } from '@nemesis-oss/ollama-sdk';

const SYSTEM_PROMPT =
  'You are a senior SRE investigator. Answer technical questions concisely based on the incident logs.';

const INCIDENT_LOGS = `
[08:00:10] Deployment v2.4.1 started across checkout-service pods (replica count: 12).
[08:01:25] Primary PostgreSQL pool max_connections reached (configured ceiling: 250 connections).
[08:01:40] DB connection wait queue exceeded 5000ms on payments-db.
[08:02:00] checkout-service /api/checkout p99 latency spiked from 120ms to 8700ms.
[08:02:15] Circuit breaker tripped on payment-gateway-adapter; 503 error rate reached 22%.
[08:04:30] SRE on-call initiated automated rollback to deployment v2.4.0.
[08:05:45] Rollback pods healthy; database active connections dropped to 64.
[08:06:10] p99 latency recovered to 118ms across all regions.
`.trim();

function registerDemoRoutes(server: StarterRuntime['server']): void {
  if (!server) return;

  let turn = 0;
  server.register('/api/chat', {
    responder: () => {
      turn++;
      const cached = turn === 1 ? 0 : 180 + turn * 40;
      const evaluated = turn === 1 ? 220 : 35;
      return {
        chunks: [
          JSON.stringify({
            model: 'mock-model',
            created_at: new Date().toISOString(),
            done: true,
            message: { role: 'assistant', content: `Turn ${turn} analyzed from incident log.` },
            prompt_eval_cached_count: cached,
            prompt_eval_count: evaluated,
            eval_count: 24,
            total_duration: 800_000_000,
          }),
        ],
      };
    },
  });
}

function printTurnStats(turnNum: number, turn: SessionTurn): void {
  const c = turn.cache;
  const pct = (c.hitRate * 100).toFixed(1);
  console.log(`[Turn ${turnNum} Reply]: ${turn.content.trim()}`);
  console.log(
    `  → KV Cache: ${pct}% hit rate (${c.cachedTokens} cached / ${c.evaluatedTokens} evaluated tokens)\n`,
  );
}

async function runSession(rt: StarterRuntime): Promise<void> {
  const session = rt.client.session(rt.model, SYSTEM_PROMPT);

  // Turn 1: Cold load — entire incident history evaluated
  section('Turn 1 · Cold Context Ingestion');
  const t1 = await session.sendTurn(
    `Here is the post-mortem incident log to review:\n${INCIDENT_LOGS}`,
  );
  printTurnStats(1, t1);

  // Turn 2: Follow-up question — reuses the cached prompt prefix
  section('Turn 2 · Warm Query (Prefix Reused)');
  const t2 = await session.sendTurn(
    'What was the configured PostgreSQL connection pool ceiling?',
  );
  printTurnStats(2, t2);

  // Turn 3: Follow-up question — further prefix expansion
  section('Turn 3 · Multi-Turn Context Continuity');
  const t3 = await session.sendTurn(
    'At what time did p99 latency normalize back to 118ms?',
  );
  printTurnStats(3, t3);

  // Turn 4: Compaction demonstration
  section('Session Compaction · In-Place History Pruning');
  const beforeCount = session.getMessages().length;
  const compaction = session.compact({ maxEstimatedTokens: 250 });
  const afterCount = session.getMessages().length;
  console.log(`Messages in history : ${beforeCount} → ${afterCount} (pinned system prompt kept)`);
  console.log(
    `Pruned older turns  : ${compaction.droppedMessages} messages (estimated tokens: ${compaction.estimatedTokensBefore} → ${compaction.estimatedTokensAfter})\n`,
  );

  // Cumulative cache performance summary
  section('Cumulative KV-Cache Performance');
  const stats = session.cacheStats;
  const totalHitPct = (stats.hitRate * 100).toFixed(1);
  console.log(`Total turns completed : ${stats.turns}`);
  console.log(`Cached prompt tokens  : ${stats.cachedTokens}`);
  console.log(`Evaluated tokens      : ${stats.evaluatedTokens}`);
  console.log(`Total prompt tokens   : ${stats.totalPromptTokens}`);
  console.log(`Cumulative hit rate   : ${totalHitPct}%`);
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();
  registerDemoRoutes(rt.server);

  await runSession(rt);
  await rt.shutdown();
}

void main();
