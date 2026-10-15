// At the server: no save loses a reminders or config file it can't use. On
// main, either one loaded as empty or as the defaults, and the next save wrote
// over it, so what it held was lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { serverWithHost } from './scripted-host.js';

const copies = (dir: string, name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));
const unsaved = (what: string) => `This change can't be saved, because the ${what} file can't be used, so it won't last past a restart. `
  + "Calling again won't change that; ask whoever runs this host if you need it kept.";

test('a reminders file that isn\'t JSON is copied aside, and the next save writes a good one', async (t) => {
  const h = await serverWithHost(() => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, '[{"id": "rem_torn", "mess') });
  t.after(h.close);
  assert.equal(await h.call('reminder_list'), 'No reminders set.');
  const [copy] = copies(h.files.dir, 'reminders.json');
  assert.equal(readFileSync(`${h.files.dir}/${copy}`, 'utf8'), '[{"id": "rem_torn", "mess');
  assert.match(h.stderr(), /the reminders file .* isn't JSON; copied it to .*reminders\.json\.unreadable-[0-9a-f]{12}, and starting without it/);
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.doesNotMatch(added, /can't be saved/);
  assert.deepEqual(h.stored().map((r) => r.message), ['later']);
});

test('a reminders file that can\'t be read is left alone, and replies say a change won\'t last', async (t) => {
  const h = await serverWithHost(() => ({}), { prepare: ({ reminders }) => { rmSync(reminders); mkdirSync(reminders); } });
  t.after(h.close);
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.ok(added.endsWith(`| one-shot | "later". ${unsaved('reminders')}`), added);
  const id = /^Reminder (rem_\S+) set/.exec(added)?.[1];
  assert.match(await h.call('reminder_list'), new RegExp(`^${id} \\|`, 'm'), 'it is held in memory meanwhile');
  assert.ok((await h.call('reminder_cancel', { id })).endsWith(` ${unsaved('reminders')}`));
  assert.ok(statSync(h.files.reminders).isDirectory(), 'nothing was saved over it');
  assert.match(h.stderr(), /the reminders file .* couldn't be read \(EISDIR.*\); nothing is saved over it until a restart reads it again/);
});

test('a config that is JSON but not an object is copied aside, and the defaults load', async (t) => {
  const h = await serverWithHost(() => ({}), { prepare: ({ config }) => writeFileSync(config, '"quiet"') });
  t.after(h.close);
  assert.match(await h.call('heartbeat_status'), /^Heartbeat ACTIVE \| mode=message \| interval=14400s /);
  assert.equal(copies(h.files.dir, 'config.json').length, 1);
  const updated = await h.call('heartbeat_configure', { paused: true });
  assert.doesNotMatch(updated, /can't be saved/);
  assert.equal(JSON.parse(readFileSync(h.files.config, 'utf8')).paused, true);
  assert.equal(JSON.parse(readFileSync(h.files.config, 'utf8'))['0'], undefined, 'no key from the string it held');
});

test('a config that can\'t be read is left alone, and heartbeat_configure says its change won\'t last', async (t) => {
  const h = await serverWithHost(() => ({}), { prepare: ({ config }) => mkdirSync(config) });
  t.after(h.close);
  const updated = await h.call('heartbeat_configure', { paused: true });
  assert.ok(updated.startsWith(`Updated. ${unsaved('config')} Heartbeat PAUSED | `), updated);
  assert.match(await h.call('heartbeat_status'), /^Heartbeat PAUSED/, 'it applies in memory meanwhile');
  assert.ok(statSync(h.files.config).isDirectory(), 'nothing was saved over it');
});

test('a reminders file that is JSON but not a list is copied aside too', async (t) => {
  const h = await serverWithHost(() => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, '{"rem_1": "later"}') });
  t.after(h.close);
  assert.equal(await h.call('reminder_list'), 'No reminders set.');
  assert.equal(copies(h.files.dir, 'reminders.json').length, 1);
});

test('a file that can\'t be copied aside is left alone, as one that can\'t be read is', async (t) => {
  // A directory where its copy would go: the copy fails, so saving over the file would lose it.
  const copyPath = (path: string, text: string) => `${path}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  const h = await serverWithHost(() => ({}), {
    prepare: ({ reminders, config }) => {
      writeFileSync(reminders, 'not json');
      mkdirSync(copyPath(reminders, 'not json'));
      writeFileSync(config, 'not json either');
      mkdirSync(copyPath(config, 'not json either'));
    },
  });
  t.after(h.close);
  assert.ok((await h.call('reminder_add', { message: 'later', inHours: 1 })).endsWith(` ${unsaved('reminders')}`));
  assert.ok((await h.call('heartbeat_configure', { paused: true })).startsWith(`Updated. ${unsaved('config')} Heartbeat PAUSED | `));
  assert.equal(readFileSync(h.files.reminders, 'utf8'), 'not json', 'the reminders file is as it was');
  assert.equal(readFileSync(h.files.config, 'utf8'), 'not json either', 'and so is the config');
});

test('a row that isn\'t a reminder is dropped with a log line that keeps it whole', async (t) => {
  const row = { id: 'rem_ok', message: 'ok', createdAt: Date.now(), fireAt: Date.now() + 3_600_000, everySeconds: null };
  const h = await serverWithHost(() => ({}), { reminders: [row, { message: 'no id' }] });
  t.after(h.close);
  assert.match(await h.call('reminder_list'), /^1 reminder\(s\):\nrem_ok \|/);
  assert.match(h.stderr(), /dropped reminder \{"message":"no id"\}: it isn't a reminder this server writes/);
});
