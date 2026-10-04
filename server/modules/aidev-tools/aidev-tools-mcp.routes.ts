import express from 'express';

import { aidevToolsService, DEBUG_ADAPTERS } from '@/modules/aidev-tools/aidev-tools.service.js';
import { remotePull, remoteSync } from '@/modules/aidev-tools/remote-sync.service.js';
import { appSettingsGet, appSettingsSet, appShow } from '@/modules/aidev-tools/app-control.service.js';
import { platformShip, platformShipStatus } from '@/modules/aidev-tools/platform-ship.service.js';

/**
 * Local HTTP endpoint used only by the aidev-tools stdio MCP process
 * (aidev-tools-mcp.ts). Protected by a per-runtime token; not user facing.
 */
const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = aidevToolsService.getMcpToken();
  const token = readBearerToken(req.headers.authorization);
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid aidev-tools MCP token.' });
    return;
  }
  next();
});

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const asStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry).slice(0, 600)]));
};

/** Turn context the MCP process forwards from its env (chat run id, routed target, agent name). */
const readTurn = (input: Record<string, unknown>) => {
  const turn = asRecord(input._turn);
  const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);
  return { runId: int(turn.runId), targetId: int(turn.targetId), agent: typeof turn.agent === 'string' ? turn.agent.slice(0, 41) : null, cwd: typeof turn.cwd === 'string' ? turn.cwd.slice(0, 1000) : null };
};

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = asRecord(req.body);
    let result: unknown;
    switch (req.params.toolName) {
      case 'aidev_decide':
        result = await aidevToolsService.decide({
          kind: String(input.kind || ''),
          question: typeof input.question === 'string' ? input.question : undefined,
          state: asRecord(input.state),
          options: asStringMap(input.options),
          levels: Array.isArray(input.levels) ? input.levels.map(String) : undefined,
        });
        break;
      case 'remote_targets':
        result = await aidevToolsService.listTargets();
        break;
      case 'nadovibe_show': {
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
        result = await appShow({
          view: String(input.view ?? ''),
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          window: typeof input.window === 'string' || typeof input.window === 'number' ? input.window : undefined,
          port: typeof input.port === 'number' ? input.port : Number(input.port) || undefined,
          session: str(input.session), section: str(input.section), project: str(input.project), agent: str(input.agent), note: str(input.note),
        }, readTurn(input));
        break;
      }
      case 'platform_ship':
        result = await platformShip({
          dir: typeof input.path === 'string' && input.path.trim() ? input.path.trim() : readTurn(input).cwd,
          ref: typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim().slice(0, 100) : undefined,
          fromGithub: input.fromGithub === true,
        });
        break;
      case 'platform_ship_status':
        result = await platformShipStatus({ id: String(input.id ?? ''), waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined });
        break;
      case 'nadovibe_settings':
        if (input.action === 'get') result = await appSettingsGet();
        else if (input.action === 'set') {
          if (typeof input.key !== 'string' || !input.key) throw new Error('key is required.');
          result = await appSettingsSet({ key: input.key, value: input.value, target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined }, readTurn(input));
        } else throw new Error('action: get | set');
        break;
      case 'remote_exec': {
        const cmd = typeof input.cmd === 'string' ? input.cmd.trim() : '';
        if (!cmd) throw new Error('cmd is required.');
        const env = asStringMap(input.env);
        result = await aidevToolsService.remoteExec({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          cmd,
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
          timeoutSec: typeof input.timeoutSec === 'number' ? input.timeoutSec : undefined,
          waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined,
          background: input.background === true,
          env,
          outputBytes: typeof input.outputBytes === 'number' ? input.outputBytes : undefined,
          shell: typeof input.shell === 'string' && input.shell.trim() ? input.shell.trim() : undefined,
        }, readTurn(input));
        break;
      }
      case 'remote_pull':
        if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('path is required.');
        result = await remotePull({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          path: input.path,
          dest: typeof input.dest === 'string' ? input.dest : undefined,
        }, readTurn(input));
        break;
      case 'remote_sync':
        result = await remoteSync({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          project: typeof input.project === 'string' ? input.project : undefined,
          dest: typeof input.dest === 'string' ? input.dest : undefined,
          dryRun: input.dryRun === true,
        }, readTurn(input));
        break;
      case 'remote_logs': {
        const remoteRunId = Number(input.remoteRunId);
        if (!Number.isInteger(remoteRunId)) throw new Error('remoteRunId must be an integer.');
        result = await aidevToolsService.remoteLogs(remoteRunId, typeof input.waitSec === 'number' ? input.waitSec : 0, typeof input.outputBytes === 'number' ? input.outputBytes : undefined);
        break;
      }
      case 'remote_preview': {
        const port = Number(input.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be an integer 1024-65535.');
        result = await aidevToolsService.remotePreview({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          port,
          label: typeof input.label === 'string' ? input.label.slice(0, 120) : undefined,
        }, readTurn(input));
        break;
      }
      case 'remote_windows':
        result = await aidevToolsService.remoteWindows({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
        }, readTurn(input));
        break;
      case 'remote_screenshot':
        result = await aidevToolsService.remoteScreenshot({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          window: typeof input.window === 'number' && Number.isInteger(input.window) ? input.window : undefined,
          query: typeof input.query === 'string' && input.query.trim() ? input.query.trim().slice(0, 200) : undefined,
          display: typeof input.display === 'number' ? input.display : undefined,
          maxWidth: typeof input.maxWidth === 'number' ? input.maxWidth : undefined,
        }, readTurn(input));
        break;
      case 'remote_input': {
        const windowId = typeof input.window === 'number' && Number.isInteger(input.window) ? input.window : null;
        if (!windowId) throw new Error('window (id from remote_windows) is required.');
        const actions = Array.isArray(input.actions) ? (input.actions as unknown[]).filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object').slice(0, 50) : [];
        if (!actions.length) throw new Error('actions are required.');
        result = await aidevToolsService.remoteInput({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          window: windowId,
          actions,
          imageWidth: typeof input.imageWidth === 'number' ? input.imageWidth : undefined,
          imageHeight: typeof input.imageHeight === 'number' ? input.imageHeight : undefined,
        }, readTurn(input));
        break;
      }
      case 'remote_devices':
        result = await aidevToolsService.remoteDevices({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
        }, readTurn(input));
        break;
      case 'remote_device_shot':
        result = await aidevToolsService.remoteDeviceShot({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          tool: input.tool === 'adb' || input.tool === 'sdb' || input.tool === 'sim' ? input.tool : undefined,
          serial: typeof input.serial === 'string' && input.serial.trim() ? input.serial.trim().slice(0, 120) : undefined,
          maxWidth: typeof input.maxWidth === 'number' ? input.maxWidth : undefined,
        }, readTurn(input));
        break;
      case 'remote_debug_start': {
        const adapter = DEBUG_ADAPTERS.find((a) => a === input.adapter);
        if (!adapter) throw new Error(`adapter must be one of ${DEBUG_ADAPTERS.join(', ')}.`);
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
        const breakpoints = Array.isArray(input.breakpoints)
          ? (input.breakpoints as unknown[]).map((b) => (b && typeof b === 'object' ? b as Record<string, unknown> : {})).filter((b) => typeof (b.file ?? b.path) === 'string' && Number.isInteger(Number(b.line))).map((b) => ({ file: String(b.file ?? b.path), line: Number(b.line), condition: typeof b.condition === 'string' ? b.condition : undefined }))
          : undefined;
        result = await aidevToolsService.remoteDebugStart({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          adapter,
          program: typeof input.program === 'string' && input.program.trim() ? input.program.trim() : undefined,
          module: typeof input.module === 'string' && input.module.trim() ? input.module.trim() : undefined,
          runtimeExecutable: typeof input.runtimeExecutable === 'string' ? input.runtimeExecutable : undefined,
          runtimeArgs: strs(input.runtimeArgs), args: strs(input.args),
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
          env: asStringMap(input.env), stopOnEntry: input.stopOnEntry === true, breakpoints,
          request: input.request === 'attach' ? 'attach' : undefined,
          pid: typeof input.pid === 'number' && Number.isInteger(input.pid) ? input.pid : undefined,
          address: text(input.address), debugger: text(input.debugger), mainClass: text(input.mainClass), classPath: strs(input.classPath),
          chip: text(input.chip), probe: text(input.probe), device: text(input.device), command: text(input.command), commandArgs: strs(input.commandArgs),
          transport: input.transport === 'tcp' ? 'tcp' : input.transport === 'stdio' ? 'stdio' : undefined,
          config: input.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config as Record<string, unknown> : undefined,
          mobile: input.mobile === 'android' || input.mobile === 'ios-sim' ? input.mobile : undefined,
          appId: text(input.appId), activity: text(input.activity), server: strs(input.server),
          arch: input.arch === 'x86' || input.arch === 'x64' ? input.arch : undefined,
          waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined,
        }, readTurn(input));
        break;
      }
      case 'remote_agent': {
        const task = typeof input.task === 'string' ? input.task.trim() : '';
        if (!task) throw new Error('task is required.');
        if (task.length > 60_000) throw new Error('task is too long (≤ 60000 chars).');
        result = await aidevToolsService.remoteAgent({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          task,
          agent: typeof input.agent === 'string' ? input.agent : undefined,
          mode: input.mode === 'readonly' ? 'readonly' : 'full',
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
          resume: typeof input.resume === 'string' && input.resume.trim() ? input.resume.trim() : undefined,
          model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined,
          waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined,
          background: input.background === true,
        }, readTurn(input));
        break;
      }
      case 'remote_agent_result': {
        const id = Number(input.remoteRunId);
        if (!Number.isInteger(id) || id <= 0) throw new Error('remoteRunId (from remote_agent) is required.');
        const agent = input.agent === 'claude' || input.agent === 'codex' || input.agent === 'gemini' ? input.agent : undefined;
        result = await aidevToolsService.remoteAgentResult(id, typeof input.waitSec === 'number' ? input.waitSec : 600, agent);
        break;
      }
      case 'remote_console_start': {
        const command = typeof input.command === 'string' ? input.command.trim() : '';
        if (!command) throw new Error('command is required.');
        result = await aidevToolsService.remoteConsoleStart({
          target: typeof input.target === 'string' || typeof input.target === 'number' ? input.target : undefined,
          command,
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
          env: asStringMap(input.env),
          prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim() : undefined,
          waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined,
        }, readTurn(input));
        break;
      }
      case 'remote_console_send':
        result = await aidevToolsService.remoteConsoleSend(debugSession(input), {
          input: typeof input.input === 'string' ? input.input : undefined, interrupt: input.interrupt === true,
          waitSec: typeof input.waitSec === 'number' ? input.waitSec : undefined, quietMs: typeof input.quietMs === 'number' ? input.quietMs : undefined,
        });
        break;
      case 'remote_console_read':
        result = await aidevToolsService.remoteConsoleRead(debugSession(input), typeof input.waitSec === 'number' ? input.waitSec : 10);
        break;
      case 'remote_console_stop':
        result = await aidevToolsService.remoteConsoleStop(debugSession(input));
        break;
      case 'remote_debug_step': {
        const action = String(input.action ?? '');
        if (!['continue', 'next', 'stepIn', 'stepOut', 'pause'].includes(action)) throw new Error('action must be continue, next, stepIn, stepOut or pause.');
        result = await aidevToolsService.remoteDebugStep(debugSession(input), action, typeof input.waitSec === 'number' ? input.waitSec : 30);
        break;
      }
      case 'remote_debug_eval':
        result = await aidevToolsService.remoteDebugEval(debugSession(input), {
          expression: typeof input.expression === 'string' && input.expression.trim() ? input.expression : undefined,
          ref: typeof input.ref === 'number' && input.ref > 0 ? input.ref : undefined,
          frameId: typeof input.frameId === 'number' ? input.frameId : undefined,
        });
        break;
      case 'remote_debug_breakpoints': {
        const file = typeof input.file === 'string' ? input.file.trim() : '';
        if (!file) throw new Error('file is required.');
        const lines = (Array.isArray(input.lines) ? input.lines : []).map((l) => (typeof l === 'number' ? l : { line: Number((l as { line?: unknown })?.line), condition: typeof (l as { condition?: unknown })?.condition === 'string' ? String((l as { condition: string }).condition) : undefined }));
        result = await aidevToolsService.remoteDebugBreakpoints(debugSession(input), file, lines);
        break;
      }
      case 'remote_debug_stop':
        result = await aidevToolsService.remoteDebugStop(debugSession(input));
        break;
      case 'remote_stop': {
        const remoteRunId = Number(input.remoteRunId);
        if (!Number.isInteger(remoteRunId)) throw new Error('remoteRunId must be an integer.');
        const signal = input.signal === 'KILL' || input.signal === 'TERM' ? input.signal : 'INT';
        result = await aidevToolsService.remoteStop(remoteRunId, signal);
        break;
      }
      case 'remote_rpc': {
        const targetId = Number(input.targetId);
        if (!Number.isInteger(targetId)) {
          throw new Error('targetId must be an integer.');
        }
        result = await aidevToolsService.targetRpc(targetId, String(input.method || ''), asRecord(input.params));
        break;
      }
      default:
        res.status(404).json({ success: false, error: `Unknown tool: ${req.params.toolName}` });
        return;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'aidev-tools request failed' });
  }
});

/** A debug session id as the gateway issues them (letters and digits). */
function debugSession(input: Record<string, unknown>): string {
  const id = typeof input.session === 'string' ? input.session.trim() : '';
  if (!/^[A-Za-z0-9]{4,40}$/.test(id)) throw new Error('session (from remote_debug_start / remote_console_start) is required.');
  return id;
}

export default router;
