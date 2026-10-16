import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReminderText } from '../src/reminder-text.js';

const ZONE = 'America/Los_Angeles';
const SET = Date.parse('2026-10-10T15:02:36Z');
const NOW = new Date('2026-10-13T03:02:36Z');
const ON_TIME = NOW.getTime();

test('a one-shot reminder names itself, when it was set, and the current time', () => {
  assert.equal(
    formatReminderText({ id: 'rem_a', message: 'Draft the scene.', createdAt: SET, fireAt: ON_TIME, everySeconds: null }, NOW, ZONE),
    '[reminder rem_a, set 2026-10-10T08:02:36-07:00 [America/Los_Angeles]'
      + ' · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Draft the scene.',
  );
});

test('a recurring reminder names its interval instead of when it was set', () => {
  assert.equal(
    formatReminderText({ id: 'rem_b', message: 'Stretch.', createdAt: SET, fireAt: ON_TIME, everySeconds: 7200 }, NOW, ZONE),
    '[reminder rem_b, repeats every 7200s · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Stretch.',
  );
});

test('a message that opens like a chat line is not the first thing the agent reads', () => {
  const text = formatReminderText(
    { id: 'rem_c', message: 'Someone: the thing you promised.', createdAt: SET, fireAt: ON_TIME, everySeconds: null }, NOW, ZONE,
  );
  assert.match(text, /^\[reminder rem_c, set .+ · current time: .+\] Someone: the thing you promised\.$/);
});

test('an unrenderable set time is left out instead of throwing in the timer', () => {
  assert.equal(
    formatReminderText({ id: 'rem_d', message: 'Hi.', createdAt: 1e20, fireAt: ON_TIME, everySeconds: null }, NOW, ZONE),
    '[reminder rem_d · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Hi.',
  );
});

test('a reminder that fires a minute or more late names when it was due', () => {
  const due = Date.parse('2026-10-12T23:00:00Z');
  assert.equal(
    formatReminderText({ id: 'rem_e', message: 'Call back.', createdAt: SET, fireAt: due, everySeconds: null }, NOW, ZONE),
    '[reminder rem_e, set 2026-10-10T08:02:36-07:00 [America/Los_Angeles], due 2026-10-12T16:00:00-07:00 [America/Los_Angeles]'
      + ' · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Call back.',
  );
  assert.equal(
    formatReminderText({ id: 'rem_f', message: 'Stretch.', createdAt: SET, fireAt: due, everySeconds: 7200 }, NOW, ZONE),
    '[reminder rem_f, repeats every 7200s, due 2026-10-12T16:00:00-07:00 [America/Los_Angeles]'
      + ' · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Stretch.',
  );
});

test('a reminder less than a minute late leaves the due time out, and one exactly a minute late names it', () => {
  const late = (ms: number) => formatReminderText(
    { id: 'rem_g', message: 'Hi.', createdAt: SET, fireAt: ON_TIME - ms, everySeconds: null }, NOW, ZONE,
  );
  assert.doesNotMatch(late(59_999), /, due /);
  assert.match(late(60_000), /, due 2026-10-12T20:01:36-07:00 \[America\/Los_Angeles\] · /);
});

test('an unrenderable due time is left out instead of throwing in the timer', () => {
  assert.equal(
    formatReminderText({ id: 'rem_h', message: 'Hi.', createdAt: SET, fireAt: -1e20, everySeconds: null }, NOW, ZONE),
    '[reminder rem_h, set 2026-10-10T08:02:36-07:00 [America/Los_Angeles] · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Hi.',
  );
});
