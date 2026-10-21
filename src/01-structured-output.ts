/**
 * Demo 1 — Structured outputs with Zod (`chatWithSchema`).
 *
 * The classic extraction pipeline: turn unstructured text into typed,
 * validated data in one call. The SDK converts your Zod schema to a
 * JSON Schema for Ollama's `format` parameter and parses the reply back
 * through the schema — including resilient handling of markdown-fenced
 * JSON replies.
 *
 * DEMO mode: the mock server's request-aware `responder` shows how a
 * scripted route can answer format-bearing requests differently.
 */
import { z } from 'zod';
import { formatTelemetry } from '@nemesis-oss/ollama-sdk';
import { chatJsonFrame, resolveRuntime, section } from './support/runtime.js';

/** The shape we want OUT of the model — plain Zod, nothing SDK-specific. */
const TicketAnalysis = z.object({
  title: z.string().max(120).describe('Short engineering summary'),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  urgency: z
    .enum(['low', 'medium', 'high', 'critical'])
    .describe('How fast a human must react'),
  teams: z.array(z.enum(['frontend', 'backend', 'sre', 'security', 'docs'])),
  actionItems: z.array(z.string()).max(10),
});
type TicketAnalysis = z.infer<typeof TicketAnalysis>;

/** Unstructured input — a messy support ticket, exactly as they arrive. */
const TICKET = `
hey — since the deploy this morning the checkout page takes ~9s to load and
some users see a spinner forever. payment provider says their API is fine,
our grafana board shows p99 latency on /api/checkout at 8.7s and rising.
Also the CDN cache hit rate fell off a cliff. I think we need to page
someone from the sre + backend side tonight, this is hurting revenue.
Oh and the changelog for this deploy was never posted, docs folks asked.
`.trim();

async function main(): Promise<void> {
  const rt = await resolveRuntime();

  // ---- Scripted route (demo mode only) ----------------------------------
  if (rt.server) {
    rt.server.register('/api/chat', {
      // Request-aware routing: format-bearing requests (structured output)
      // get a schema-shaped JSON answer; plain chats get prose + counters.
      responder: (record) => {
        const body = record.body as { format?: unknown } | undefined;
        if (body?.format) {
          return {
            chunks: chatJsonFrame({
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: 'Checkout p99 latency at 8.7s after morning deploy',
                  sentiment: 'negative',
                  urgency: 'high',
                  teams: ['sre', 'backend', 'docs'],
                  actionItems: [
                    'Page SRE + backend on-call tonight',
                    'Correlate deploy commit with latency regression',
                    'Verify payment provider integration timing',
                    'Post the missing changelog entry',
                  ],
                }),
              },
              total_duration: 1_840_000_000,
              load_duration: 310_000_000,
              prompt_eval_count: 96,
              prompt_eval_duration: 210_000_000,
              eval_count: 74,
              eval_duration: 1_310_000_000,
            }),
          };
        }
        // Plain chat — telemetry-bearing answer for the formatTelemetry demo.
        return {
          chunks: chatJsonFrame({
            message: {
              role: 'assistant',
              content:
                'Ticket triaged: high-urgency checkout latency regression. Routing to SRE + backend.',
            },
            total_duration: 1_240_000_000,
            load_duration: 280_000_000,
            prompt_eval_count: 64,
            prompt_eval_duration: 190_000_000,
            prompt_eval_cached_count: 48,
            eval_count: 31,
            eval_duration: 760_000_000,
          }),
        };
      },
    });
  }

  // ---- The actual pipeline (identical in live and demo mode) ------------
  section('1 · chatWithSchema — unstructured ticket → typed, validated data');

  const analysis: TicketAnalysis = await rt.client.chatWithSchema(
    { model: rt.model, messages: [{ role: 'user', content: TICKET }] },
    TicketAnalysis,
  );

  // `analysis` is fully typed and schema-validated — autocomplete away.
  console.log(`title     : ${analysis.title}`);
  console.log(`sentiment : ${analysis.sentiment}`);
  console.log(`urgency   : ${analysis.urgency}`);
  console.log(`teams     : ${analysis.teams.join(', ')}`);
  console.log('actions   :');
  for (const item of analysis.actionItems) console.log(`  – ${item}`);

  // ---- Telemetry from the same conversation ------------------------------
  section('2 · formatTelemetry — raw nanosecond counters → human numbers');

  const res = await rt.client.chat({
    model: rt.model,
    messages: [{ role: 'user', content: 'One-line triage summary.' }],
  });
  const t = formatTelemetry(res);
  console.log(`total latency      : ${t.totalLatencyMs} ms`);
  console.log(`model load         : ${t.modelLoadMs} ms`);
  console.log(`prompt eval        : ${t.promptEvalMs} ms (${t.promptTokensPerSecond} tok/s)`);
  console.log(`generation         : ${t.generationMs} ms (${t.tokensPerSecond} tok/s)`);
  console.log(`KV cache hit ratio : ${t.cacheHitRatio}`);

  await rt.shutdown();
}

void main();
