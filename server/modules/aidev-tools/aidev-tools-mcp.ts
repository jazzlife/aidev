#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * aidev-tools MCP server (stdio). Spawned by the Claude Agent SDK / Codex CLI inside a
 * platform runtime; forwards every tool call to the runtime's local HTTP endpoint
 * (/api/aidev-tools-mcp), which talks to the aidev gateway. Tools:
 *   aidev_decide    — ask the Laya decision model (choice / score / yes-no) through the gateway registry
 *   remote_targets  — list the user's registered remote machines
 *   remote_exec     — run a shell command on one of them (gateway gate: safe → runs, risky → user approval)
 *   remote_logs     — state + last output of a remote run (optionally wait for it)
 *   remote_stop     — interrupt / kill a remote run
 *   remote_preview  — show a dev server running on a target in the workbench preview panel (F-06)
 *   remote_windows  — the program windows open on a target (id, app, title) (F-07c)
 *   remote_screenshot — look at one program window on a target (image content; needs the PC owner's consent) (F-07)
 *   remote_input — click, type and press keys in one program window on a target (owner's control consent)
 *   remote_devices / remote_device_shot — phones, TVs, simulators attached to a target and their screen (F-10)
 *   remote_debug_start / _step / _eval / _breakpoints / _stop — debug a program on a target over DAP (F-09, F-09b: 14 adapters)
 *   remote_console_start / _send / _read / _stop — drive any command-line debugger or REPL on a target (F-09c)
 *   remote_agent / remote_agent_result — delegate a task to an agent CLI on the target (Claude Code, Codex, Gemini CLI) (F-09d)
 * The turn context (chat run id, routed target, agent) comes from this process's env and is sent
 * with every call, so remote results count toward the run's outcome.
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
/** A screenshot as MCP image content (the model sees the picture) plus its metadata as text. */
const imageResponse = (value: unknown) => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const { image, mime, ...meta } = v;
  if (typeof image !== 'string') return jsonResponse(value);
  return { content: [{ type: 'image', data: image, mimeType: typeof mime === 'string' ? mime : 'image/jpeg' }, { type: 'text', text: JSON.stringify(meta, null, 2) }] };
};

const apiUrl = (process.env.CLOUDCLI_AIDEV_TOOLS_API_URL || 'http://127.0.0.1:3001/api/aidev-tools-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_AIDEV_TOOLS_API_TIMEOUT_MS || '120000', 10);

const turnContext = {
  runId: Number.parseInt(process.env.AIDEV_RUN_ID || '', 10) || undefined,
  targetId: Number.parseInt(process.env.AIDEV_TARGET_ID || '', 10) || undefined,
  agent: process.env.AIDEV_AGENT || undefined,
  // the engine starts this process in the session's project folder: remote_sync's default source
  cwd: process.cwd(),
};
// approvals can take minutes and a build or test run longer: remote tools get their own ceiling
const LONG_TOOLS = new Set(['remote_agent', 'remote_agent_result', 'remote_exec', 'remote_logs', 'remote_sync', 'remote_pull', 'remote_debug_start', 'remote_debug_step', 'remote_console_start', 'remote_console_send', 'remote_console_read']);
const LONG_TIMEOUT_MS = 45 * 60_000;

async function callApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, _turn: turnContext }),
    signal: AbortSignal.timeout(LONG_TOOLS.has(toolName) ? LONG_TIMEOUT_MS : API_TIMEOUT_MS),
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
    name: 'nadovibe_show',
    description: [
      'Show the user something inside NadoVibe (the app they are using): opens it on their open workbench / phone pages at once.',
      'view "screen": a PC\'s live screen with control — `window` "full" (the whole screen, default) or a window id from remote_windows; use it when the user should see or check a program running on their PC (after starting it), or watch you work.',
      'view "preview": a web app preview (target + port, after remote_preview). view "debug": the debugger (session from remote_debug_start).',
      'view "pcs": PC pairing (register/connect a PC). view "settings" (section: routing | effort | engines | notifications | account). view "project" (project id or name). view "catalog" (agent name).',
      'Returns viewers: 0 means nobody has NadoVibe open — then tell the user where to look instead. Say in the chat what you opened and what to check.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['screen', 'preview', 'debug', 'pcs', 'settings', 'project', 'catalog'] },
        target: { type: 'string', description: 'PC name or id (screen, preview, debug). Optional when routed or only one is online.' },
        window: { type: 'string', description: 'screen: "full" (whole screen, default) or a window id from remote_windows.' },
        port: { type: 'number', description: 'preview: the dev server port.' },
        session: { type: 'string', description: 'debug: the debug session id.' },
        section: { type: 'string', description: 'settings: which part.' },
        project: { type: 'string', description: 'project: id or name.' },
        agent: { type: 'string', description: 'catalog: agent name.' },
        note: { type: 'string', description: 'One short line shown to the user with it, e.g. "로그인 창이 뜨는지 확인해 주세요".' },
      },
      required: ['view'],
    },
  },
  {
    name: 'nadovibe_settings',
    description: [
      'Read or change the user\'s NadoVibe settings directly (the user allowed changes without asking; tell them what you changed).',
      'action "get": the PCs (online, execution policy, default PC, screen/control allowed), effort ceilings, engines, and the keys you can set.',
      'action "set" {key, value, target?}: pc.policy (full|auto|ask|deny), pc.default (true|false), pc.screen / pc.control (allow screen capture / remote control on that PC — use before showing or controlling its screen when it is off), effort_cap.claude / effort_cap.codex, routing_mode (auto|manual|off).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        key: { type: 'string' },
        value: { type: 'string', description: 'The new value (true/false, a policy, an effort, a mode).' },
        target: { type: 'string', description: 'PC name or id for pc.* keys.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'remote_targets',
    description: 'List the user\'s registered remote machines (their own PCs running aidev-runner): name, platform, online status, execution policy, allowed folders and installed tools. Call it first when the user asks to run, build, test or check something "on my Mac/PC/machine".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remote_exec',
    description: [
      'Run a shell command on one of the user\'s own machines (see remote_targets) and get its exit code and output.',
      'Runs through the user\'s login shell inside an allowed folder (`cwd`, absolute or relative to the first allowed folder; default: the first allowed folder).',
      'Read/build/test commands start immediately; commands that change files or the system may wait for the user\'s approval in the chat (up to 10 min) — the call returns status "denied" or "expired" if they refuse; then do not retry the same command.',
      'Destructive commands (rm -rf, sudo, force push, installs, system settings) always need approval — avoid them unless the user asked.',
      'Waits for the command to finish (up to waitSec, default 300); for dev servers/watchers use background:true and read on with remote_logs. Stop with remote_stop.',
      'A failing test command marks this task\'s result as failed until it passes, so fix and re-run.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id. Optional when the task was routed to a target or only one is online.' },
        cmd: { type: 'string', description: 'Shell command line, e.g. "npm test" or "cd app && npm ci && npm run build".' },
        cwd: { type: 'string', description: 'Working folder inside the target\'s allowed folders.' },
        waitSec: { type: 'number', description: 'How long to wait for the result (1-1800, default 300). If still running, the result says so and gives remoteRunId.' },
        background: { type: 'boolean', description: 'Start and return after ~5 s with the first output (dev servers, watchers).' },
        timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (runner-side limit).' },
        env: { type: 'object', description: 'Extra environment variables {NAME: value}. The runner passes only these plus a safe baseline (PATH, HOME, LANG…).' },
        outputBytes: { type: 'number', description: 'How much trailing output to return (1000-60000, default 12000).' },
        shell: { type: 'string', enum: ['powershell', 'pwsh', 'cmd', 'bash', 'sh'], description: 'Shell for cmd (see the target\'s `shells`). Windows: "powershell" for PowerShell/CIM administration and monitoring (Get-CimInstance, Get-WinEvent, Get-Service, Get-Process, Get-Counter …; the command is passed encoded — write it as you would in a .ps1, no extra quoting), "bash" for Git Bash; default is cmd.exe on Windows and the login shell elsewhere. Output is UTF-8; exit code = the last statement\'s.' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'remote_pull',
    description: [
      'Copy one file from one of the user\'s machines (inside its allowed folders) into this workspace — logs, test reports, build outputs, crash dumps, an APK or binary; then read or analyse it here.',
      'Use instead of printing big files through remote_exec (its output is cut to the last 60 KB). Up to 200 MB, checked with sha256. For a folder or a phone\'s file, first pack or copy it on the target (tar/Compress-Archive, adb pull) and pull that file.',
      'Default destination: .aidev/pulled/<file name> in the current project (never sent back by remote_sync).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        path: { type: 'string', description: 'File on the target: absolute inside an allowed folder, ~/…, or relative to the first allowed folder.' },
        dest: { type: 'string', description: 'Where to put it here (relative to the project folder, or absolute; an existing folder keeps the file name).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'remote_sync',
    description: [
      'Copy this project (the workspace folder of the current session, or `project`) to one of the user\'s machines before running it there with remote_exec.',
      'Only changed files are sent (sha256); files deleted here are deleted there too, but only those an earlier sync wrote — the user\'s own files on the machine are never touched.',
      'Honours .gitignore and .aidevignore; node_modules/.git/.venv are never copied, so install dependencies on the target (npm ci, pip install -r …).',
      'Returns `dest` — use it as `cwd` for remote_exec. Default dest: <first allowed folder>/<project folder name>. Call it again after editing files here.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        project: { type: 'string', description: 'Project folder here (absolute, or a name under ~/workspace). Default: the current session\'s folder.' },
        dest: { type: 'string', description: 'Folder on the target (absolute inside an allowed folder, or relative to the first allowed folder).' },
        dryRun: { type: 'boolean', description: 'Only report what would be uploaded/deleted.' },
      },
    },
  },
  {
    name: 'remote_logs',
    description: 'State and last output of a remote run started with remote_exec (by remoteRunId). Pass waitSec to wait for it to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        remoteRunId: { type: 'number' },
        waitSec: { type: 'number', description: '0 (default) returns now; up to 1800 waits for the end.' },
        outputBytes: { type: 'number' },
      },
      required: ['remoteRunId'],
    },
  },
  {
    name: 'remote_preview',
    description: [
      'Show a web dev server that runs on one of the user\'s machines in their workbench preview panel (and give them a URL that also opens on a phone).',
      'Call it first to get `base`, start the server with that base (Vite: `npm run dev -- --base <base> --port <port>`, Next.js: basePath) via remote_exec background:true, then call it again: the result says whether the page answers (`status`, `mode`).',
      'Hot reload keeps working. Only servers on the machine\'s localhost, ports 1024-65535.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port the dev server listens on (on the target machine).' },
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        label: { type: 'string', description: 'Short name shown in the preview list (e.g. "todo app").' },
      },
      required: ['port'],
    },
  },
  {
    name: 'remote_windows',
    description: 'List the program windows open on one of the user\'s machines (id, app, title, size; the focused one first) — pick one for remote_screenshot. Needs the owner\'s screen-capture consent on that PC.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' } },
    },
  },
  {
    name: 'remote_input',
    description: [
      'Use the mouse and keyboard in one program window on one of the user\'s machines — click buttons, fill fields, press keys, scroll — e.g. to drive a desktop app, an emulator or a dialog while testing.',
      'Take remote_screenshot of the window first; give x, y as pixel positions in that screenshot together with its width/height as imageWidth/imageHeight (or as fractions 0-1 of the window). Look again with remote_screenshot afterwards.',
      'Needs the owner\'s remote-control consent on that PC (`aidev-runner consent control on`). Every call is recorded.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        window: { type: 'number', description: 'Window id from remote_windows / remote_screenshot.' },
        imageWidth: { type: 'number', description: 'Width of the screenshot the x, y come from.' },
        imageHeight: { type: 'number', description: 'Height of the screenshot the x, y come from.' },
        actions: {
          type: 'array',
          description: 'In order (≤ 50): {type:"click", x, y, button?:"left"|"right"|"middle", double?:true} · {type:"move", x, y} · {type:"type", text} · {type:"key", key:"Enter"|"Tab"|"Escape"|"Backspace"|"ArrowUp"|"a"…, mods?:{ctrl,alt,shift,meta}} · {type:"scroll", dy (notches, + = down), x?, y?} · {type:"wait", ms ≤ 3000}',
          items: { type: 'object' },
        },
      },
      required: ['window', 'actions'],
    },
  },
  {
    name: 'remote_devices',
    description: 'List the phones, TVs, watches and simulators attached to one of the user\'s machines: Android (adb), Tizen (sdb) and booted iOS simulators — tool, serial, state ("device" = usable; "unauthorized" = allow USB debugging on the phone), name. Pick one for remote_device_shot or remote_debug_start.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' } },
    },
  },
  {
    name: 'remote_device_shot',
    description: 'Take a screenshot of an attached phone / TV / simulator (from remote_devices) and look at it (returned as an image) — e.g. to check what a mobile app shows after running it. Without serial the only usable device is used. Needs the PC owner\'s screen-capture consent; every capture is recorded. View only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        tool: { type: 'string', enum: ['adb', 'sdb', 'sim'], description: 'adb (Android), sdb (Tizen) or sim (iOS simulator).' },
        serial: { type: 'string', description: 'Device serial / simulator UDID from remote_devices.' },
        maxWidth: { type: 'number', description: 'Scale down to this width (default 1080).' },
      },
    },
  },
  {
    name: 'remote_screenshot',
    description: [
      'Take a screenshot of one program window on one of the user\'s machines and look at it (returned as an image) — e.g. to check a desktop/mobile app window, an emulator, a dialog, or what a running program shows.',
      'Choose the window with `window` (id from remote_windows) or `query` (part of the app name or title, e.g. "Simulator"); without either, the focused window.',
      'Works only when the owner allowed screen capture on that PC (`aidev-runner consent screen on`); every capture is recorded in the target\'s history. To click or type in the window use remote_input, then look again.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        window: { type: 'number', description: 'Window id from remote_windows.' },
        query: { type: 'string', description: 'Part of the app name or window title (case-insensitive); the first match is captured.' },
        maxWidth: { type: 'number', description: 'Scale down to this width (320-2560, default 1440; smaller = cheaper to look at).' },
      },
    },
  },
  {
    name: 'remote_debug_start',
    description: [
      'Debug a program on one of the user\'s machines: run it under a real debugger with breakpoints and look at the stack and variables where it stops (instead of guessing from logs).',
      'Pick the adapter by language/runtime:',
      'js-debug = Node.js/TypeScript (program .js, or runtimeExecutable npm/npx/tsx + runtimeArgs); debugpy = Python (program .py, or module e.g. pytest);',
      'codelldb = C/C++/Rust/Swift/Zig with LLDB (a binary built with debug info: cc -g -O0, cargo build); gdb = C/C++/Rust/Go/Fortran with GDB ≥ 14 (debugger: gdb-multiarch / arm-none-eabi-gdb for other CPUs; attach address = a gdbserver/OpenOCD/QEMU host:port for SBCs, MCUs, emulators);',
      'lldb-dap = Apple toolchain (macOS apps, iOS simulator; attach pid or program+waitFor); netcoredbg = .NET 6+ (C#/F#: console, ASP.NET, WPF/WinForms on .NET, Avalonia, MAUI; program = the built .dll or apphost);',
      'clrdbg = .NET Framework 4.x on Windows; mono = Mono/Unity (launch program .exe, or attach address of a --debugger-agent); delve = Go (program = package folder, attach pid or dlv --headless address);',
      'jvm = Java/Kotlin/Scala (mainClass + classPath, or program = an executable .jar; attach address = a JDWP host:port, e.g. an Android app after adb forward tcp:N jdwp:PID);',
      'dart/flutter = Dart and Flutter (device = flutter device id); probe-rs = microcontrollers through a debug probe (chip required, program = ELF);',
      'custom = any other DAP server (command + commandArgs, transport stdio|tcp with {port}). request "attach" joins a running process (pid) or debug server (address).',
      'If no adapter fits, use remote_exec with the platform debugger\'s own CLI (gdb -batch, lldb -b, jdb, cdb, pdb) instead.',
      'Paths are on the target (inside its allowed folders; relative = relative to cwd). Sync the project first with remote_sync and use its dest as cwd; build with debug info first (remote_exec).',
      'Waits until the program pauses (breakpoint, exception, stopOnEntry) or ends (waitSec, default 60) and returns: session, state, pausedAt, stack (with frame ids), locals (ref>0 = expandable), breakpoints (verified?), output.',
      'Like remote_exec, a program that is not a read/build/test command may wait for the user\'s approval. The user sees the same session in their debug window. Always end with remote_debug_stop.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        adapter: { type: 'string', enum: ['js-debug', 'debugpy', 'codelldb', 'gdb', 'lldb-dap', 'netcoredbg', 'delve', 'jvm', 'dart', 'flutter', 'probe-rs', 'mono', 'clrdbg', 'custom'] },
        request: { type: 'string', enum: ['launch', 'attach'], description: 'launch (default) starts program; attach joins a running process (pid) or debug server (address).' },
        program: { type: 'string', description: 'What to run: a .js/.py file, a debug binary/ELF, a .dll, a Go package folder, a .jar, a .dart file.' },
        pid: { type: 'number', description: 'attach: process id on the target.' },
        address: { type: 'string', description: 'attach: host:port of a debug server (gdbserver/OpenOCD/QEMU, JDWP, node --inspect, debugpy --listen, dlv --headless, mono agent) or a Dart VM service URI.' },
        debugger: { type: 'string', description: 'gdb: which gdb binary (gdb-multiarch, arm-none-eabi-gdb, …).' },
        mainClass: { type: 'string', description: 'jvm: main class (com.acme.App); with classPath.' },
        classPath: { type: 'array', items: { type: 'string' }, description: 'jvm: class path entries (folders/jars, relative to cwd).' },
        chip: { type: 'string', description: 'probe-rs: target chip, e.g. STM32F411RETx, nRF52840_xxAA, esp32c3.' },
        probe: { type: 'string', description: 'probe-rs: probe selector VID:PID[:serial] when several are connected.' },
        device: { type: 'string', description: 'flutter: device id from `flutter devices`.' },
        command: { type: 'string', description: 'custom: the DAP server executable.' },
        commandArgs: { type: 'array', items: { type: 'string' }, description: 'custom: its arguments ({port} = the port it should listen on for transport tcp).' },
        transport: { type: 'string', enum: ['stdio', 'tcp'], description: 'custom: how the DAP server talks (default stdio).' },
        config: { type: 'object', description: 'Extra adapter-specific launch.json fields, merged last (e.g. jvm vmArgs, gdb setupCommands).' },
        mobile: { type: 'string', enum: ['android', 'ios-sim'], description: 'android: a debuggable Java/Kotlin app on a phone/emulator over adb (adapter jvm; request launch starts it waiting for the debugger, attach joins it running). ios-sim: an app in the iOS Simulator on a Mac (adapter lldb-dap or codelldb). Install the debug build first (remote_exec: gradlew installDebug / xcodebuild + simctl install).' },
        appId: { type: 'string', description: 'mobile: Android package (com.example.app) or iOS bundle id.' },
        activity: { type: 'string', description: 'mobile android: activity to start (default: the launcher activity).' },
        server: { type: 'array', items: { type: 'string' }, description: 'gdb: a GDB server to start first, {port} = its port — ["gdbserver","127.0.0.1:{port}","./app"], ["openocd","-f","board/st_nucleo_f4.cfg","-c","gdb_port {port}"], ["pyocd","gdbserver","--port","{port}"], ["JLinkGDBServer","-device","nRF52840_xxAA","-port","{port}"], ["qemu-system-arm", …, "-gdb","tcp::{port}","-S"]. With debugger gdb-multiarch/arm-none-eabi-gdb and program = the ELF.' },
        arch: { type: 'string', enum: ['x86', 'x64'], description: 'clrdbg attach: x86 for a 32-bit .NET Framework process.' },
        module: { type: 'string', description: 'debugpy: run a module instead of a file (python -m <module>), e.g. "pytest".' },
        runtimeExecutable: { type: 'string', enum: ['node', 'npm', 'npx', 'yarn', 'pnpm', 'tsx', 'ts-node'], description: 'js-debug: what starts the program (default node).' },
        runtimeArgs: { type: 'array', items: { type: 'string' }, description: 'js-debug: arguments for runtimeExecutable, e.g. ["test"] or ["run", "dev"].' },
        args: { type: 'array', items: { type: 'string' }, description: 'Program arguments.' },
        cwd: { type: 'string', description: 'Working folder on the target (default: the first allowed folder).' },
        env: { type: 'object', description: 'Extra environment variables {NAME: value}.' },
        breakpoints: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } }, required: ['file', 'line'] }, description: 'Where to stop: file (relative to cwd or absolute) and 1-based line; optional condition expression.' },
        stopOnEntry: { type: 'boolean', description: 'Pause at the first line.' },
        waitSec: { type: 'number', description: 'How long to wait for the first pause/end (0-120, default 60).' },
      },
      required: ['adapter'],
    },
  },
  {
    name: 'remote_agent',
    description: [
      'Delegate a task to an AI coding agent CLI installed on one of the user\'s machines (Claude Code, Codex CLI or Gemini CLI, under the user\'s own login there).',
      'Use it when the work needs what only that machine has and your own remote tools are not enough: its IDE toolchain (Xcode, Visual Studio + .NET Framework, Android Studio), device/simulator/emulator/board debugging, GUI-only debuggers, a VPN or local services — or when a long local investigation (build → run → debug → fix → re-run) is faster done there.',
      'mode "full" (default) lets it run commands and edit files in cwd (always asks the user first); "readonly" only reads and analyses. The task should say what to find/fix, where, and how to verify.',
      'Waits up to waitSec (default 900) and returns its report (result), the steps it took, and sessionId — pass resume: sessionId to continue the same conversation. Still running → remote_agent_result{remoteRunId}.',
      'Check its claims (e.g. re-run the test with remote_exec). Sync your edits with remote_sync first if it should see them, and pull its edits back with remote_pull (or remote_exec git diff).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        task: { type: 'string', description: 'What the local agent should do, with context (files, symptoms, how to verify).' },
        agent: { type: 'string', enum: ['auto', 'claude', 'codex', 'gemini'], description: 'Which CLI (default auto: the first installed of claude, codex, gemini).' },
        mode: { type: 'string', enum: ['full', 'readonly'], description: 'full (run/edit, asks the user) or readonly (analysis only).' },
        cwd: { type: 'string', description: 'Project folder on the target (inside its allowed folders).' },
        resume: { type: 'string', description: 'sessionId from an earlier remote_agent result to continue that session.' },
        model: { type: 'string', description: 'Optional model name for that CLI.' },
        waitSec: { type: 'number', description: 'How long to wait for the report (5-1800, default 900).' },
        background: { type: 'boolean', description: 'Start and return at once (then remote_agent_result).' },
      },
      required: ['task'],
    },
  },
  {
    name: 'remote_agent_result',
    description: 'Wait for (or re-read) a remote_agent run: its report, steps and sessionId once it finished.',
    inputSchema: {
      type: 'object',
      properties: {
        remoteRunId: { type: 'number' },
        agent: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
        waitSec: { type: 'number', description: '0-1800, default 600.' },
      },
      required: ['remoteRunId'],
    },
  },
  {
    name: 'remote_console_start',
    description: [
      'Run a command-line debugger or REPL on one of the user\'s machines in a terminal and drive it line by line — the universal fallback when remote_debug_start has no adapter for the program, or when the debugger\'s own commands are needed.',
      'Examples: "gdb -q ./app", "gdb-multiarch -q fw.elf" (then target remote :3333), "lldb ./app", "lldb -p 1234", "cdb -o App.exe" / "cdb -p 1234" (Windows, .NET Framework with .loadby sos clr),',
      '"jdb -classpath out com.acme.App" or "jdb -attach 5005", "python3 -m pdb app.py", "dlv debug", "node inspect app.js", "adb shell", "adb logcat", "openocd -f board.cfg" + "telnet localhost 4444", "xcrun simctl spawn booted log stream".',
      'Returns the output up to the first prompt; then send commands with remote_console_send (each returns when the debugger shows its prompt again or goes quiet).',
      'Commands that shell out from inside the debugger (shell …, !…, system()) are refused unless read-only — run those with remote_exec. Like remote_exec, starting may wait for the user\'s approval. Always end with remote_console_stop.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name or id (optional when routed or only one is online).' },
        command: { type: 'string', description: 'The debugger/REPL command line, e.g. "gdb -q ./build/app".' },
        cwd: { type: 'string', description: 'Working folder on the target (inside its allowed folders).' },
        env: { type: 'object', description: 'Extra environment variables {NAME: value}.' },
        prompt: { type: 'string', description: 'Regex of this tool\'s prompt when it is unusual (common ones — (gdb) (lldb) (Pdb) (dlv) 0:000> main[1] > >>> $ # — are known).' },
        waitSec: { type: 'number', description: 'How long to wait for the first prompt (0-120, default 30).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'remote_console_send',
    description: 'Type into a console from remote_console_start and get its answer: input = one command (several lines = several commands), or interrupt=true for Ctrl-C (stop a running program inside the debugger). Returns output since the command, whether it waits for input again, and a hint.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id from remote_console_start.' },
        input: { type: 'string', description: 'The command, e.g. "break app.c:42", "run", "bt", "print x", "info locals".' },
        interrupt: { type: 'boolean', description: 'Send Ctrl-C instead of input.' },
        waitSec: { type: 'number', description: 'Longest wait for the answer (0-120, default 30).' },
        quietMs: { type: 'number', description: 'Treat this much silence as the end of the answer when no prompt shows (300-30000, default 2500).' },
      },
      required: ['session'],
    },
  },
  {
    name: 'remote_console_read',
    description: 'Output a console printed since the last call (e.g. a program running inside the debugger until it hits a breakpoint). Waits up to waitSec for something new.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, waitSec: { type: 'number', description: '0-120, default 10.' } },
      required: ['session'],
    },
  },
  {
    name: 'remote_console_stop',
    description: 'End a console (the debugger/REPL and the program under it).',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
  },
  {
    name: 'remote_debug_step',
    description: 'Move a paused debug session on: continue (to the next breakpoint or the end), next (step over), stepIn, stepOut, or pause a running one. Waits for the next pause/end (waitSec, default 30) and returns where it is, the stack, locals and new output.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id from remote_debug_start.' },
        action: { type: 'string', enum: ['continue', 'next', 'stepIn', 'stepOut', 'pause'] },
        waitSec: { type: 'number', description: '0-120, default 30.' },
      },
      required: ['session', 'action'],
    },
  },
  {
    name: 'remote_debug_eval',
    description: 'While paused: evaluate an expression in the program\'s language in the current frame (or frameId from the stack), or expand a variable/object (ref from locals or an earlier result).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        expression: { type: 'string', description: 'e.g. "user.items.length", "len(rows)", "buf[0]".' },
        ref: { type: 'number', description: 'variablesReference to expand instead of evaluating.' },
        frameId: { type: 'number', description: 'Frame id from the stack (default: the top frame of your code).' },
      },
      required: ['session'],
    },
  },
  {
    name: 'remote_debug_breakpoints',
    description: 'Replace the breakpoints of one file in a running debug session (an empty list removes them). Lines are 1-based; each may carry a condition. Returns whether each was verified (bound to code).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        file: { type: 'string', description: 'File on the target (relative to the session cwd or absolute).' },
        lines: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'object', properties: { line: { type: 'number' }, condition: { type: 'string' } }, required: ['line'] }] } },
      },
      required: ['session', 'file', 'lines'],
    },
  },
  {
    name: 'remote_debug_stop',
    description: 'End a debug session (stops the program and the debugger on the user\'s machine). Returns the final output.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
  },
  {
    name: 'remote_stop',
    description: 'Stop a running remote command: signal INT (Ctrl+C, default), TERM or KILL.',
    inputSchema: {
      type: 'object',
      properties: { remoteRunId: { type: 'number' }, signal: { type: 'string', enum: ['INT', 'TERM', 'KILL'] } },
      required: ['remoteRunId'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'aidev_decide':
      return jsonResponse(await callApi(name, args));
    case 'remote_targets':
      return jsonResponse(await callApi(name, {}));
    case 'remote_exec':
    case 'nadovibe_show':
    case 'nadovibe_settings':
    case 'remote_sync':
    case 'remote_pull':
    case 'remote_logs':
    case 'remote_stop':
    case 'remote_preview':
    case 'remote_windows':
    case 'remote_devices':
    case 'remote_input':
    case 'remote_debug_start':
    case 'remote_debug_step':
    case 'remote_debug_eval':
    case 'remote_debug_breakpoints':
    case 'remote_debug_stop':
    case 'remote_console_start':
    case 'remote_console_send':
    case 'remote_console_read':
    case 'remote_console_stop':
    case 'remote_agent':
    case 'remote_agent_result':
      return jsonResponse(await callApi(name, args));
    case 'remote_screenshot':
    case 'remote_device_shot':
      return imageResponse(await callApi(name, args));
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
