// What the agent reads when a tools/call names no tool here, or its tool
// throws: what happened, and what to do next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '@animalabs/mcpl-core';
import { describeThrown, noSuchTool, toolThrew } from '../src/call-texts.js';
import { serverWithHost } from './scripted-host.js';

const tools = ['heartbeat_status', 'reminder_add'];
const listed = 'heartbeat-mcpl\'s tools are "heartbeat_status" and "reminder_add".';
const after = 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again. '
  + 'If it fails the same way again, ask whoever runs this host.';

test('a tool that doesn\'t exist is named, with the tools there are; a call naming none says so', () => {
  assert.equal(noSuchTool('reminder_snooze', tools), `There's no tool named "reminder_snooze" here, so nothing ran. ${listed}`);
  assert.equal(noSuchTool(undefined, tools), `The call doesn't name a tool, so nothing ran. ${listed}`);
});

test('a name that isn\'t a string is quoted as the call gave it', () => {
  assert.equal(noSuchTool(5, tools), `The call gives 5 as its tool's name, and a tool's name is a string, so nothing ran. ${listed}`);
  assert.equal(noSuchTool(null, tools), `The call gives null as its tool's name, and a tool's name is a string, so nothing ran. ${listed}`);
});

test('a tool that threw says what failed, that its outcome is unknown, and what to do if it fails again', () => {
  assert.equal(toolThrew('reminder_add', new Error('disk full.')), `reminder_add failed inside heartbeat-mcpl: disk full. ${after}`);
  // Anything can be thrown, so a value that isn't an Error is still answered.
  assert.equal(toolThrew(undefined, 'oops'), `The tool failed inside heartbeat-mcpl: oops. ${after}`);
});

test('a thrown value is described without throwing, whatever it is', () => {
  assert.equal(describeThrown(new RangeError('Invalid time value')), 'Invalid time value');
  assert.equal(describeThrown({ code: 'EIO' }), '{"code":"EIO"}');
  assert.equal(describeThrown(Object.create(null)), '{}');
  assert.equal(describeThrown(undefined), 'undefined');
  const unprintable = { toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } };
  assert.equal(describeThrown(unprintable), 'a value that can\'t be shown as text');
});

test('through the server, a tool that throws is answered with that text, after it may have changed something', async (t) => {
  // format-fault.mjs makes formatting 2099-01-01T09:00Z throw. reminder_add
  // saves the reminder, then formats its time for the reply.
  const fault = new URL('./format-fault.mjs', import.meta.url).href;
  const h = await serverWithHost(() => ({}), { env: { NODE_OPTIONS: `--import=${fault}` } });
  t.after(h.close);
  const error = await h.request('tools/call', { name: 'reminder_add', arguments: { message: 'x', atIso: '2099-01-01T09:00Z' } })
    .then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof RpcError, `expected a JSON-RPC error, got ${String(error)}`);
  assert.equal(error.code, -32000);
  // mcpl-core 0.2 starts the message with "RPC error <code>: ".
  assert.equal(error.message.replace(`RPC error ${error.code}: `, ''),
    `reminder_add failed inside heartbeat-mcpl: a fault this test put in formatToParts. ${after}`);
  assert.deepEqual(h.stored().map((r) => r.message), ['x'], 'the reminder was saved before the call failed');
});
