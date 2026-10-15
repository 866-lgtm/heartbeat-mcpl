// A reminder fires only when its wake can be delivered, against the built
// server through the same HostSession as reminders.harness.mjs. Until the host
// sends a valid policy that allows wakes, an overdue reminder waits: with no
// policy, after a Notification-form update or a malformed Request, and under a
// valid policy that denies wakes. Then each fires once, and one that fires late
// says when it was due. On main, the server took each overdue reminder at
// initialize, before any policy, pushed nothing, logged it DROPPED, and
// removed a one-shot or skipped a recurring one's time.
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
// What reminder_list and reminder_add say while no wake can be delivered.
const ASK = " If that doesn't change, ask whoever runs this host.";
const NOT_READY_REASON = "the host hasn't finished setting this server up, or its last settings message was malformed";
const NOT_READY = `No wake can be delivered now, because ${NOT_READY_REASON}. A reminder that falls due waits until one can.${ASK}`;
const NOT_READY_ONE = `No wake can be delivered now, because ${NOT_READY_REASON}, so it waits until one can.${ASK}`;
const DENIED = "No wake can be delivered now, because the host hasn't granted this server what its wakes need. "
  + `A reminder that falls due waits until one can.${ASK}`;
const PRE_05 = "No wake can be delivered on this host, because the host set this server up in an older form that can't turn "
  + "wakes on, so no reminder will fire here. Calling again won't change that; ask whoever runs this host if you need wakes.";

/** A server on a reminders file holding `rows`, with every reminder push it sends, and when it arrived. */
async function start(t, rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-restart-'));
  const reminders = join(dir, 'reminders.json');
  writeFileSync(reminders, JSON.stringify(rows));
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
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') pushes.push({ ...ev.data, at: Date.now() });
  });
  await session.start();
  const list = async () => (await session.callTool('reminder_list', {})).content[0].text;
  // The server saves once the host has taken a push, which the harness does as
  // the push arrives, so ask it first: its answer comes after that save.
  const stored = async () => { await list(); return JSON.parse(readFileSync(reminders, 'utf8')); };
  return { session, pushes, list, stored, reminders };
}

test('an overdue reminder waits until its wake can be delivered, then fires once', async (t) => {
  const now = Date.now();
  const row = (id, fireAt, everySeconds) => ({ id, message: id.toUpperCase(), createdAt: now - 600_000, fireAt, everySeconds });
  const { session, pushes, list, stored } = await start(t, [
    row('rem_once', now - 120_000, null),
    row('rem_hourly', now - 120_000, 3600),
    // Ten of its periods missed: it fires once, not ten times.
    row('rem_minutely', now - 600_000, 60),
    row('rem_doomed', now + 3_600_000, null),
  ]);
  const fired = () => pushes.map((p) => p.origin.reminderId).sort();
  const lastLine = async () => (await list()).split('\n').pop();

  // Every way a wake can't be delivered yet: no policy, a Notification-form
  // update with no Request (a pre-0.5 host, where none will be until a Request
  // comes), a malformed Request, and a valid policy that denies wakes. The
  // agent adds a reminder due in 1 s and cancels another meanwhile.
  assert.equal(await lastLine(), NOT_READY, 'with no policy yet, reminder_list says why reminders wait');
  session.notify('featureSets/update', POLICY);
  assert.equal(await lastLine(), PRE_05, 'after a Notification-form update alone, that none will fire on this host');
  await assert.rejects(session.raw('featureSets/update', { ...POLICY, enabled: 'heartbeat' }));
  assert.equal(await lastLine(), NOT_READY, 'and after a malformed Request, since a host that sends Requests speaks 0.5, that they wait');
  const added = (await session.callTool('reminder_add', { message: 'NEW', inSeconds: 1 })).content[0].text;
  const addedId = /Reminder (rem_\S+) set/.exec(added)?.[1];
  assert.ok(addedId, added);
  assert.ok(added.endsWith(` ${NOT_READY_ONE}`), `reminder_add says it waits: ${added}`);
  await session.callTool('reminder_cancel', { id: 'rem_doomed' });
  await session.raw('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  await sleep(2000);
  assert.deepEqual(fired(), [], 'nothing fires while no wake can be delivered');
  const held = await list();
  assert.match(held, /^rem_once \| next .* \(overdue\) \| one-shot \| "REM_ONCE"$/m, 'reminder_list shows the one-shot overdue');
  assert.equal(held.split('\n').pop(), DENIED, 'and says why it waits');
  const waiting = await stored();
  assert.deepEqual(waiting.map((r) => r.id).sort(), [addedId, 'rem_hourly', 'rem_minutely', 'rem_once'].sort(), 'nothing is dropped meanwhile');
  assert.deepEqual(waiting.filter((r) => r.id !== addedId).map((r) => r.fireAt), [now - 120_000, now - 120_000, now - 600_000], 'nor advanced');

  // The host allows wakes: each waiting reminder fires once.
  const allowedAt = Date.now();
  await session.raw('featureSets/update', POLICY);
  for (const deadline = Date.now() + 10_000; pushes.length < 4 && Date.now() < deadline;) await sleep(50);
  await sleep(500);
  const settledAt = Date.now();
  assert.deepEqual(fired(), [addedId, 'rem_hourly', 'rem_minutely', 'rem_once'].sort(), 'each fires once the policy allows wakes');
  const text = (id) => pushes.find((p) => p.origin.reminderId === id).payload.content[0].text;
  assert.match(text('rem_once'), /^\[reminder rem_once, set [^\]]+\], due /, 'one two minutes late says when it was due');
  assert.doesNotMatch(text(addedId), /, due /, 'one less than a minute late does not');
  assert.doesNotMatch(await list(), /No wake can be delivered/, 'reminder_list says nothing of waiting once wakes are allowed');
  const after = await stored();
  assert.deepEqual(after.map((r) => r.id).sort(), ['rem_hourly', 'rem_minutely']);
  assert.equal(after.find((r) => r.id === 'rem_hourly').fireAt, now - 120_000 + 3_600_000,
    'the hourly one is next due an hour after the time it missed');
  const minutely = after.find((r) => r.id === 'rem_minutely').fireAt;
  assert.ok(minutely >= allowedAt + 60_000 && minutely <= settledAt + 60_000,
    `the one that missed ten periods is next due a period from when it fired, not from the time it missed (${minutely - allowedAt} ms)`);
});

test('a policy change that stops wakes holds a reminder already armed, until wakes are allowed again', async (t) => {
  const { session, pushes, list, reminders } = await start(t);
  await session.raw('featureSets/update', POLICY);
  for (const [name, stop] of [
    ['a malformed Request', () => assert.rejects(session.raw('featureSets/update', { ...POLICY, enabled: 'heartbeat' }))],
    ['a Notification that narrows the grant', () => session.notify('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
    ['a Request that denies wakes', () => session.raw('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
  ]) {
    // Armed while wakes are allowed, due in 3 s; then stopped before it falls due.
    const added = (await session.callTool('reminder_add', { message: name, inSeconds: 3 })).content[0].text;
    const id = /Reminder (rem_\S+) set/.exec(added)?.[1];
    const dueAt = JSON.parse(readFileSync(reminders, 'utf8')).find((r) => r.id === id).fireAt;
    await stop();
    // The server takes messages in order, so once this answers, the stop is
    // handled, a Notification's included.
    await list();
    await sleep(Math.max(0, dueAt + 500 - Date.now()));
    assert.match(await list(), new RegExp(`^${id} \\| next .* \\(overdue\\) \\| one-shot`, 'm'), `held, overdue, after ${name}`);
    const allowedAt = Date.now();
    await session.raw('featureSets/update', POLICY);
    for (const deadline = Date.now() + 10_000; !pushes.some((p) => p.origin.reminderId === id) && Date.now() < deadline;) await sleep(50);
    await sleep(200);
    assert.deepEqual(pushes.filter((p) => p.origin.reminderId === id).map((p) => p.at >= allowedAt), [true],
      `it fires once, and only once wakes are allowed again, after ${name}`);
  }
});
