// What the agent reads when a tools/call names no tool here, or its tool
// throws: what happened, and what to do next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noSuchTool, toolThrew } from '../src/call-texts.js';

const tools = ['heartbeat_status', 'reminder_add'];

test('a tool that doesn\'t exist is named, with the tools there are; a call naming none says so', () => {
  assert.equal(noSuchTool('reminder_snooze', tools),
    'There\'s no tool named "reminder_snooze" here, so nothing ran. heartbeat-mcpl\'s tools are "heartbeat_status" and "reminder_add".');
  assert.equal(noSuchTool(undefined, tools),
    'The call doesn\'t name a tool, so nothing ran. heartbeat-mcpl\'s tools are "heartbeat_status" and "reminder_add".');
});

test('a tool that threw says what failed, that its outcome is unknown, and what to do if it fails again', () => {
  const after = 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again. '
    + "If it fails the same way again, calling won't fix it; ask whoever runs this host.";
  assert.equal(toolThrew('reminder_add', new Error('disk full.')), `reminder_add failed inside heartbeat-mcpl: disk full. ${after}`);
  // Anything can be thrown, so a value that isn't an Error is still answered.
  assert.equal(toolThrew(undefined, 'oops'), `The tool failed inside heartbeat-mcpl: oops. ${after}`);
});
