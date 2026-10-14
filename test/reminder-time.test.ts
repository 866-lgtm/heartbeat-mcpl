import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReminderTime } from '../src/reminder-time.js';

for (const [label, time, zone, expected] of [
  ['winter', '2030-01-15T09:00:00', 'America/New_York', '2030-01-15T14:00:00Z'],
  ['summer', '2030-07-15T09:00:00', 'America/New_York', '2030-07-15T13:00:00Z'],
  ['after fall transition', '2030-11-03T09:00:00', 'America/New_York', '2030-11-03T14:00:00Z'],
  ['fractional seconds', '2030-07-15T09:00:00.123', 'America/New_York', '2030-07-15T13:00:00.123Z'],
  ['quarter-hour offset', '2030-07-15T09:00', 'Asia/Kathmandu', '2030-07-15T03:15:00Z'],
  ['UTC', '2030-07-15T09:00', 'UTC', '2030-07-15T09:00:00Z'],
]) {
  test(`offset-less ${label} time uses the supplied agent zone`, () => {
    assert.equal(parseReminderTime(time, zone), Date.parse(expected));
  });
}

for (const time of [
  '2030-07-15T09:00:00Z',
  '2030-07-15T09:00:00+05:30',
  '2030-07-15T09:00:00-0400',
  '2030-11-03T01:30:00-04:00',
  '2030-11-03T01:30:00-05:00',
  '2030-03-10T02:30:00-05:00',
]) {
  test(`explicit offset retains its instant: ${time}`, () => {
    assert.equal(parseReminderTime(time, 'America/New_York'), Date.parse(time));
  });
}

test('a repeated hour names the agent zone and both candidate offsets', () => {
  assert.throws(
    () => parseReminderTime('2030-11-03T01:30:00', 'America/New_York'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('America/New_York')
      && error.message.includes('-04:00')
      && error.message.includes('-05:00'),
  );
});

test('a skipped hour is refused rather than shifted', () => {
  assert.throws(
    () => parseReminderTime('2030-03-10T02:30:00', 'America/New_York'),
    /does not exist in America\/New_York/,
  );
});

test('a half-hour repeated interval is refused with its actual offsets', () => {
  assert.throws(
    () => parseReminderTime('2030-04-07T01:45:00', 'Australia/Lord_Howe'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('+11:00')
      && error.message.includes('+10:30'),
  );
});

test('an entire skipped calendar date is refused', () => {
  assert.throws(
    () => parseReminderTime('2011-12-30T12:00:00', 'Pacific/Apia'),
    /does not exist in Pacific\/Apia/,
  );
});

test('invalid calendar dates and malformed strings are refused', () => {
  for (const time of ['2030-02-30T09:00:00', 'not a timestamp']) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), /valid ISO-8601/);
  }
});
