/**
 * Demo 2 — Autonomous tool-calling agent (`Agent` + `defineTool`).
 *
 * The `Agent` class runs the full loop for you: model proposes tool calls →
 * arguments validated against the Zod schema → tool executes → result goes
 * back to the model → repeat until a final answer. Guardrails included:
 * max iterations, tool-call budgets, and cycle detection.
 *
 * Here a "weather → unit conversion" mini-workflow shows the model chaining
 * two tools across turns, with hooks printing the loop as it runs.
 *
 * DEMO mode: the mock server uses a hit counter in a request-aware
 * `responder` — 1st request returns tool calls, 2nd returns the final
 * answer, exactly how a real multi-turn exchange reads on the wire.
 * `/api/show` advertises the `tools` capability, which the Agent's
 * pre-flight validation checks.
 */
import { z } from 'zod';
import {
  Agent,
  defineTool,
  ToolRegistry,
} from '@nemesis-oss/ollama-sdk';
import {
  chatJsonFrame,
  printBox,
  resolveRuntime,
  section,
  style,
} from './support/runtime.js';
import type { StarterRuntime } from './support/runtime.js';

// ---- Tools: plain Zod in, plain objects out ------------------------------
const getWeather = defineTool({
  name: 'get_weather_celsius',
  description: 'Current temperature in Celsius for a city',
  schema: z.object({ city: z.string().describe('City name, e.g. "Paris"') }),
  execute: async ({ city }) => {
    // In real life: an HTTP call. Here: deterministic stub.
    const temps: Record<string, number> = { paris: 21.5, tokyo: 27, berlin: 16 };
    return { city, celsius: temps[city.toLowerCase()] ?? 20 };
  },
});

const convert = defineTool({
  name: 'celsius_to_fahrenheit',
  description: 'Convert a Celsius temperature to Fahrenheit',
  schema: z.object({ celsius: z.number() }),
  execute: async ({ celsius }) => ({ celsius, fahrenheit: (celsius * 9) / 5 + 32 }),
});

// ---- Scripted routes (demo mode only) -------------------------------------
function registerDemoRoutes(server: StarterRuntime['server']): void {
  if (!server) return;

  // The Agent validates the model advertises the "tools" capability —
  // /api/show must say so, exactly like a real tools-capable model.
  server.register('/api/show', {
    chunks: chatJsonFrame({
      model: 'mock-model',
      capabilities: ['tools'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 },
    }),
  });

  let hits = 0;
  server.register('/api/chat', {
    responder: () => {
      hits += 1;
      // 1st model turn: propose both tool calls in one frame (parallel calls).
      if (hits === 1) {
        return {
          chunks: chatJsonFrame({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: { name: 'get_weather_celsius', arguments: { city: 'Paris' } },
                },
                {
                  function: { name: 'celsius_to_fahrenheit', arguments: { celsius: 21.5 } },
                },
              ],
            },
          }),
        };
      }
      // 2nd model turn: tool results are in history → final answer.
      return {
        chunks: chatJsonFrame({
          message: {
            role: 'assistant',
            content:
              'It is currently 21.5 °C (70.7 °F) in Paris — mild, with the ' +
              'temperature read via get_weather_celsius and converted with ' +
              'celsius_to_fahrenheit.',
          },
          total_duration: 2_100_000_000,
          prompt_eval_count: 210,
          prompt_eval_duration: 340_000_000,
          eval_count: 58,
          eval_duration: 1_720_000_000,
        }),
      };
    },
  });
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();
  registerDemoRoutes(rt.server);

  // ---- The actual agent (identical in live and demo mode) ----------------
  section('Agent — "What is the temperature in Paris in Fahrenheit?"');

  const registry = new ToolRegistry([getWeather, convert]);
  const agent = new Agent(rt.client, {
    tools: registry,
    maxIterations: 5, // loop guardrail
    maxToolCalls: 8, // total tool-call budget
    maxRepeatedToolCalls: 2, // cycle detection: same call+args twice max
    hooks: {
      onTurnStart: (i) => console.log(`\n${style.bold(`· turn ${i}`)}`),
      onToolCallStart: (call) =>
        console.log(
          `  ${style.cyan('→ tool:')} ${style.bold(call.function.name)}(${JSON.stringify(call.function.arguments)})`,
        ),
      onToolCallEnd: (result) =>
        console.log(
          result.success
            ? `  ${style.green('← result:')} ${JSON.stringify(result.result)}`
            : `  ${style.red('← error:')} ${result.error.message}`,
        ),
    },
  });

  const result = await agent.run({
    model: rt.model,
    messages: [
      {
        role: 'user',
        content:
          'What is the temperature in Paris in Fahrenheit? Use the available tools.',
      },
    ],
  });

  const turnHistory = result.turns.map((turn) => {
    const tools = turn.toolCalls?.map((c) => style.cyan(c.function.name)).join(', ');
    return `  turn ${turn.iteration}: ${tools ? `called [${tools}]` : style.green('final answer')}`;
  });

  printBox('Agent Result', [
    `${style.bold('Answer')}     : ${result.finalMessage.content.trim()}`,
    `${style.bold('Iterations')} : ${result.totalIterations} (budget: 5)`,
    `${style.bold('Turns')}      : ${result.turns.length}`,
    style.dim('─'.repeat(58)),
    style.bold('Execution History:'),
    ...turnHistory,
  ]);

  await rt.shutdown();
}

void main();
