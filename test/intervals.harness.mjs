// Heartbeat and reminder intervals, against the built server through the same
// HostSession as reminders.harness.mjs: a heartbeat interval longer than
// setTimeout can hold waits for it, a stored heartbeat interval the tool
// couldn't have saved falls back to the default, and a stored reminder
// interval under the 5-second floor gets the floor. Before, each fired about
// every millisecond.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server on its own files, with a stored config and reminders if given,
 *  past the initial policy, counting the heartbeats and reminders it pushes. */
async function start(t, { config: storedConfig, reminders: storedReminders } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-intervals-'));
  const config = join(dir, 'config.json');
  const reminders = join(dir, 'reminders.json');
  if (storedConfig) writeFileSync(config, JSON.stringify(storedConfig));
  if (storedReminders) writeFileSync(reminders, JSON.stringify(storedReminders));
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: config, HEARTBEAT_REMINDERS_FILE: reminders },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const heartbeats = [];
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind !== 'push') return;
    if (ev.data?.origin?.source === 'heartbeat') heartbeats.push(ev.data);
    if (ev.data?.origin?.source === 'reminder') fired.push(ev.data);
  });
  await session.start();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  const status = async () => (await session.callTool('heartbeat_status', {})).content[0].text;
  return { session, heartbeats, fired, status };
}

test('a 720-hour interval waits for its time, and the status counts down to it', async (t) => {
  const { session, heartbeats, status } = await start(t);
  await session.callTool('heartbeat_configure', { intervalHours: 720 });
  await sleep(2000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the two seconds after setting it');
  const next = Number(/next in ~(\d+)s/.exec(await status())?.[1]);
  assert.ok(next > 2_591_000 && next <= 2_592_000, `next in ~${next}s, of 2592000`);
});

test('a stored interval heartbeat_configure could not have saved falls back to the default', async (t) => {
  // heartbeat_configure saves an infinite interval as null, which read as 0.
  const { heartbeats, status } = await start(t, { config: { intervalSeconds: null } });
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting');
  assert.match(await status(), /interval=14400s/);
});

test('a stored reminder interval under the 5-second floor gets the floor', async (t) => {
  // reminder_add floors an interval at 5 s; only a hand edit stores 0. It falls
  // due 2 s on, once the host's policy is in, since a push before it is dropped.
  const now = Date.now();
  const { session, fired } = await start(t, {
    reminders: [{ id: 'rem_zero', message: 'ZERO', createdAt: now, fireAt: now + 2000, everySeconds: 0 }],
  });
  await sleep(now + 3500 - Date.now());
  assert.equal(fired.length, 1, 'fired once when due, with its next fire 5 s on');
  const list = (await session.callTool('reminder_list', {})).content[0].text;
  assert.match(list, /^rem_zero \| .*repeats every 5s/m);
});
