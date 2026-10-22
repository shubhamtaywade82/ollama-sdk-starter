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
import {
  chatJsonFrame,
  printBox,
  resolveRuntime,
  section,
  style,
} from './support/runtime.js';

/** The shape we want OUT of the model — plain Zod, nothing SDK-specific. */
const TicketAnalysis = z.object({
  title: z.string().max(256).describe('Short engineering summary'),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  urgency: z
    .enum(['low', 'medium', 'high', 'critical'])
    .describe('How fast a human must react'),
  teams: z.array(z.enum(['frontend', 'backend', 'sre', 'security', 'docs'])),
  actionItems: z
    .array(z.string())
    .max(10)
    .describe('Atomic, single-sentence action item without markdown headers or sub-bullets'),
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
    {
      model: rt.model,
      messages: [
        {
          role: 'system',
          content:
            'You are an incident triage assistant. Analyze the ticket and provide a concise summary in English. Each action item must be a single plain-text sentence.',
        },
        { role: 'user', content: TICKET },
      ],
      options: { temperature: 0.2 },
    },
    TicketAnalysis,
  );

  const urgencyBadge = {
    low: style.green('[LOW]'),
    medium: style.yellow('[MEDIUM]'),
    high: style.magenta('[HIGH]'),
    critical: style.red('[CRITICAL]'),
  }[analysis.urgency];

  const teamBadges = analysis.teams.map((t) => style.cyan(`#${t}`)).join('  ');

  printBox('Incident Ticket Analysis', [
    `${style.bold('Title')}     : ${analysis.title}`,
    `${style.bold('Urgency')}   : ${urgencyBadge}`,
    `${style.bold('Sentiment')} : ${analysis.sentiment}`,
    `${style.bold('Teams')}     : ${teamBadges}`,
    style.dim('─'.repeat(58)),
    style.bold('Recommended Actions:'),
    ...analysis.actionItems.map(
      (item, i) => `  ${style.yellow(`${i + 1}.`)} ${item.trim()}`,
    ),
  ]);

  // ---- Telemetry from the same conversation ------------------------------
  section('2 · formatTelemetry — raw nanosecond counters → human numbers');

  const res = await rt.client.chat({
    model: rt.model,
    messages: [{ role: 'user', content: 'One-line triage summary.' }],
  });
  const t = formatTelemetry(res);

  printBox('Telemetry Summary', [
    `${style.bold('Total latency')}      : ${t.totalLatencyMs} ms`,
    `${style.bold('Model load')}         : ${t.modelLoadMs} ms`,
    `${style.bold('Prompt eval')}        : ${t.promptEvalMs} ms (${t.promptTokensPerSecond} tok/s)`,
    `${style.bold('Generation')}         : ${t.generationMs} ms (${t.tokensPerSecond} tok/s)`,
    `${style.bold('KV cache hit ratio')} : ${(t.cacheHitRatio * 100).toFixed(1)}%`,
  ]);

  await rt.shutdown();
}

void main();
