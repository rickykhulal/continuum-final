import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/lib/request.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { withRequestTimeout, fetchJsonWithTimeout, RequestTimeoutError } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));

test('deadline aborts a stalled transport even if it ignores the AbortSignal', async () => {
  let signal;
  await assert.rejects(withRequestTimeout(value => { signal = value; return new Promise(() => {}); }, 10), RequestTimeoutError);
  assert.equal(signal.aborted, true);
});

test('successful requests clear the deadline without aborting completed work', async () => {
  let signal;
  assert.equal(await withRequestTimeout(async value => { signal = value; return 42; }, 5), 42);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(signal.aborted, false);
});

test('deadline covers stalled JSON decoding as well as response headers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
  try { await assert.rejects(fetchJsonWithTimeout('/fixture', 10), RequestTimeoutError); }
  finally { globalThis.fetch = original; }
});
