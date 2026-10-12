// The lexical prior does not let an agent with few examples win on a few shared words (2026-10-13): a generated agent
// with a handful of long examples took ComfyUI setup commands at 1.00 while the specialists had dozens of examples.
import assert from 'node:assert/strict';

const { NaiveBayesRouter, SPARSE_AGENT_DOCS } = await import('../dist/classifier.js');
const seed = (agent, texts) => texts.map((text) => ({ agent, text }));
const many = (agent, base) => Array.from({ length: SPARSE_AGENT_DOCS + 5 }, (_, i) => ({ agent, text: `${base[i % base.length]} ${i}` }));
const examples = [
  ...many('devops', ['도커 컴포즈로 서버 배포 설정', 'nginx 리버스 프록시 설정', '리눅스 서버에 서비스 설치하고 자동 시작', 'systemd 유닛 작성']),
  ...many('frontend-react', ['React 컴포넌트 상태 관리', '버튼 스타일과 레이아웃 수정', 'vite 빌드 설정', '훅으로 데이터 불러오기']),
  // a generated agent: few, long examples that happen to share "3d", "설정", "렌더링"
  ...seed('remote-display-sync', ['3d 객체 회전 각도와 렌더링 설정을 캔버스 에디터에서 조정', '대시보드 캔버스 3d 티커 렌더링 설정 동기화', '층별 화면 3d 객체 배치 설정']),
];
const nb = new NaiveBayesRouter();
nb.train(examples);
const p = nb.predict('용량을 충분히 확보했는데 comfyui 등 3d 관련 렌더링 설정을 최적으로 한게 맞나?');
assert.ok(p['remote-display-sync'] < 0.9, `a sparse agent is not certain on shared words: ${JSON.stringify(p)}`);
// the same agent with enough examples is scored as before (no shrink)
const grown = new NaiveBayesRouter();
grown.train([...examples, ...many('remote-display-sync', ['3d 객체 회전 각도와 렌더링 설정을 캔버스 에디터에서 조정', '대시보드 캔버스 3d 티커 렌더링 설정 동기화'])]);
assert.ok(grown.predict('대시보드 캔버스 3d 티커 렌더링 설정 동기화 해줘')['remote-display-sync'] > 0.9);
// the specialists keep their commands
assert.equal(Object.entries(nb.predict('nginx 리버스 프록시에 TLS 설정 추가')).sort((a, b) => b[1] - a[1])[0][0], 'devops');
console.log('classifier sparse: all checks passed');
