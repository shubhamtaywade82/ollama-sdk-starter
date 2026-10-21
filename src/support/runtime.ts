/**
 * Dual-mode runtime for the starter demos.
 *
 * - LIVE mode: set `OLLAMA_BASE_URL` (e.g. http://localhost:11434) and the
 *   demos run against your real Ollama daemon. `OLLAMA_MODEL` picks the
 *   model (default: llama3.2).
 * - DEMO mode: no env vars → the SDK's own in-memory mock server
 *   (`@nemesis-oss/ollama-sdk/testing`) is started with scripted routes,
 *   so every demo runs with zero network, zero daemon, zero GPU.
 *
 * Each demo registers the mock routes it needs when running in demo mode —
 * that registration code is itself a live example of how to use the mock
 * server in your own tests.
 */
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import {
  createMockOllamaServer,
  type OllamaMockServer,
} from '@nemesis-oss/ollama-sdk/testing';

export interface StarterRuntime {
  /** Ready-to-use client, pointed at the live daemon or the mock server. */
  client: OllamaClient;
  /** 'live' = real daemon via OLLAMA_BASE_URL, 'demo' = in-memory mock. */
  mode: 'live' | 'demo';
  /** Model name every demo should use. */
  model: string;
  /** The mock server in demo mode (undefined in live mode). */
  server: OllamaMockServer | undefined;
  /** Always call at the end — stops the mock server, destroys the client. */
  shutdown: () => Promise<void>;
}

export async function resolveRuntime(): Promise<StarterRuntime> {
  const baseUrl = process.env['OLLAMA_BASE_URL'];

  // ---- LIVE mode: real daemon -------------------------------------------
  if (baseUrl) {
    const client = new OllamaClient({ baseUrl });
    const model = process.env['OLLAMA_MODEL'] ?? 'llama3.2';
    const ping = await client.ping();
    if (!ping.healthy) {
      console.error(`✗ Ollama at ${baseUrl} did not answer the liveness probe.`);
      process.exit(1);
    }
    console.log(
      `▶ LIVE mode — daemon at ${baseUrl} (latency ${ping.latencyMs ?? '?'}ms), model: ${model}\n`,
    );
    return {
      client,
      mode: 'live',
      model,
      server: undefined,
      shutdown: async () => {
        await client.destroy();
      },
    };
  }

  // ---- DEMO mode: in-memory mock server ----------------------------------
  const server = createMockOllamaServer();
  await server.start();
  const client = new OllamaClient({ baseUrl: server.baseUrl });
  console.log(
    `▶ DEMO mode — no OLLAMA_BASE_URL set, using the SDK's in-memory mock server (${server.baseUrl}).\n` +
      `  Set OLLAMA_BASE_URL=http://localhost:11434 to run against a real daemon.\n`,
  );
  return {
    client,
    mode: 'demo',
    model: 'mock-model',
    server,
    shutdown: async () => {
      await client.destroy();
      await server.stop();
    },
  };
}

/**
 * One non-streaming `/api/chat` JSON response frame, shaped the way the
 * daemon returns it for `stream: false`. The mock server emits each chunk
 * followed by `\n`, so a single chunk is a plain JSON body.
 */
export function chatJsonFrame(payload: Record<string, unknown>): string[] {
  return [
    JSON.stringify({
      model: 'mock-model',
      created_at: new Date().toISOString(),
      done: true,
      ...payload,
    }),
  ];
}

/** Banner + section printer so demo output reads like a transcript. */
export function section(title: string): void {
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`  ${title}`);
  console.log(`──────────────────────────────────────────────────────────────`);
}
