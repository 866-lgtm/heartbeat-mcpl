// callAt reaches a time past setTimeout's limit in steps. Node's mock timers,
// like its real ones, wait 1 ms when asked to wait longer than MAX_TIMEOUT_MS,
// so a single overlong setTimeout fails the first test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMEOUT_MS, callAt } from '../src/timer.js';

const DAY_MS = 86_400_000;

test('a time past setTimeout\'s limit is reached in steps, neither early nor late', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  callAt(30 * DAY_MS, () => { calls++; });
  t.mock.timers.tick(MAX_TIMEOUT_MS);
  assert.equal(calls, 0, 'not called when the first step ends');
  t.mock.timers.tick(30 * DAY_MS - MAX_TIMEOUT_MS - 1);
  assert.equal(calls, 0, 'not called a millisecond early');
  t.mock.timers.tick(1);
  assert.equal(calls, 1, 'called at its time');
});

test('cancelling after a step has passed cancels the step that is pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const cancel = callAt(30 * DAY_MS, () => { calls++; });
  t.mock.timers.tick(MAX_TIMEOUT_MS + 1);
  cancel();
  t.mock.timers.tick(30 * DAY_MS);
  assert.equal(calls, 0);
});
