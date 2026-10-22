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

async function initLiveRuntime(baseUrl: string): Promise<StarterRuntime> {
  const timeoutMs = process.env['OLLAMA_TIMEOUT_MS']
    ? Number(process.env['OLLAMA_TIMEOUT_MS'])
    : 120_000;
  const client = new OllamaClient({ baseUrl, timeoutMs });
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

async function initDemoRuntime(): Promise<StarterRuntime> {
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

export async function resolveRuntime(): Promise<StarterRuntime> {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env is optional; missing file falls back to mock server
  }

  const baseUrl = process.env['OLLAMA_BASE_URL'];
  if (baseUrl) {
    return initLiveRuntime(baseUrl);
  }
  return initDemoRuntime();
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

/** Lightweight ANSI terminal styles with zero external dependencies. */
export const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

/** Render structured output cards with clear visual boundaries. */
export function printBox(title: string, lines: string[]): void {
  const width = 64;
  const header = `┌─ ${style.bold(title)} ${'─'.repeat(Math.max(0, width - title.length - 4))}`;
  console.log(`\n${header}`);
  for (const line of lines) {
    console.log(`│ ${line}`);
  }
  console.log(`└${'─'.repeat(width)}`);
}

/** Pretty-print an agent or completion final response with metadata. */
export function printAnswer(answer: string, meta?: { iterations?: number; turns?: number }): void {
  const metaText = meta?.iterations
    ? ` ${style.dim(`(${meta.iterations} iterations, ${meta.turns ?? meta.iterations} turns)`)}`
    : '';
  console.log(`\n${style.green('✓ Final Answer')}${metaText}:`);
  for (const line of answer.trim().split('\n')) {
    console.log(`  ${line}`);
  }
}
