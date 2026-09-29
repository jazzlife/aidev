// Preloaded by `npm test` (see package.json) into every test process.
//
// Node's test runner (22.x) reads each test file's stdout as a stream of serialized reports and passes
// any text in between through as test:stdout. It reads a report's size as a *signed* 32-bit value: when
// console text follows a report in the same pipe read and that text's 3rd byte is ≥ 0x80 (an emoji or
// Korean at the start of a log line, e.g. "🔄 Cloning repository…" from agent.routes), the size comes out
// negative, the text is decoded as a report and the whole file fails with "Unable to deserialize cloned
// data due to invalid or unsupported version" — intermittently, depending on how the pipe splits reads.
// Test processes therefore print console output on stderr, which the runner does not parse.
import { Console } from 'node:console';

if (process.env.NODE_TEST_CONTEXT) {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}
