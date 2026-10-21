/**
 * Demo 3 — Streaming chat with reasoning (`thinking`) tokens.
 *
 * Reasoning models (qwen3, deepseek-r1, …) expose their chain of thought as
 * discrete `message.thinking` deltas BEFORE the answer tokens. The SDK's
 * stream surfaces them as typed `thinking` events, and `stream.finalResult`
 * resolves to the aggregated response with all telemetry counters once the
 * stream completes.
 *
 * DEMO mode: hand-built NDJSON frames — a few thinking deltas, split text
 * deltas, and a done frame carrying the official counter fields.
 */
import { formatTelemetry } from '@nemesis-oss/ollama-sdk';
import { resolveRuntime, section } from './support/runtime.js';

/** Hand-build one chat NDJSON frame (any mix of thinking / content). */
function frame(fields: Record<string, unknown>): string {
  return JSON.stringify({ model: 'mock-model', created_at: new Date().toISOString(), ...fields });
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();

  // ---- Scripted route (demo mode only) ----------------------------------
  if (rt.server) {
    const answer = 'The safest order is: page SRE first, then backend, in parallel.';
    rt.server.register('/api/chat', {
      chunks: [
        // Reasoning deltas arrive first — `message.thinking`.
        frame({ message: { role: 'assistant', thinking: 'The ticket mentions ' } }),
        frame({ message: { role: 'assistant', thinking: 'p99 latency and revenue impact… ' } }),
        frame({ message: { role: 'assistant', thinking: 'so urgency is high; SRE owns paging.' } }),
        // Then the answer, token-style deltas — `message.content`.
        ...answer.match(/.{1,12}/g)!.map((delta) =>
          frame({ message: { role: 'assistant', content: delta } }),
        ),
        // Done frame carries the counters telemetry reads.
        frame({
          message: { role: 'assistant', content: '' },
          done: true,
          total_duration: 2_480_000_000,
          load_duration: 410_000_000,
          prompt_eval_count: 118,
          prompt_eval_duration: 260_000_000,
          prompt_eval_cached_count: 64,
          eval_count: 92,
          eval_duration: 1_810_000_000,
        }),
      ],
    });
  }

  // ---- The actual stream (identical in live and demo mode) --------------
  section('Streaming with reasoning — thinking dimmed, answer bright');

  const stream = await rt.client.chat({
    model: rt.model,
    messages: [
      { role: 'user', content: 'Who should we page first for the checkout incident?' },
    ],
    think: true, // enable reasoning tokens (reasoning models)
    stream: true,
  });

  let answer = '';
  let thinking = '';
  for await (const event of stream) {
    if (event.type === 'thinking') {
      thinking += event.data.delta;
      process.stdout.write(`\x1b[2m${event.data.delta}\x1b[0m`); // dim
    } else if (event.type === 'token') {
      answer += event.data.delta;
      process.stdout.write(event.data.delta);
    }
  }
  console.log('\n');

  // ---- Aggregated final result: no manual reassembly ---------------------
  section('finalResult — aggregated response, telemetry included');

  // `finalResult` aggregates the stream; its `raw` field is the final wire
  // frame, which is where Ollama puts the nanosecond counters telemetry reads.
  const final = await stream.finalResult;
  const t = formatTelemetry(final.raw ?? {});
  console.log(`thinking chars   : ${thinking.length}`);
  console.log(`answer           : ${answer.trim()}`);
  console.log(`tokensPerSecond  : ${t.tokensPerSecond}`);
  console.log(`cacheHitRatio    : ${t.cacheHitRatio}`);
  console.log(`total latency    : ${t.totalLatencyMs} ms`);

  await rt.shutdown();
}

void main();
