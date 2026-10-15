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

  await t.test('a call with one argument it can\'t read is refused whole', async () => {
    const before = stored(config);
    const { isError, text } = await call('heartbeat_configure', { paused: true, intervalMinutes: '30' });
    assert.equal(isError, true);
    assert.equal(text, 'heartbeat_configure: nothing was changed. "intervalMinutes" is the string "30"; give it as a number: 30.');
    assert.equal(stored(config), before);
    assert.match((await call('heartbeat_status', {})).text, /^Heartbeat ACTIVE/);
  });

  await t.test('interval units add up', async () => {
    const { isError, text } = await call('heartbeat_configure', { intervalHours: 1, intervalMinutes: 30 });
    assert.equal(isError, false, text);
    assert.match(text, /interval=5400s/);
  });

  await t.test('an interval under the floor is refused, not raised to it', async () => {
    const { isError, text } = await call('heartbeat_configure', { intervalSeconds: 10 });
    assert.equal(isError, true);
    assert.match(text, /"intervalSeconds" 10 is 10 s, under the heartbeat's 60-second floor/);
    assert.match((await call('heartbeat_status', {})).text, /interval=5400s/);
  });

  await t.test('a key like nothing here is ignored and named; sent alone, it is refused', async () => {
    const applied = await call('heartbeat_configure', { paused: true, reason: 'quieter' });
    assert.equal(applied.isError, false, applied.text);
    assert.match(applied.text, /^Updated\. Heartbeat PAUSED .* heartbeat_configure ignored "reason", which it doesn't take; it takes "intervalSeconds"/);
    const alone = await call('heartbeat_configure', { reason: 'quieter' });
    assert.equal(alone.isError, true);
    assert.match(alone.text, /^heartbeat_configure: nothing was changed\. It doesn't take "reason"; it takes /);
  });

  await t.test('another tool\'s argument is refused where it would do nothing', async () => {
    const { isError, text } = await call('reminder_list', { id: 'rem_x' });
    assert.equal(isError, true);
    assert.equal(text, 'reminder_list: nothing was listed. "id" is reminder_cancel\'s argument, not reminder_list\'s; reminder_list takes no arguments.');
  });

  await t.test('delay units add up, and a one-off delay under 5 s fires as given', async () => {
    const before = Date.now();
    assert.equal((await call('reminder_add', { message: 'SUM', inHours: 1, inMinutes: 30 })).isError, false);
    assert.equal((await call('reminder_add', { message: 'SOON', inSeconds: 1 })).isError, false);
    const row = (message) => saved().find((r) => r.message === message);
    assert.ok(Math.abs(row('SUM').fireAt - (before + 5_400_000)) < 2000, `SUM due ${row('SUM').fireAt - before} ms on`);
    assert.ok(row('SOON').fireAt - before < 2000, `SOON due ${row('SOON').fireAt - before} ms on`);
    // Cancel it before it fires, so the file holds still for the next test.
    assert.equal((await call('reminder_cancel', { id: row('SOON').id })).isError, false);
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
      ['reminder_add', { message: 'x', inMinutes: '5' }, /"inMinutes" is the string "5"; give it as a number: 5\./],
      ['reminder_cancel', { id: 5 }, /^reminder_cancel: nothing was cancelled\. "id" is the number 5/],
    ]) {
      const { isError, text } = await call(name, args);
      assert.equal(isError, true, text);
      assert.match(text, reason);
    }
    assert.equal(stored(reminders), before);
  });
});
