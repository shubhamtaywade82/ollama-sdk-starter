/**
 * Demo 7 — Multi-Agent Router Pipeline.
 *
 * Demonstrates an autonomous orchestrator that triages incoming tasks:
 *   1. `minicpm5-router` classifies the intent into a typed category
 *   2. The pipeline dynamically routes the task to the designated specialist:
 *      - LOG_SUMMARIZATION → `minicpm5-summarizer`
 *      - CODE_REVIEW / DATA_EXTRACTION → `minicpm5-analyst`
 *      - TOOL_EXECUTION → `minicpm5-toolagent` (+ execution)
 *      - GENERAL_QUERY → `minicpm5:2b` base
 *
 * In DEMO mode: scripted routes provide deterministic responses for CI.
 */
import { chatJsonFrame, resolveRuntime, section } from './support/runtime.js';
import type { StarterRuntime } from './support/runtime.js';

interface DispatchTarget {
  readonly model: string;
  readonly role: string;
}

interface TestTask {
  readonly title: string;
  readonly prompt: string;
}

const TASKS: readonly TestTask[] = [
  {
    title: 'Incident Log Triaging',
    prompt:
      'Summarize this deploy incident: 08:01 Deploy v2.4.1 started; 08:02 DB connection pool exhausted; 08:02 p99 latency spiked to 8.7s; 08:05 Rollback to v2.4.0 triggered; 08:06 Latency normalized to 120ms.',
  },
  {
    title: 'Code Security Audit',
    prompt:
      'Review this handler for security vulnerabilities:\nfunction getUser(req) {\n  const id = req.query.id;\n  return db.raw(`SELECT * FROM users WHERE id = ${id}`);\n}',
  },
  {
    title: 'Tool Invocation',
    prompt: 'Call the weather API to fetch the current temperature in Tokyo.',
  },
];

function parseIntent(raw: string): string {
  try {
    const parsed = JSON.parse(raw.trim()) as { intent?: string };
    if (parsed.intent) return parsed.intent;
  } catch {
    // Regex fallback handles surrounding formatting or whitespace
  }
  const match = raw.match(/"intent"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? 'GENERAL_QUERY';
}

function resolveWorker(intent: string, isLive: boolean, defaultModel: string): DispatchTarget {
  if (!isLive) return { model: defaultModel, role: 'Mock Specialist' };

  switch (intent) {
    case 'LOG_SUMMARIZATION':
      return { model: 'minicpm5-summarizer:latest', role: 'Incident Summarizer' };
    case 'CODE_REVIEW':
    case 'DATA_EXTRACTION':
      return { model: 'minicpm5-analyst:latest', role: 'Security & Code Analyst' };
    case 'TOOL_EXECUTION':
      return { model: 'minicpm5-toolagent:latest', role: 'Tool Dispatcher' };
    default:
      return { model: defaultModel, role: 'General Assistant' };
  }
}

function registerDemoRoutes(server: StarterRuntime['server']): void {
  if (!server) return;

  server.register('/api/chat', {
    responder: (record) => {
      const body = record.body as { messages?: { content: string }[] };
      const content = body.messages?.[0]?.content ?? '';

      // Route router queries to structured intent JSON
      if (content.includes('Deploy incident') || content.includes('Summarize')) {
        return { chunks: chatJsonFrame({ message: { role: 'assistant', content: '{"intent": "LOG_SUMMARIZATION"}' } }) };
      }
      if (content.includes('security vulnerabilities')) {
        return { chunks: chatJsonFrame({ message: { role: 'assistant', content: '{"intent": "CODE_REVIEW"}' } }) };
      }
      if (content.includes('Available tools')) {
        return { chunks: chatJsonFrame({ message: { role: 'assistant', content: '{"intent": "TOOL_EXECUTION"}' } }) };
      }
      return { chunks: chatJsonFrame({ message: { role: 'assistant', content: 'Task completed successfully.' } }) };
    },
  });
}

function handleToolDispatch(content: string): void {
  try {
    const parsed = JSON.parse(content.trim()) as {
      tool?: string;
      arguments?: Record<string, unknown>;
    };
    if (parsed.tool) {
      console.log(`✓ Executed tool: ${parsed.tool}(${JSON.stringify(parsed.arguments ?? {})})`);
      console.log(`  → Result: { city: "${parsed.arguments?.['city'] ?? 'Tokyo'}", celsius: 21.5 }\n`);
    }
  } catch {
    // Non-JSON output does not trigger tool stub
  }
}

async function executeTask(rt: StarterRuntime, task: TestTask): Promise<void> {
  section(task.title);
  console.log(`[Input]:\n${task.prompt}\n`);

  // Step 1: Classify with router
  const routerModel = rt.mode === 'live' ? 'minicpm5-router:latest' : rt.model;
  const routeRes = await rt.client.chat({
    model: routerModel,
    messages: [{ role: 'user', content: task.prompt }],
  });

  const intent = parseIntent(routeRes.message.content);
  const worker = resolveWorker(intent, rt.mode === 'live', rt.model);

  console.log(`→ Router classification : ${intent}`);
  console.log(`→ Dispatched to worker  : ${worker.model} (${worker.role})\n`);

  // Step 2: Format prompt for specialist if tool calling
  const workerPrompt = intent === 'TOOL_EXECUTION'
    ? `Available tools:\n- get_weather(city: string): Returns temperature in Celsius.\n- list_users(): Returns all user records.\n\nUser: ${task.prompt}`
    : task.prompt;

  // Step 3: Execute with the specialist
  const workerRes = await rt.client.chat({
    model: worker.model,
    messages: [{ role: 'user', content: workerPrompt }],
  });

  console.log(`[${worker.role} Output]:\n${workerRes.message.content.trim()}\n`);

  if (intent === 'TOOL_EXECUTION') {
    handleToolDispatch(workerRes.message.content);
  }
}

async function main(): Promise<void> {
  const rt = await resolveRuntime();
  registerDemoRoutes(rt.server);

  for (const task of TASKS) {
    await executeTask(rt, task);
  }

  await rt.shutdown();
}

void main();
