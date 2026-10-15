// checkArguments: every argument a call sends is applied, or named as a
// problem; a key no tool here takes and like none is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addUnits, checkArguments, closestNames, ignoredNote } from '../src/arguments.js';
import type { ToolSchema } from '../src/arguments.js';

const configure: ToolSchema = { name: 'configure', inputSchema: { properties: {
  intervalSeconds: { type: 'number', description: 'Interval in seconds.' },
  intervalMinutes: { type: 'number', description: 'Interval in minutes.' },
  paused: { type: 'boolean', description: 'Pause or resume.' },
  mode: { type: 'string', enum: ['message', 'silent'], description: 'How it is delivered.' },
} } };
const cancel: ToolSchema = { name: 'cancel', inputSchema: {
  properties: { id: { type: 'string', description: 'The id of the reminder to cancel. More detail.' } },
  required: ['id'],
} };
const list: ToolSchema = { name: 'list', inputSchema: { properties: {} } };
const tools = [configure, cancel, list];

test('arguments the schema takes, of the types it gives, pass', () => {
  assert.deepEqual(checkArguments(configure, { intervalMinutes: 30, paused: true, mode: 'silent' }, tools), { problems: [], ignored: [] });
  assert.deepEqual(checkArguments(list, {}, tools), { problems: [], ignored: [] });
});

test('each wrong type, value outside an enum and missing required argument is named, all at once', () => {
  const { problems } = checkArguments(configure, { intervalMinutes: '30', paused: 'true', mode: 'loud', intervalSeconds: null }, tools);
  assert.deepEqual(problems, [
    '"intervalMinutes" is the string "30"; give it as a number: 30.',
    '"paused" is the string "true"; give it as true or false, without quotes: true.',
    '"mode" "loud" isn\'t one of its values; give "message" or "silent".',
    '"intervalSeconds" is null; give a number.',
  ]);
  assert.deepEqual(checkArguments(cancel, {}, tools).problems, ['"id" is missing: the id of the reminder to cancel.']);
});

test('a near miss, or another tool\'s argument or a near miss of one, is a problem: the agent believes it did something', () => {
  assert.deepEqual(checkArguments(configure, { Paused: true }, tools).problems,
    ['"Paused" isn\'t an argument configure takes; the closest is "paused".']);
  assert.deepEqual(checkArguments(configure, { pasued: true }, tools).problems,
    ['"pasued" isn\'t an argument configure takes; the closest is "paused".']);
  assert.deepEqual(checkArguments(list, { id: 'rem_1' }, tools).problems,
    ['"id" is cancel\'s argument, not list\'s; list takes no arguments.']);
  assert.deepEqual(checkArguments(list, { Id: 'rem_1' }, tools).problems,
    ['"Id" is close to "id", cancel\'s argument, not one list takes; list takes no arguments.']);
});

test('a key like nothing here is ignored, unless it is all a tool that takes arguments was sent', () => {
  assert.deepEqual(checkArguments(configure, { paused: true, reason: 'quiet' }, tools), { problems: [], ignored: ['reason'] });
  assert.deepEqual(checkArguments(list, { verbose: true }, tools), { problems: [], ignored: ['verbose'] });
  assert.deepEqual(checkArguments(configure, { reason: 'quiet' }, tools), {
    problems: ['It doesn\'t take "reason"; it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".'],
    ignored: [],
  });
  // A name an argument's starts with is no slip, as agent-framework decides it, but it is what the result suggests.
  assert.deepEqual(checkArguments(configure, { paused: true, interval: 30 }, tools), { problems: [], ignored: ['interval'] });
  assert.deepEqual(checkArguments(configure, { interval: 30 }, tools).problems,
    ['It doesn\'t take "interval"; the closest it takes is "intervalSeconds" or "intervalMinutes".']);
});

test('the note on ignored keys suggests what each may have meant, or names every argument', () => {
  assert.equal(ignoredNote(configure, ['interval']),
    'configure ignored "interval", which it doesn\'t take; the closest it takes is "intervalSeconds" or "intervalMinutes".');
  assert.equal(ignoredNote(configure, ['interval', 'reason']),
    'configure ignored "interval" and "reason", which it doesn\'t take; the closest to "interval" it takes is "intervalSeconds" or '
      + '"intervalMinutes", and it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".');
  assert.equal(ignoredNote(configure, ['reason'], true),
    'It also doesn\'t take "reason"; it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".');
});

test('arguments that aren\'t an object are a problem', () => {
  assert.deepEqual(checkArguments(cancel, 'rem_1', tools).problems, [
    'Its arguments are the string "rem_1"; give an object of named arguments, such as {"id": …}.',
    '"id" is missing: the id of the reminder to cancel.',
  ]);
  assert.deepEqual(checkArguments(list, [], tools).problems, ['Its arguments are a list; give an object of named arguments, or none.']);
});

test('a key named like an Object.prototype member is no argument', () => {
  assert.deepEqual(checkArguments(list, { constructor: 1 }, tools), { problems: [], ignored: ['constructor'] });
});

test('closestNames ranks prefixes and substrings ahead of edits, gives two at most, and returns nothing past noise', () => {
  assert.deepEqual(closestNames('PAUSED', ['paused', 'mode']), ['paused']);
  assert.deepEqual(closestNames('mod', ['paused', 'mode']), ['mode']);
  assert.deepEqual(closestNames('pasued', ['paused', 'mode']), ['paused']);
  assert.deepEqual(closestNames('reason', ['paused', 'mode']), []);
  // "mud" is as few edits from "mod" as "mode" is, but "mode" starts with it.
  assert.deepEqual(closestNames('mod', ['mud', 'mode']), ['mode', 'mud']);
  assert.deepEqual(closestNames('every', ['everyHours', 'everyMinutes', 'everySeconds']), ['everyHours', 'everyMinutes']);
});

test('addUnits adds the units given, and refuses a negative one', () => {
  const units = [['inSeconds', 1], ['inMinutes', 60], ['inHours', 3600]] as const;
  const problems: string[] = [];
  assert.deepEqual(addUnits({ inHours: 1, inMinutes: 30 }, units, problems), { given: [['inMinutes', 30], ['inHours', 1]], seconds: 5400 });
  assert.equal(addUnits({}, units, problems), null);
  assert.deepEqual(problems, []);
  assert.equal(addUnits({ inMinutes: -5, inSeconds: 10 }, units, problems), null);
  assert.deepEqual(problems, ['"inMinutes" -5 is negative; give 0 or more.']);
  assert.equal(addUnits({ inHours: 1e306 }, units, [])?.seconds, Infinity);
  // Fractions are kept, to the millisecond.
  assert.equal(addUnits({ inSeconds: 4.6 }, units, [])?.seconds, 4.6);
  assert.equal(addUnits({ inMinutes: 0.1 }, units, [])?.seconds, 6);
  assert.equal(addUnits({ inSeconds: 0.0004 }, units, [])?.seconds, 0);
});
