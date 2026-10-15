// Heartbeat and reminder intervals, against the built server through the same
// HostSession as reminders.harness.mjs. A heartbeat interval longer than
// setTimeout can hold waits for it. A stored interval that would fire about
// every millisecond is read the way the tools would have taken it: a heartbeat
// interval under 60 s is raised to 60 s, one that isn't a number falls back to
// the default, a reminder interval of 0 or less makes a one-off, and one under
// 5 s is raised to 5 s.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const POLICY = {
  effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
  enabled: ['heartbeat'], disabled: [],
};

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
    if (ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  await session.start();
  await session.raw('featureSets/update', POLICY);
  const status = async () => (await session.callTool('heartbeat_status', {})).content[0].text;
  /** Store a new config and restart on it. */
  const restartWith = async (next) => {
    writeFileSync(config, JSON.stringify(next));
    await session.restart();
    await session.raw('featureSets/update', POLICY);
  };
  return { session, heartbeats, fired, status, restartWith };
}

test('a 720-hour interval waits for its time, and the status counts down to it', async (t) => {
  const { session, heartbeats, status } = await start(t);
  await session.callTool('heartbeat_configure', { intervalHours: 720 });
  await sleep(2000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the two seconds after setting it');
  const next = Number(/next in ~(\d+)s/.exec(await status())?.[1]);
  assert.ok(next > 2_591_000 && next <= 2_592_000, `next in ~${next}s, of 2592000`);
});

test('a stored heartbeat interval is read as heartbeat_configure would have taken it', async (t) => {
  // heartbeat_configure saves an infinite interval as null, which read as 0;
  // a hand edit can store 0, which fired as often as null did.
  const { heartbeats, status, restartWith } = await start(t, { config: { intervalSeconds: null } });
  /** The interval heartbeat_status shows, and that the next heartbeat is armed within it. */
  const armed = async () => {
    const text = await status();
    const interval = Number(/interval=(\d+)s/.exec(text)?.[1]);
    const next = Number(/next in ~(\d+)s/.exec(text)?.[1]);
    assert.ok(next > interval - 10 && next <= interval, `next in ~${next}s of ${interval}s`);
    return interval;
  };
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored null');
  assert.equal(await armed(), 14_400, 'null falls back to the default');
  await restartWith({ intervalSeconds: 0 });
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored 0');
  assert.equal(await armed(), 60, 'a stored 0 is raised to the 60 s floor');
  await restartWith({ intervalSeconds: 90 });
  assert.equal(await armed(), 90, 'a stored 90 is kept');
});

test('a stored reminder interval is read as reminder_add would have taken it', async (t) => {
  // reminder_add raises an interval under 5 s to 5 s and reads 0 or less as
  // none; only a hand edit stores one. rem_zero falls due 2 s after it's
  // stored and is the one that fired every millisecond before.
  const now = Date.now();
  const hourOn = now + 3_600_000;
  const row = (id, fireAt, everySeconds) => ({ id, message: id, createdAt: now, fireAt, everySeconds });
  const { session, fired } = await start(t, {
    reminders: [
      row('rem_zero', now + 2000, 0),
      row('rem_negative', hourOn, -5),
      row('rem_three', hourOn, 3),
      row('rem_once', hourOn, null),
      row('rem_hourly', hourOn, 3600),
    ],
  });
  // Wait until 1.5 s past rem_zero's time. It fires at most once: it is a
  // one-off now, and a push before the host's policy would be dropped.
  await sleep(now + 3500 - Date.now());
  const zeroFires = fired.filter((id) => id === 'rem_zero').length;
  assert.ok(zeroFires <= 1, `rem_zero fired ${zeroFires} times`);
  assert.deepEqual(fired.filter((id) => id !== 'rem_zero'), []);
  // The others fall due an hour on, so each is listed as it was loaded.
  const list = (await session.callTool('reminder_list', {})).content[0].text;
  const line = (id) => list.split('\n').find((l) => l.startsWith(`${id} |`)) ?? '';
  assert.match(line('rem_negative'), /\| one-shot \|/);
  assert.match(line('rem_three'), /\| repeats every 5s \|/);
  assert.match(line('rem_once'), /\| one-shot \|/);
  assert.match(line('rem_hourly'), /\| repeats every 3600s \|/);
});
