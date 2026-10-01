import { describe, expect, it } from 'vitest';

import { parseAgentDraft } from '@/modules/aidev-router/api';

const block = (json: string) => `새 agent를 설계합니다.\n\n<aidev-agent>\n${json}\n</aidev-agent>`;
const draft = { name: 'Unity Graphics', domain: 'gamedev', hint: 'unity urp hlsl shaders', description: 'Unity shaders', prompt: '당신은 Unity 셰이더 전문가다.\n규칙: {중괄호}와 "따옴표"를 그대로 둔다.', tools: ['Read'], self_check: { task: '굴절 셰이더 작성', expected: 'SampleSceneColor 사용' } };

describe('parseAgentDraft (D-06)', () => {
  it('reads a well-formed block (also inside a json fence)', () => {
    expect(parseAgentDraft(block(JSON.stringify(draft)))?.name).toBe('unity-graphics');
    expect(parseAgentDraft(block('```json\n' + JSON.stringify(draft) + '\n```'))?.self_check?.task).toBe('굴절 셰이더 작성');
  });

  it('repairs the closing brackets an LLM left off (server: the final } was missing)', () => {
    const json = JSON.stringify(draft);
    const parsed = parseAgentDraft(block(json.slice(0, -1)));
    expect(parsed?.name).toBe('unity-graphics');
    expect(parsed?.prompt).toContain('{중괄호}');
    expect(parsed?.self_check?.expected).toBe('SampleSceneColor 사용');
    expect(parseAgentDraft(block(json.slice(0, -2)))?.self_check?.expected).toBe('SampleSceneColor 사용');
  });

  it('gives up when the text stops inside a string or has no block', () => {
    expect(parseAgentDraft(block('{"name":"x","prompt":"unterminated'))).toBeNull();
    expect(parseAgentDraft('no block here')).toBeNull();
  });
});
