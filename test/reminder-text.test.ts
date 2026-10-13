import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReminderText } from '../src/reminder-text.js';

const ZONE = 'America/Los_Angeles';
const SET = Date.parse('2026-10-10T15:02:36Z');
const NOW = new Date('2026-10-13T03:02:36Z');

test('a one-shot reminder names itself, when it was set, and the current time', () => {
  assert.equal(
    formatReminderText({ id: 'rem_a', message: 'Draft the scene.', createdAt: SET, everySeconds: null }, NOW, ZONE),
    '[reminder rem_a, set 2026-10-10T08:02:36-07:00 [America/Los_Angeles]'
      + ' · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Draft the scene.',
  );
});

test('a recurring reminder names its interval instead of when it was set', () => {
  assert.equal(
    formatReminderText({ id: 'rem_b', message: 'Stretch.', createdAt: SET, everySeconds: 7200 }, NOW, ZONE),
    '[reminder rem_b, repeats every 7200s · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Stretch.',
  );
});

test('a message that opens like a chat line is not the first thing the agent reads', () => {
  const text = formatReminderText(
    { id: 'rem_c', message: 'Someone: the thing you promised.', createdAt: SET, everySeconds: null }, NOW, ZONE,
  );
  assert.match(text, /^\[reminder rem_c, set .+ · current time: .+\] Someone: the thing you promised\.$/);
});

test('an unrenderable set time is left out instead of throwing in the timer', () => {
  assert.equal(
    formatReminderText({ id: 'rem_d', message: 'Hi.', createdAt: 1e20, everySeconds: null }, NOW, ZONE),
    '[reminder rem_d · current time: 2026-10-12T20:02:36-07:00 [America/Los_Angeles]] Hi.',
  );
});
