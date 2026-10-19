import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatContext, buildJudgePrompt, firstCompleteJson, parseJudge, stackFromManifests } from '@/modules/aidev-tools/specialist-judge.service.js';

/** The judge's answer → a verdict the gateway can trust (unknown names count as "none fits"). */
const names = new Set(['frontend-react', 'database']);

test('existing specialist, generalist, and a proposal', () => {
  assert.deepEqual(parseJudge('{"agent":"database","fit":0.9,"reason":"SQL","new":null}', names), { agent: 'database', fit: 0.9, reason: 'SQL', new: null, question: null, current_fit: null, level: null, continues: null });
  assert.equal(parseJudge('```json\n{"agent":"generalist","fit":0.7,"reason":"trivial","new":null}\n```', names)?.agent, 'generalist');
  const created = parseJudge('Sure: {"agent":null,"fit":0,"reason":"no iOS agent","new":{"name":"iOS Swift!","domain":"ios","description":"SwiftUI apps","technologies":["Swift","SwiftUI"]}}', names);
  assert.equal(created?.agent, null);
  assert.equal(created?.new?.name, 'ios-swift');
});

test('a low-fit closest agent keeps the proposal next to it; the gateway decides by the fit', () => {
  const low = parseJudge('{"agent":"frontend-react","fit":0.15,"reason":"React is not SwiftUI","new":{"name":"ios-swift","domain":"ios","description":"SwiftUI apps","technologies":["Swift"]}}', names);
  assert.deepEqual([low?.agent, low?.fit, low?.new?.name], ['frontend-react', 0.15, 'ios-swift']);
  assert.equal(parseJudge('{"agent":"generalist","fit":0.8,"reason":"x","new":{"name":"y","domain":"z"}}', names)?.new, null, 'the generalist never carries a proposal');
});

test('an invented agent name is treated as "no specialist"; garbage is rejected', () => {
  assert.equal(parseJudge('{"agent":"unity-expert","fit":0.9,"reason":"x","new":null}', names)?.agent, null);
  assert.equal(parseJudge('no json here', names), null);
  // the clarifying question is kept (trimmed, capped) and an empty one means none
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"question":"  어느 테이블인가요? "}', names)?.question, '어느 테이블인가요?');
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"question":""}', names)?.question, null);
  assert.equal(parseJudge('{"agent":"database","fit":7}', names)?.fit, 1);
});

test('the streamed verdict is complete at the first balanced object (the judge stops reading there)', () => {
  assert.equal(firstCompleteJson('```json\n{"agent":"database","fit":0.9'), null);
  assert.deepEqual(firstCompleteJson('```json\n{"agent":"database","fit":0.9,"reason":"a } in \\"text\\"","new":null}\n``` The command asks'), { agent: 'database', fit: 0.9, reason: 'a } in "text"', new: null });
  assert.equal(firstCompleteJson('{"agent":null,"new":{"name":"x","technologies":["a"]}} and {"more":1}')?.agent, null);
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null}\nNote: {see above}', names)?.agent, 'database');
});

test('parseJudge reads the chat agent\'s current_fit only when a chat agent was given', () => {
  const names = new Set(['frontend-react', 'git-workflow']);
  const answer = '{"agent":"frontend-react","fit":0.7,"reason":"UI","new":null,"question":null,"current_fit":0.2}';
  assert.equal(parseJudge(answer, names, 'git-workflow')?.current_fit, 0.2);
  // no chat agent: not asked, so not trusted
  assert.equal(parseJudge(answer, names)?.current_fit, null);
  // the closest agent is the chat's own: its fit is the chat agent's fit
  assert.equal(parseJudge('{"agent":"git-workflow","fit":0.9,"reason":"git","new":null,"question":null,"current_fit":0.4}', names, 'git-workflow')?.current_fit, 0.9);
  // missing or out of range
  assert.equal(parseJudge('{"agent":"frontend-react","fit":0.7,"reason":"UI","new":null,"question":null}', names, 'git-workflow')?.current_fit, null);
  assert.equal(parseJudge('{"agent":"frontend-react","fit":0.7,"reason":"UI","new":null,"question":null,"current_fit":3}', names, 'git-workflow')?.current_fit, 1);
});

test('parseJudge reads the comfortable model tier (level) as a whole 0..4, or null when absent', () => {
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"level":4}', names)?.level, 4);
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"level":2.6}', names)?.level, 3);
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"level":9}', names)?.level, 4);
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"level":"high"}', names)?.level, null);
});

const msg = (role: 'user' | 'assistant', content: string, at: string) => ({ id: at, sessionId: 's', timestamp: at, provider: 'claude', kind: 'text', role, content }) as never;

test('buildChatContext reads the goal, the latest requests and the last answer, as of the command', () => {
  const messages = [
    msg('user', '같은 ap로 연결된 m4pro와 도대체 왜 네트워크 정보가 다른거야', '2026-10-19T00:33:00Z'),
    msg('assistant', 'ally는 무선 브릿지 뒤에 있어 DHCP를 다른 대역에서 받습니다.', '2026-10-19T00:34:00Z'),
    msg('user', '뭘 의심해 같은 wifi에 똑같이 접속한거라니까', '2026-10-19T00:37:00Z'),
    msg('assistant', '그렇다면 AP가 브릿지 모드인지 확인해야 합니다.', '2026-10-19T00:38:00Z'),
    msg('user', '같은 ap에 wifi로 연결되어있다는 것이 사실인데 그 전체를 바꿔서 문제를 흐리지 마', '2026-10-19T00:39:40Z'),
  ];
  const at = Date.parse('2026-10-19T00:39:30Z');
  assert.deepEqual(buildChatContext(messages, '같은 ap에 wifi로 연결되어있다는 것이 사실인데 그 전체를 바꿔서 문제를 흐리지 마', at), {
    goal: '같은 ap로 연결된 m4pro와 도대체 왜 네트워크 정보가 다른거야', recent: ['뭘 의심해 같은 wifi에 똑같이 접속한거라니까'], lastReply: '그렇다면 AP가 브릿지 모드인지 확인해야 합니다.',
  });
  // the command already in the transcript is not one of the requests before it
  assert.deepEqual(buildChatContext(messages, '같은 ap에 wifi로 연결되어있다는 것이 사실인데 그 전체를 바꿔서 문제를 흐리지 마')?.recent, ['뭘 의심해 같은 wifi에 똑같이 접속한거라니까']);
  assert.equal(buildChatContext([], 'x'), null);
});

test('stackFromManifests names the technology per folder', () => {
  const stack = stackFromManifests([
    { path: 'dashboard/package.json', content: JSON.stringify({ dependencies: { react: '19', ws: '8' }, devDependencies: { vite: '8', '@types/ws': '8' } }) },
    { path: 'player/Player.csproj', content: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWPF>true</UseWPF></PropertyGroup><ItemGroup><PackageReference Include="LibVLCSharp" Version="3" /></ItemGroup></Project>' },
    { path: 'remote/pubspec.yaml', content: 'name: remote\nenvironment:\n  sdk: ">=3.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  signalr_netcore: ^1.3.0\n' },
    { path: 'remote/android/app/build.gradle', content: "apply plugin: 'com.android.application'" },
  ]);
  assert.equal(stack, 'dashboard: Node/JS (react, ws, vite); player: .NET net10.0-windows WPF (LibVLCSharp); remote: Flutter/Dart (signalr_netcore); remote/android/app: Android (Gradle)');
  assert.equal(stackFromManifests([]), null);
});

test('buildJudgePrompt shows the chat and the stack, and drops the keyword lists agents carry', () => {
  const prompt = buildJudgePrompt({ command: '진행해', ask: false, current: null, candidates: [{ name: 'remote-display-sync', description: '사이니지 콘텐츠를 원격 PC에 실시간 반영. 키워드: player, device, reconnect, heartbeat' }] },
    { goal: '네트워크 정보가 다른 이유', recent: [], lastReply: 'DHCP 대역이 다릅니다', stack: 'Node/JS (ws)' });
  assert.ok(prompt.includes('- remote-display-sync: 사이니지 콘텐츠를 원격 PC에 실시간 반영.\n'));
  assert.ok(!prompt.includes('heartbeat'));
  assert.ok(prompt.includes("Goal (the chat's first request): 네트워크 정보가 다른 이유"));
  assert.ok(prompt.includes('Agent doing the work in this chat: the generalist (no specialist)'));
  assert.ok(prompt.includes('Project technology (detected from its files): Node/JS (ws)'));
  // a new chat shows no chat block
  assert.ok(!buildJudgePrompt({ command: 'React 다크모드', candidates: [] }, null).includes('<chat>'));
});

test('parseJudge reads whether the command continues the chat', () => {
  const names = new Set(['devops']);
  assert.equal(parseJudge('{"continues":true,"agent":"generalist","fit":0.9,"reason":"x","new":null}', names)?.continues, true);
  assert.equal(parseJudge('{"agent":"devops","fit":0.9,"reason":"x","new":null}', names)?.continues, null);
});
