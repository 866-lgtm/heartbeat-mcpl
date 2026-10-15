// A reminder fires only when its wake can be delivered, against the built
// server through the same HostSession as reminders.harness.mjs. Until the host
// sends a valid policy that allows wakes, an overdue reminder waits: with no
// policy, after a Notification-form update or a malformed Request, and under a
// valid policy that denies wakes. Then each fires once, and one that fires late
// says when it was due. Before, the base took each overdue reminder at
// initialize, pushed nothing, logged it DROPPED, and removed a one-shot or
// skipped a recurring one's time.
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
const POLICY = {
  effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
  enabled: ['heartbeat'], disabled: [],
};

test('an overdue reminder waits until its wake can be delivered, then fires once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-restart-'));
  const reminders = join(dir, 'reminders.json');
  const now = Date.now();
  const row = (id, fireAt, everySeconds) => ({ id, message: id.toUpperCase(), createdAt: now - 600_000, fireAt, everySeconds });
  writeFileSync(reminders, JSON.stringify([
    row('rem_once', now - 120_000, null),
    row('rem_hourly', now - 120_000, 3600),
    row('rem_doomed', now + 3_600_000, null),
  ]));
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
  const pushes = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') pushes.push(ev.data);
  });
  const fired = () => pushes.map((p) => p.origin.reminderId).sort();
  const stored = () => JSON.parse(readFileSync(reminders, 'utf8'));
  await session.start();

  // Every way a wake can't be delivered yet: no policy, a Notification-form
  // update, a malformed Request, and a valid policy that denies wakes. The
  // agent adds a reminder due in 1 s and cancels another meanwhile.
  session.notify('featureSets/update', POLICY);
  await assert.rejects(session.raw('featureSets/update', { ...POLICY, enabled: 'heartbeat' }));
  const added = await session.callTool('reminder_add', { message: 'NEW', inSeconds: 1 });
  const addedId = /Reminder (rem_\S+) set/.exec(added.content[0].text)?.[1];
  assert.ok(addedId, added.content[0].text);
  await session.callTool('reminder_cancel', { id: 'rem_doomed' });
  await session.raw('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  await sleep(2000);
  assert.deepEqual(fired(), [], 'nothing fires while no wake can be delivered');
  const waiting = stored();
  assert.deepEqual(waiting.map((r) => r.id).sort(), [addedId, 'rem_hourly', 'rem_once'].sort(), 'nothing is dropped meanwhile');
  assert.ok(waiting.filter((r) => r.id !== addedId).every((r) => r.fireAt === now - 120_000), 'nor advanced');
  const list = (await session.callTool('reminder_list', {})).content[0].text;
  assert.match(list, /^rem_once \| next .* \(overdue\) \| one-shot \| "REM_ONCE"$/m, 'reminder_list shows the one-shot overdue');
  assert.match(list, /\nNo wake can be delivered now \(capability not granted: pushEvents .*\), so a reminder that falls due waits, and fires once one can\.$/,
    'and says why it waits');

  // The host allows wakes: each waiting reminder fires once.
  await session.raw('featureSets/update', POLICY);
  for (const deadline = Date.now() + 10_000; pushes.length < 3 && Date.now() < deadline;) await sleep(50);
  await sleep(500);
  assert.deepEqual(fired(), [addedId, 'rem_hourly', 'rem_once'].sort(), 'each fires once the policy allows wakes');
  const text = (id) => pushes.find((p) => p.origin.reminderId === id).payload.content[0].text;
  assert.match(text('rem_once'), /^\[reminder rem_once, set [^\]]+\], due /, 'one two minutes late says when it was due');
  assert.doesNotMatch(text(addedId), /, due /, 'one less than a minute late does not');
  const after = stored();
  assert.deepEqual(after.map((r) => r.id), ['rem_hourly']);
  assert.equal(after[0].fireAt, now - 120_000 + 3_600_000, 'the hourly one is next due an hour after the time it missed');
});

test('a policy change that stops wakes holds a reminder already armed, until wakes are allowed again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-restart-'));
  const reminders = join(dir, 'reminders.json');
  // One reminder for each way a host can stop wakes, due 3 s apart, so each is
  // armed while wakes are allowed and falls due after its stop.
  const now = Date.now();
  const stops = [
    ['rem_malformed', 'a malformed Request', () => assert.rejects(session.raw('featureSets/update', { ...POLICY, enabled: 'heartbeat' }))],
    ['rem_narrowed', 'a Notification that narrows the grant', () => session.notify('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
    ['rem_denied', 'a Request that denies wakes', () => session.raw('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
  ].map(([id, name, stop], i) => ({ id, name, stop, dueAt: now + 4000 + 3000 * i }));
  writeFileSync(reminders, JSON.stringify(stops.map(({ id, dueAt }) => (
    { id, message: id, createdAt: now, fireAt: dueAt, everySeconds: null }))));
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
  await session.raw('featureSets/update', POLICY);
  for (const { id, name, stop, dueAt } of stops) {
    assert.ok(Date.now() < dueAt - 500, `${id} is still ahead when wakes stop`);
    await stop();
    await sleep(dueAt + 500 - Date.now());
    assert.deepEqual(fired.filter((f) => f === id), [], `nothing fires after ${name}`);
    assert.ok(JSON.parse(readFileSync(reminders, 'utf8')).some((r) => r.id === id), `nor is it dropped after ${name}`);
    await session.raw('featureSets/update', POLICY);
    for (const deadline = Date.now() + 10_000; !fired.includes(id) && Date.now() < deadline;) await sleep(50);
    await sleep(200);
    assert.deepEqual(fired.filter((f) => f === id), [id], `it fires once wakes are allowed again, after ${name}`);
  }
});
