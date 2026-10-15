// A reminder changes only when the host answers its push. Taken, a one-shot is
// removed and a recurring one advances; refused, or failed, it stays as it was,
// marked refused with the reason, isn't asked again on every fire, and is tried
// once more at the next policy change, add or cancel. Before, it was removed
// or advanced as soon as its push went out, so a refused push lost it with
// only a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, origin, serverWithHost } from './scripted-host.js';
import type { PushAnswer } from './scripted-host.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (id: string, fireAt: number, everySeconds: number | null) => ({ id, message: id, createdAt: fireAt - 60_000, fireAt, everySeconds });
const refusedLine = "A reminder whose push was refused or failed is tried again when the host's settings change, or when a reminder is added or cancelled.";

test('a one-shot whose push fails is held, listed with the reason, and tried once more when a reminder is added', async (t) => {
  let refuse = true;
  const fireAt = Date.now() - 1000;
  const h = await serverWithHost((p) => (refuse && origin(p).source === 'reminder'
    ? { error: [-32001, 'Feature set not enabled: heartbeat'] } : {}), { reminders: [row('rem_once', fireAt, null)] });
  t.after(h.close);
  await h.pushCount(1);
  // Long enough for a reminder re-armed on every fire to have been tried again many times.
  await sleep(1500);
  assert.equal(h.pushes.length, 1, 'tried once, not again on every fire');
  const list = await h.call('reminder_list');
  assert.match(list, /^rem_once \| next .* \(overdue; the push failed: Feature set not enabled: heartbeat, at [^)]+\) \| one-shot \| "rem_once"$/m);
  assert.ok(list.endsWith(`\n${refusedLine}`), list);
  const [held] = h.stored();
  assert.equal(held!.fireAt, fireAt, 'kept as it was');
  assert.match(String((held!.refused as { reason: string }).reason), /Feature set not enabled/);

  refuse = false;
  await h.call('reminder_add', { message: 'later', inHours: 1 });
  await h.pushCount(2);
  await h.settle();
  assert.equal(origin(h.pushes[1]!).reminderId, 'rem_once', 'tried again once a reminder is added');
  const after = await h.call('reminder_list');
  assert.doesNotMatch(after, /rem_once/, 'and gone once the host took it');
  assert.doesNotMatch(after, /refused/);
});

test('a recurring reminder whose push the host refuses stays at the time refused, and is tried again at the next policy', async (t) => {
  let refuse = true;
  const fireAt = Date.now() - 1000;
  const h = await serverWithHost((p) => (refuse && origin(p).source === 'reminder'
    ? { result: { accepted: false, reason: 'busy' } } : {}), { reminders: [row('rem_hourly', fireAt, 3600)] });
  t.after(h.close);
  await h.pushCount(1);
  await h.settle();
  assert.match(await h.call('reminder_list'), /^rem_hourly \| next .* \(overdue; the host refused it: busy, at [^)]+\) \| repeats every 3600s/m);
  assert.equal(h.stored()[0]!.fireAt, fireAt, 'not advanced past the time refused');

  refuse = false;
  await h.request('featureSets/update', POLICY);
  await h.pushCount(2);
  await h.settle();
  await h.call('reminder_list');
  const [after] = h.stored();
  assert.equal(after!.fireAt, fireAt + 3_600_000, 'delivered, it is next due an hour after the time it was refused');
  assert.equal(after!.refused, undefined);
});

test('until the host answers, a reminder is sent and waiting, unchanged in the file; one cancelled meanwhile stays gone', async (t) => {
  const answer = new Map<string, (a: PushAnswer) => void>();
  const fireAt = Date.now() - 1000;
  // rem_later falls due while the other two are out, and is answered at once.
  const rows = [row('rem_once', fireAt, null), row('rem_hourly', fireAt, 3600), row('rem_later', Date.now() + 1500, null)];
  const h = await serverWithHost((p) => (origin(p).reminderId === 'rem_later' ? {}
    : new Promise<PushAnswer>((resolve) => answer.set(String(origin(p).reminderId), resolve))), { reminders: rows });
  t.after(h.close);
  await h.pushCount(3);
  // Long enough for a reminder re-armed while its push is out to have been pushed many times.
  await sleep(500);
  assert.deepEqual(h.pushes.map((p) => origin(p).reminderId), ['rem_once', 'rem_hourly', 'rem_later'],
    'each is pushed once while its answer is awaited, a later fire included');
  const list = await h.call('reminder_list');
  assert.match(list, /^rem_once \| next .* \(sent, waiting for the host's answer\) \| one-shot/m);
  assert.match(list, /^rem_hourly \| next .* \(sent, waiting for the host's answer\) \| repeats every 3600s/m);
  assert.deepEqual(h.stored(), rows.slice(0, 2), 'the file holds both as they were, so a crash now would fire them again at the next start');

  await h.call('reminder_cancel', { id: 'rem_once' });
  answer.get('rem_once')!({ result: { accepted: false, reason: 'busy' } });
  answer.get('rem_hourly')!({});
  await h.settle();
  assert.doesNotMatch(await h.call('reminder_list'), /rem_once/, "cancelled while its push was out, the host's refusal doesn't bring it back");
  assert.deepEqual(h.stored().map((r) => [r.id, r.fireAt, r.refused]), [['rem_hourly', fireAt + 3_600_000, undefined]],
    'taken, the recurring one advances from its own time');
  assert.equal(h.pushes.length, 3);
});

test('a host that goes away while a push is out loses no reminder, and leaves nothing armed, so the server exits', async (t) => {
  const fireAt = Date.now() - 1000;
  const h = await serverWithHost((p) => (origin(p).reminderId === 'rem_due' ? new Promise<PushAnswer>(() => {}) : {}),
    { reminders: [row('rem_due', fireAt, null), row('rem_soon', Date.now() + 1500, null)] });
  t.after(h.close);
  await h.pushCount(1);
  const exitedAt = await Promise.race([h.hangUp().then(() => 'exited'), sleep(5000).then(() => 'still running')]);
  // Armed for rem_soon with no host to send to, it would stay due and wake the
  // process every millisecond from then on.
  assert.equal(exitedAt, 'exited', 'the server exits once its host has gone');
  assert.deepEqual(h.stored().map((r) => r.id), ['rem_due', 'rem_soon'], 'both are still in the file');
});
