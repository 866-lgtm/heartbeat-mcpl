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
  ['year below 100', '0042-07-15T09:00', 'UTC', '0042-07-15T09:00:00Z'],
  ['end-of-day', '2030-07-15T24:00', 'America/New_York', '2030-07-16T04:00:00Z'],
  ['end-of-month midnight', '2030-07-31T24:00:00', 'America/New_York', '2030-08-01T04:00:00Z'],
  ['historical offset seconds', '1890-07-15T09:00', 'Europe/Paris', '1890-07-15T08:50:39Z'],
  ['maximum Date boundary', '+275760-09-13T00:00', 'UTC', '+275760-09-13T00:00:00Z'],
  ['minimum Date boundary', '-271821-04-20T00:00', 'UTC', '-271821-04-20T00:00:00Z'],
  ['date-only (midnight)', '2030-07-15', 'America/New_York', '2030-07-15T04:00:00Z'],
  ['space-separated', '2030-07-15 09:00', 'America/New_York', '2030-07-15T13:00:00Z'],
  ['lowercase-t', '2030-07-15t09:00', 'America/New_York', '2030-07-15T13:00:00Z'],
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

for (const [time, expected] of [
  ['2030-07-15T09:00:00-04', '2030-07-15T13:00:00Z'],
  ['2030-07-15T09:00+05', '2030-07-15T04:00:00Z'],
  ['2030-07-15T09:00:00+0530', '2030-07-15T03:30:00Z'],
  ['2030-07-15T09:00:00z', '2030-07-15T09:00:00Z'],
  ['1890-07-15T09:00:00+000921', '1890-07-15T08:50:39Z'],
]) {
  test(`explicit offset in another ISO form retains its instant: ${time}`, () => {
    assert.equal(parseReminderTime(time, 'America/New_York'), Date.parse(expected));
  });
}

test('an explicit offset that puts the instant outside the Date range is refused as out of range', () => {
  for (const time of ['+275760-09-13T00:00:00-01:00', '-271821-04-20T00:00:00+01:00']) {
    assert.throws(() => parseReminderTime(time, 'UTC'), /outside the times a reminder can hold/);
  }
});

test('a historical offset containing seconds can be specified explicitly', () => {
  assert.equal(
    parseReminderTime('1890-07-15T09:00:00+00:09:21', 'Europe/Paris'),
    Date.parse('1890-07-15T08:50:39Z'),
  );
});

test('a repeated hour names the agent zone and both candidate offsets', () => {
  assert.throws(
    () => parseReminderTime('2030-11-03T01:30:00', 'America/New_York'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('America/New_York')
      && error.message.includes('-04:00')
      && error.message.includes('-05:00'),
  );
});

test('a repeated hour whose later offset is zero names it as +00:00', () => {
  assert.throws(
    () => parseReminderTime('2030-10-27T01:30:00', 'Europe/London'),
    (error: Error) => /occurs twice/.test(error.message) && error.message.includes('Include +01:00 or +00:00'),
  );
});

test('a zero offset that Intl names as bare GMT is labelled +00:00', (t) => {
  // ICU 78 (Node 20.20, 24.21) names a zero offset GMT+00:00; ICU 72 to 77 (Node 20.0 to 24.0) name it GMT.
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (this: Intl.DateTimeFormat, date?: Date | number) {
    return formatToParts.call(this, date).map((part) => (
      part.type === 'timeZoneName' && part.value === 'GMT+00:00' ? { ...part, value: 'GMT' } : part));
  });
  assert.throws(
    () => parseReminderTime('2030-10-27T01:30:00', 'Europe/London'),
    (error: Error) => error.message.includes('Include +01:00 or +00:00'),
  );
});

test('a time a permanent offset decrease repeats is refused with both offsets', () => {
  assert.throws(
    () => parseReminderTime('2014-10-26T01:30:00', 'Europe/Moscow'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('+04:00')
      && error.message.includes('+03:00'),
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

test('a half-hour skipped interval is refused', () => {
  assert.throws(
    () => parseReminderTime('2030-10-06T02:15:00', 'Australia/Lord_Howe'),
    /does not exist in Australia\/Lord_Howe/,
  );
});

test('a date whose midnight the zone skips is refused', () => {
  assert.throws(
    () => parseReminderTime('2030-03-10', 'America/Havana'),
    /does not exist in America\/Havana/,
  );
});

test('an entire skipped calendar date is refused', () => {
  assert.throws(
    () => parseReminderTime('2011-12-30T12:00:00', 'Pacific/Apia'),
    /does not exist in Pacific\/Apia/,
  );
});

test('malformed or out-of-range explicit offsets are refused, naming atIso and the forms accepted', () => {
  for (const offset of ['+24:00', '+00:60', '+00:00:60', '+0:0', '+053', '+05:3000', '+0530:15', '+05:30:1']) {
    assert.throws(
      () => parseReminderTime(`2030-07-15T09:00:00${offset}`, 'UTC'),
      (error: Error) => error.message.startsWith(`"atIso" has an invalid UTC offset ${offset}:`)
        && error.message.includes('±hh, ±hh:mm or ±hhmm'),
    );
  }
});

test('out-of-range clock fields are refused, with or without an offset', () => {
  for (const time of [
    '2030-07-15T25:00', '2030-07-15T09:60', '2030-07-15T09:00:60', '2030-07-15T24:30',
    '2030-07-15T25:00:00Z', '2030-07-15T09:60:00-04:00', '2030-07-15T09:00:60+05:30',
  ]) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), /valid ISO-8601/, time);
  }
});

test('invalid calendar dates and forms other than an ISO calendar date are refused with what atIso accepts', () => {
  for (const time of [
    '2030-02-30T09:00:00', 'not a timestamp', '2026-07', '2030',
    'Mon, 15 Jul 2030 09:00:00 GMT', '2030/07/15 09:00', '2030-07-15+05:00',
  ]) {
    assert.throws(
      () => parseReminderTime(time, 'America/New_York'),
      (error: Error) => /valid ISO-8601/.test(error.message)
        && error.message.includes('YYYY-MM-DD')
        && error.message.includes('Without one, the time is read in America/New_York'),
      time,
    );
  }
});
