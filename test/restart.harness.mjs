// Reminders that fell due while the server was down, against the built server
// through the same HostSession as reminders.harness.mjs. They wait for the
// host's first policy and then fire once. Before, they fired at initialize,
// before any push could go out, and were lost: a one-shot gone, a recurring
// one skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an overdue reminder waits for the host\'s first policy, then fires once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-restart-'));
  const reminders = join(dir, 'reminders.json');
  const now = Date.now();
  const stored = JSON.stringify([
    { id: 'rem_once', message: 'ONCE', createdAt: now - 60_000, fireAt: now - 10_000, everySeconds: null },
    { id: 'rem_hourly', message: 'HOURLY', createdAt: now - 60_000, fireAt: now - 10_000, everySeconds: 3600 },
  ]);
  writeFileSync(reminders, stored);
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: reminders },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  await session.start();

  await sleep(2000);
  assert.deepEqual(fired, [], 'nothing fires before the policy');
  assert.equal(readFileSync(reminders, 'utf8'), stored, 'nothing is dropped or advanced before the policy');

  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  await sleep(1000);
  assert.deepEqual(fired.sort(), ['rem_hourly', 'rem_once'], 'each overdue reminder fires once after the policy');
  const after = JSON.parse(readFileSync(reminders, 'utf8'));
  assert.deepEqual(after.map((r) => r.id), ['rem_hourly']);
  assert.equal(after[0].fireAt, now - 10_000 + 3_600_000, 'the hourly one keeps its cadence, an hour after the time it missed');
});
