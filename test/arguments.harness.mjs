// Tool arguments against the built server, through the same HostSession as
// reminders.harness.mjs: every argument a call sends is applied, or the call
// is refused and changes nothing; units add up; atIso can start a repeating
// reminder. Before, an argument the server couldn't read was dropped without
// a word, and the last unit given won.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

test('every argument is applied, or the call is refused and changes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-arguments-'));
  const config = join(dir, 'config.json');
  const reminders = join(dir, 'reminders.json');
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: config, HEARTBEAT_REMINDERS_FILE: reminders, AGENT_TIMEZONE: 'UTC' },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await session.start();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  const call = async (name, args) => {
    const result = await session.callTool(name, args);
    return { isError: result.isError === true, text: result.content[0].text };
  };
  const stored = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const saved = () => (existsSync(reminders) ? JSON.parse(readFileSync(reminders, 'utf8')) : []);
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  /** Add a reminder, and the bounds its first fire must fall in: the delay
   *  from just before the call to just after it. */
  const add = async (args, delayMs) => {
    const before = Date.now();
    const result = await call('reminder_add', { message: 'x', ...args });
    const after = Date.now();
    assert.equal(result.isError, false, result.text);
    const id = /^Reminder (rem_\S+) set/.exec(result.text)?.[1];
    const row = saved().find((r) => r.id === id);
    assert.ok(row.fireAt >= before + delayMs && row.fireAt <= after + delayMs,
      `${JSON.stringify(args)} first fires ${row.fireAt - before} ms after the call began, for a delay of ${delayMs} ms`);
    return row;
  };

  await t.test('a call with one argument it can\'t read is refused whole', async () => {
    const before = stored(config);
    const { isError, text } = await call('heartbeat_configure', { paused: true, intervalMinutes: '30' });
    assert.equal(isError, true);
    assert.equal(text, 'heartbeat_configure: nothing was changed. "intervalMinutes" is the string "30"; give it as a number: 30.');
    assert.equal(stored(config), before);
    assert.match((await call('heartbeat_status', {})).text, /^Heartbeat ACTIVE/);
  });

  await t.test('interval units add up, and the total is saved', async () => {
    const { isError, text } = await call('heartbeat_configure', { intervalHours: 1, intervalMinutes: 30 });
    assert.equal(isError, false, text);
    assert.match(text, /interval=5400s/);
    assert.equal(JSON.parse(stored(config)).intervalSeconds, 5400);
  });

  await t.test('an interval under the floor is refused, not raised to it; one at the floor is applied', async () => {
    for (const [seconds, shown] of [[10, '10'], [59.5, '59\\.5']]) {
      const { isError, text } = await call('heartbeat_configure', { intervalSeconds: seconds });
      assert.equal(isError, true);
      assert.match(text, new RegExp(`"intervalSeconds" ${shown} is ${shown} s, under the heartbeat's 60-second floor`));
      assert.match((await call('heartbeat_status', {})).text, /interval=5400s/);
    }
    assert.match((await call('heartbeat_configure', { intervalSeconds: 60 })).text, /^Updated\. .*interval=60s/);
    assert.match((await call('heartbeat_configure', { intervalHours: 1.5 })).text, /^Updated\. .*interval=5400s/);
  });

  await t.test('a blank message or a negative interval is refused, changing nothing', async () => {
    const before = stored(config);
    for (const [args, reason] of [
      [{ message: '  ' }, /"message" is blank/],
      [{ intervalMinutes: -5 }, /"intervalMinutes" -5 is negative; give 0 or more\./],
      [{ intervalHours: 1e306 }, /"intervalHours" 1e\+306 puts the next heartbeat past \+275760-09-13T00:00:00Z, the last time it can be set for; give a shorter interval, or pause the heartbeat with "paused": true\.$/],
    ]) {
      const { isError, text } = await call('heartbeat_configure', args);
      assert.equal(isError, true, text);
      assert.match(text, reason);
    }
    assert.equal(stored(config), before);
  });

  await t.test('a key like nothing here is ignored and named; sent alone, it is refused', async () => {
    const applied = await call('heartbeat_configure', { paused: true, reason: 'quieter' });
    assert.equal(applied.isError, false, applied.text);
    assert.match(applied.text, /^Updated\. Heartbeat PAUSED .* heartbeat_configure ignored "reason", which it doesn't take; it takes "intervalSeconds"/);
    const alone = await call('heartbeat_configure', { reason: 'quieter' });
    assert.equal(alone.isError, true);
    assert.match(alone.text, /^heartbeat_configure: nothing was changed\. It doesn't take "reason"; it takes /);
    // A name an argument's contains is no slip, but the note says what it may have meant.
    const near = await call('heartbeat_configure', { paused: false, mode: 'silent' });
    assert.equal(near.isError, false, near.text);
    assert.match(near.text, /^Updated\. Heartbeat ACTIVE .* heartbeat_configure ignored "mode", which it doesn't take; the closest it takes is "deliveryMode"\.$/);
    assert.equal(JSON.parse(stored(config)).deliveryMode, 'message');
  });

  await t.test('another tool\'s argument is refused where it would do nothing', async () => {
    const { isError, text } = await call('reminder_list', { id: 'rem_x' });
    assert.equal(isError, true);
    assert.equal(text, 'reminder_list: nothing was listed. "id" is reminder_cancel\'s argument, not reminder_list\'s; reminder_list takes no arguments.');
    const shared = await call('reminder_cancel', { id: 'rem_x', message: 'x' });
    assert.equal(shared.isError, true);
    assert.equal(shared.text, 'reminder_cancel: nothing was cancelled. "message" is heartbeat_configure\'s and reminder_add\'s argument, '
      + 'not reminder_cancel\'s; reminder_cancel takes "id".');
    const cased = await call('reminder_cancel', { id: 'rem_x', Message: 'x' });
    assert.equal(cased.isError, true);
    assert.match(cased.text, /"Message" is close to "message", heartbeat_configure's and reminder_add's argument, not one reminder_cancel takes/);
  });

  await t.test('delay units add up, a one-off delay under 5 s is kept as given, and 0 fires at once', async () => {
    await add({ inHours: 1, inMinutes: 30 }, 5_400_000);
    // Cancelled well before it would fire, so the file holds still for the tests after.
    const soon = await add({ inSeconds: 4 }, 4000);
    assert.equal((await call('reminder_cancel', { id: soon.id })).isError, false);
    const now = await add({ inSeconds: 0 }, 0);
    for (const deadline = Date.now() + 10_000; !fired.includes(now.id) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(fired, [now.id], 'the reminder with no delay fires, and only it');
    assert.equal(saved().some((r) => r.id === now.id), false, 'and is gone once it has');
  });

  await t.test('a repeating reminder at its floor is set, and a fraction is kept', async () => {
    for (const seconds of [5, 7.5]) {
      const row = await add({ everySeconds: seconds }, seconds * 1000);
      assert.equal(row.everySeconds, seconds);
      assert.equal((await call('reminder_cancel', { id: row.id })).isError, false);
    }
  });

  await t.test('atIso with an interval sets the first fire and the period', async () => {
    const { isError, text } = await call('reminder_add', { message: 'DAILY', atIso: '2099-07-15T09:00Z', everyHours: 24 });
    assert.equal(isError, false, text);
    const row = saved().find((r) => r.message === 'DAILY');
    assert.equal(row.fireAt, Date.parse('2099-07-15T09:00:00Z'));
    assert.equal(row.everySeconds, 86_400);
  });

  await t.test('contradictions, intervals under the floor and wrong types are each refused, saving nothing', async () => {
    const before = stored(reminders);
    for (const [name, args, reason] of [
      ['reminder_add', { message: 'x', atIso: '2099-07-15T09:00Z', inMinutes: 5 }, /"atIso" and the delay, "inMinutes" 5, both set when it first fires; give one of them\./],
      ['reminder_add', { message: 'x', everySeconds: 2 }, /"everySeconds" 2 is 2 s, under the 5-second floor for a repeating reminder/],
      ['reminder_add', { message: 'x', everySeconds: 4.9 }, /"everySeconds" 4\.9 is 4\.9 s, under the 5-second floor for a repeating reminder/],
      ['reminder_add', { message: 'x', inMinutes: '5' }, /"inMinutes" is the string "5"; give it as a number: 5\./],
      ['reminder_add', { message: 'x', inMinutes: -5, everySeconds: 10 }, /"inMinutes" -5 is negative; give 0 or more\./],
      ['reminder_add', { message: '  ', inMinutes: 5 }, /"message" is blank/],
      ['reminder_add', { message: 'x' }, /No time was given: give a delay in inSeconds, inMinutes or inHours, a time in atIso, or an interval/],
      ['reminder_cancel', { id: 5 }, /^reminder_cancel: nothing was cancelled\. "id" is the number 5/],
      ['reminder_cancel', { id: '  ' }, /"id" is blank/],
    ]) {
      const { isError, text } = await call(name, args);
      assert.equal(isError, true, text);
      assert.match(text, reason);
    }
    assert.equal(stored(reminders), before);
  });
});
