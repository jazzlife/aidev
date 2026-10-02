// App control (2026-10-02): an agent's show/set commands reach the user's open pages; a page that just opened does
// not replay older ones; viewers says whether anyone was watching; bad commands are refused.
//   node test/ui-control-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
const { createUiControl, parseUiCommand } = await import('../dist/ui-control.js');

const ui = createUiControl();
assert.equal(ui.push(1, { ...parseUiCommand({ action: 'show', view: 'pcs' }), by: 'agent' }).viewers, 0, 'nobody watching yet');
// a page that opens now does not get the command sent before it existed
let r = await ui.poll(1, 'phone', 0, 0);
assert.deepEqual(r.commands, []);
const after = r.last;
// a waiting page wakes up when the agent shows something
const waiting = ui.poll(1, 'phone', after, 5000);
await new Promise((res) => setTimeout(res, 50));
const pushed = ui.push(1, { ...parseUiCommand({ action: 'show', view: 'screen', params: { target: 4, window: 'full' }, note: '창을 확인해 주세요' }), by: 'agent' });
assert.equal(pushed.viewers, 1, 'the phone is watching');
r = await waiting;
assert.equal(r.commands.length, 1);
assert.deepEqual(r.commands[0].params, { target: 4, window: 'full' });
assert.equal(r.commands[0].note, '창을 확인해 주세요');
// another user's page sees nothing
assert.deepEqual((await ui.poll(2, 'pc', 0, 0)).commands, []);
// settings applied by pages, and validation
assert.equal(parseUiCommand({ action: 'set', params: { key: 'routing_mode', value: 'manual' } }).params.value, 'manual');
assert.throws(() => parseUiCommand({ action: 'show', view: 'terminal' }), /view/);
assert.throws(() => parseUiCommand({ action: 'set', params: { key: 'anything' } }), /set key/);
assert.throws(() => parseUiCommand({ action: 'run' }), /action/);
console.log('ui control: all checks passed');
