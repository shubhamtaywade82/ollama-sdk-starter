/**
 * Demo 6 — A REAL filesystem MCP server inside an Agent.
 *
 * Unlike demos 1–5, the MCP side here is never mocked: this demo spawns the
 * official `@modelcontextprotocol/server-filesystem` as a child process and
 * talks to it over stdio through the SDK's Node-only adapter
 * (`@nemesis-oss/ollama-sdk/mcp/stdio`, requires the optional peer
 * dependency `@modelcontextprotocol/client`).
 *
 * Only the chat side stays dual-mode:
 *   - LIVE mode  — a real Ollama model actually decides which filesystem
 *     tools to call ("list the workspace, read the SDK notes").
 *   - DEMO mode  — the in-memory mock server scripts the model's tool
 *     choices, but the tools STILL execute against the real MCP server:
 *     the listed directory contents and the file text you see in the
 *     output are real disk reads, not fixtures.
 *
 * Requires (already in package.json):
 *   npm install @modelcontextprotocol/client @modelcontextprotocol/server-filesystem
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  loadMcpTools,
  ToolRegistry,
  type AnyTool,
} from '@nemesis-oss/ollama-sdk';
import { connectStdioMcpClient } from '@nemesis-oss/ollama-sdk/mcp/stdio';
import {
  chatJsonFrame,
  printAnswer,
  resolveRuntime,
  section,
  style,
} from './support/runtime.js';
import type { StarterRuntime } from './support/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER_ROOT = join(HERE, '..');
/** The directory the filesystem MCP server is allowed to see. */
const WORKSPACE = join(STARTER_ROOT, 'mcp-workspace');

/**
 * Resolve the installed server's bin entry — the same thing
 * `npx @modelcontextprotocol/server-filesystem <dir>` would run, without
 * npx's download cost or network dependence.
 */
function filesystemServerEntry(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@modelcontextprotocol/server-filesystem/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    bin: Record<string, string>;
  };
  return join(dirname(pkgPath), pkg.bin['mcp-server-filesystem'] ?? 'dist/index.js');
}

/** Pick a tool by the first matching name — robust to server versions. */
function pickTool(tools: readonly AnyTool[], names: readonly string[]): AnyTool | undefined {
  const byName = new Map(tools.map((t) => [t.definition.function.name, t] as const));
  for (const name of names) {
    const tool = byName.get(name);
    if (tool) return tool;
  }
  return undefined;
}

// ---- Scripted chat routes (demo mode only) ---------------------------------
function registerDemoRoutes(server: StarterRuntime['server'], tools: readonly AnyTool[]): void {
  if (!server) return;
  server.register('/api/show', {
    chunks: chatJsonFrame({
      model: 'mock-model',
      capabilities: ['tools'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 },
    }),
  });

  // Scripted "model" choices — executed against the REAL MCP server.
  const listDir = pickTool(tools, ['list_directory', 'read_file']);
  const readNotes = pickTool(tools, ['read_text_file', 'read_file']);

  let hits = 0;
  server.register('/api/chat', {
    responder: () => {
      hits += 1;
      if (hits === 1) {
        const calls: { function: { name: string; arguments: unknown } }[] = [];
        if (listDir) {
          calls.push({ function: { name: listDir.definition.function.name, arguments: { path: WORKSPACE } } });
        }
        if (readNotes) {
          calls.push({
            function: {
              name: readNotes.definition.function.name,
              arguments: { path: join(WORKSPACE, 'sdk-notes.txt') },
            },
          });
        }
        return {
          chunks: chatJsonFrame({
            message: { role: 'assistant', content: '', tool_calls: calls },
          }),
        };
      }
      // Final answer reads the REAL file from disk — proof the workspace is real.
      const notes = readFileSync(join(WORKSPACE, 'sdk-notes.txt'), 'utf8');
      const headline = notes
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('Retry-After:')) ?? '(nothing)';
      return {
        chunks: chatJsonFrame({
          message: {
            role: 'assistant',
            content:
              `The workspace holds the starter's notes and TODO. The SDK notes say:\n` +
              `"${headline}"\n` +
              `Both results came from the real filesystem MCP server over stdio.`,
          },
          total_duration: 1_700_000_000,
          prompt_eval_count: 260,
          prompt_eval_duration: 290_000_000,
          eval_count: 55,
          eval_duration: 1_380_000_000,
        }),
      };
    },
  });
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();

  // ---- 1 · Spawn the REAL filesystem MCP server over stdio ----------------
  section('connectStdioMcpClient — spawning @modelcontextprotocol/server-filesystem');
  console.log(`  workspace : ${WORKSPACE}`);
  console.log(`  transport : stdio (node ${filesystemServerEntry().slice(-24)}…)\n`);

  const conn = await connectStdioMcpClient(
    {
      command: process.execPath, // the demo controls the runtime explicitly
      args: [filesystemServerEntry(), WORKSPACE], // server args: the allowed dir
      stderr: 'ignore', // keep the server's banner out of the demo output
    },
    { name: 'ollama-sdk-starter', version: '1.0.0' },
  );

  try {
    // ---- 2 · Discover its tools -------------------------------------------
    section('loadMcpTools — real discovery over stdio');
    const tools = await loadMcpTools(conn.client);
    for (const tool of tools) {
      const req = ((tool.definition.function.parameters as { required?: string[] })?.required ?? []).join(',');
      console.log(`  ${tool.definition.function.name}${req ? ` (${req})` : ''}`);
    }

    // ---- 3 · Run the agent --------------------------------------------------
    registerDemoRoutes(rt.server, tools);

    section('Agent — "list the workspace and read the SDK notes"');
    const registry = new ToolRegistry(tools);
    const agent = new Agent(rt.client, {
      tools: registry,
      maxIterations: 6,
      hooks: {
        onToolCallStart: (call) =>
          console.log(
            `  ${style.cyan('→ MCP tool:')} ${style.bold(call.function.name)}(${JSON.stringify(call.function.arguments)})`,
          ),
        onToolCallEnd: (result) => {
          // `outputString` is the model-visible rendering of the MCP result.
          const out = result.success ? result.outputString : `ERROR: ${result.error.message}`;
          const brief = out.split('\n').slice(0, 6).join('\n    ');
          const prefix = result.success
            ? style.green('← real MCP result:')
            : style.red('← real MCP error:');
          console.log(`  ${prefix}\n    ${style.dim(brief)}`);
        },
      },
    });

    const result = await agent.run({
      model: rt.model,
      messages: [
        {
          role: 'user',
          content: 'List the workspace directory and read the SDK notes. Use the tools.',
        },
      ],
    });

    printAnswer(result.finalMessage.content, {
      iterations: result.totalIterations,
      turns: result.turns.length,
    });
  } finally {
    // ---- 4 · Clean teardown: MCP child process first, then the client ------
    await conn.close();
  }

  await rt.shutdown();
}

void main();
