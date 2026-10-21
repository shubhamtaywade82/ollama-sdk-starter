/**
 * Demo 5 — MCP (Model Context Protocol) tools inside an Agent.
 *
 * `loadMcpTools(mcpClient)` discovers tools from any MCP server (stdio,
 * Streamable HTTP, or — as here — any object satisfying `McpClientLike`)
 * and converts them into executable Ollama function tools:
 *
 *   - paginated `tools/list` discovery is followed automatically
 *   - the MCP JSON Schema is preserved in the model-visible definition
 *   - arguments are validated against that schema BEFORE the server is called
 *   - `structuredContent` survives for application code (`resultMode: 'structured'`)
 *   - MCP `isError: true` results stay model-readable, not transport crashes
 *
 * Here the Agent uses two MCP tools: a text-result search and a
 * structured-output lookup, then answers with both results.
 *
 * In real life you would connect via the official transports:
 *   import { createStdioMcpClient } from '@nemesis-oss/ollama-sdk/mcp/stdio';
 *   import { createHttpMcpClient } from '@nemesis-oss/ollama-sdk/mcp/http';
 */
import {
  Agent,
  loadMcpTools,
  ToolRegistry,
  type McpClientLike,
  type McpCallToolResult,
  type McpListToolsResult,
  type McpToolCallResult,
} from '@nemesis-oss/ollama-sdk';
import { chatJsonFrame, resolveRuntime, section } from './support/runtime.js';
import type { StarterRuntime } from './support/runtime.js';

// ---- An in-memory "MCP server" ---------------------------------------------
// Implements just `listTools` + `callTool` — the whole surface McpClientLike
// requires. Page 1 returns one tool + a nextCursor, page 2 the rest, proving
// paginated discovery works through the bridge.
const KNOWLEDGE: Record<string, string> = {
  retry: 'Retry-After honoring: on 429s the SDK sleeps the server-declared delay verbatim (v1.19.1).',
  stream: 'Streams emit thinking/token events; finalResult aggregates telemetry counters.',
};

const mcpServer: McpClientLike = {
  listTools: async (params): Promise<McpListToolsResult> => {
    if (params?.cursor === undefined) {
      return {
        tools: [
          {
            name: 'search_knowledge',
            description: 'Search the internal knowledge base for SDK behavior notes',
            inputSchema: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
          },
        ],
        nextCursor: 'page-2',
      };
    }
    return {
      tools: [
        {
          name: 'get_version_info',
          description: 'Structured facts about the installed SDK release',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { version: { type: 'string' } },
            required: ['version'],
          },
        },
      ],
    };
  },

  callTool: async (params): Promise<McpToolCallResult> => {
    if (params.name === 'search_knowledge') {
      const topic = String((params.arguments as { topic?: string }).topic ?? '');
      const note = KNOWLEDGE[topic.toLowerCase()] ?? null;
      // MCP-style error: stays model-readable, becomes a tool result, not a crash.
      if (!note) {
        return {
          content: [{ type: 'text', text: `No notes for topic "${topic}".` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: note }] };
    }
    if (params.name === 'get_version_info') {
      return {
        content: [{ type: 'text', text: 'SDK version 1.19.1' }],
        structuredContent: { version: '1.19.1' },
      };
    }
    return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
  },
};

// ---- Scripted Ollama routes (demo mode only) --------------------------------
function registerDemoRoutes(server: StarterRuntime['server']): void {
  if (!server) return;
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
      if (hits === 1) {
        return {
          chunks: chatJsonFrame({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'search_knowledge',
                    arguments: { topic: 'retry' },
                  },
                },
                {
                  function: { name: 'get_version_info', arguments: {} },
                },
              ],
            },
          }),
        };
      }
      return {
        chunks: chatJsonFrame({
          message: {
            role: 'assistant',
            content:
              'Per the knowledge base: on 429 rate limits the SDK honors Retry-After, ' +
              'sleeping the server-declared delay verbatim since v1.19.1 (confirmed by ' +
              'the version tool).',
          },
          total_duration: 1_900_000_000,
          prompt_eval_count: 240,
          prompt_eval_duration: 310_000_000,
          eval_count: 61,
          eval_duration: 1_560_000_000,
        }),
      };
    },
  });
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();
  registerDemoRoutes(rt.server);

  // ---- Discover + convert MCP tools (identical in live and demo mode) ----
  section('loadMcpTools — paginated discovery, schema preserved');

  // Default resultMode is the model-oriented text string; 'structured' keeps
  // the raw CallToolResult (structuredContent, isError, content blocks).
  const mcpTools = await loadMcpTools(mcpServer, { resultMode: 'structured' });
  for (const tool of mcpTools) {
    const fn = tool.definition.function;
    console.log(`  discovered: ${fn.name} (${JSON.stringify(fn.parameters)})`);
  }

  // ---- Run an Agent over them ----------------------------------------------
  section('Agent — answering through MCP-backed tools');

  const registry = new ToolRegistry(mcpTools);
  const agent = new Agent(rt.client, {
    tools: registry,
    maxIterations: 5,
    hooks: {
      onToolCallStart: (call) =>
        console.log(`  → MCP tool: ${call.function.name}(${JSON.stringify(call.function.arguments)})`),
      onToolCallEnd: (result) => {
        // resultMode 'structured': raw MCP result, structuredContent intact.
        if (!result.success) {
          console.log(`  ← MCP result: ERROR: ${result.error.message}`);
          return;
        }
        const raw = result.result as McpCallToolResult;
        const text = raw.content.find((block) => block.type === 'text')?.text ?? '';
        console.log(
          `  ← MCP result: ${
            raw.structuredContent !== undefined
              ? JSON.stringify(raw.structuredContent)
              : text
          }`,
        );
      },
    },
  });

  const result = await agent.run({
    model: rt.model,
    messages: [
      { role: 'user', content: 'How does the SDK handle 429 rate limits? Which version?' },
    ],
  });

  console.log(`\n  final answer: ${result.finalMessage.content.trim()}`);
  console.log(`  iterations   : ${result.totalIterations}`);

  await rt.shutdown();
}

void main();
