#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * aidev-tools MCP server (stdio). Spawned by the Claude Agent SDK / Codex CLI inside a
 * platform runtime; forwards every tool call to the runtime's local HTTP endpoint
 * (/api/aidev-tools-mcp), which talks to the aidev gateway. Tools:
 *   aidev_decide    — ask the Laya decision model (choice / score / yes-no) through the gateway registry
 *   remote_targets  — list the user's registered remote machines (stage F adds remote_exec & co.)
 */

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const textResponse = (text: string) => ({ content: [{ type: 'text', text }] });
const jsonResponse = (value: unknown) => textResponse(JSON.stringify(value, null, 2));

const apiUrl = (process.env.CLOUDCLI_AIDEV_TOOLS_API_URL || 'http://127.0.0.1:3001/api/aidev-tools-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_AIDEV_TOOLS_API_TIMEOUT_MS || '120000', 10);

async function callApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `aidev-tools request failed (${response.status})`);
  }
  return data.data;
}

const tools: ToolDefinition[] = [
  {
    name: 'aidev_decide',
    description: [
      'Ask the platform\'s fast decision model (Laya) to discriminate or choose, instead of guessing.',
      'kind "agent.pick": choose among candidates you supply in `options` ({id: description}); returns the chosen id and probabilities.',
      'kind "agent.score": rate a situation on `levels` (ordered list of level descriptions); returns the level index.',
      'kind "agent.yesno": answer a yes/no `question` about the situation; returns a 0..1 probability of "yes".',
      'Put the facts the decision depends on in `state` (short strings). Use it when you have several plausible fixes, files, approaches or risk judgements and want a calibrated pick; the result is logged for learning.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['agent.pick', 'agent.score', 'agent.yesno'] },
        question: { type: 'string', description: 'The question to decide, phrased for the situation in state.' },
        state: { type: 'object', description: 'Short facts the decision depends on, e.g. {"command": "...", "error": "..."}.' },
        options: { type: 'object', description: 'agent.pick only: {"id": "description"} of 2-20 candidates.' },
        levels: { type: 'array', items: { type: 'string' }, description: 'agent.score only: ordered level descriptions (2-7).' },
      },
      required: ['kind', 'question'],
    },
  },
  {
    name: 'remote_targets',
    description: 'List the user\'s registered remote machines (name, platform, online status, tools). Remote execution tools become available when a target is online.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'aidev_decide':
      return jsonResponse(await callApi(name, args));
    case 'remote_targets':
      return jsonResponse(await callApi(name, {}));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aidev-tools', version: '1.0.0' } };
  }
  if (message.method === 'tools/list') {
    return { tools };
  }
  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    return callTool(name, args);
  }
  if (message.method.startsWith('notifications/')) {
    return undefined;
  }
  throw new Error(`Unsupported method: ${message.method}`);
}

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
let pending = 0;
let ended = false;
const maybeExit = () => {
  if (ended && pending === 0) {
    process.exit(0);
  }
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) {
      continue;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      continue;
    }
    pending += 1;
    handleMessage(message)
      .then((result) => {
        if (message.id === undefined || result === undefined) {
          return;
        }
        write({ jsonrpc: '2.0', id: message.id, result });
      })
      .catch((error) => {
        if (message.id === undefined) {
          return;
        }
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  }
});
process.stdin.on('end', () => {
  ended = true;
  maybeExit();
});
