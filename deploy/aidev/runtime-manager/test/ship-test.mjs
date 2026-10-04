// OPS-02: ship requests that could escape (paths, refs, names) are refused; a ship's log gives its step and result.
//   npm run build && node test/ship-test.mjs
import assert from 'node:assert/strict';

const { checkShipRequest, readShipLog } = await import('../dist/ship.js');
const base = { id: 'abcd1234abcd1234', runtime: 'u70edd047aee13516505c5c78', requester: 'jazzlife' };

assert.deepEqual(checkShipRequest({ ...base, from: '/workspace/aidev/', ref: 'f00d' }), { ...base, from: 'aidev', ref: 'f00d' });
assert.deepEqual(checkShipRequest({ ...base }), { ...base, from: undefined, ref: undefined });
for (const bad of [{ from: '../etc' }, { from: 'a/../../b' }, { from: './a' }, { from: 'a b' }, { ref: '--upload-pack=x' }, { ref: 'a..b' }, { ref: 'a;b' }, { runtime: 'aidev-auth-gateway' }, { id: 'X' }, { requester: 'a b' }]) {
  assert.throws(() => checkShipRequest({ ...base, ...bad }), /^Error: bad /, JSON.stringify(bad));
}
assert.deepEqual(readShipLog('SHIP_STEP fetch\r\n...\r\nSHIP_STEP checks\r\n'), { step: 'checks', result: null });
assert.deepEqual(readShipLog('SHIP_STEP push\nSHIP_RESULT ok 1234 release 1234ab is live\n ✓ every runtime runs 1234ab\n'), { step: 'push', result: { status: 'ok', sha: '1234', text: 'release 1234ab is live' } });
console.log('ship-test: ok');
