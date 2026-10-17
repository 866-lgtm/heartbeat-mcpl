// What the agent and the operator are told while no wake can be delivered,
// through the server, with a scripted host that can be MCP-only or pre-0.5 and
// that reads the server's log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, logged, origin, serverWithHost } from './scripted-host.js';

const MCP_ONLY = 'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)';
const PRE_05 = 'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
  + 'so no wake is delivered on this connection';
const NOT_READY = 'no valid featureSets/update Request in force (none yet, or the last was malformed); '
  + 'capability-dependent behavior is unavailable until one arrives (§5.3)';
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('on an MCP-only host, a stored reminder is counted in the log at start, and replies say none will fire there', async (t) => {
  const now = Date.now();
  const h = await serverWithHost(() => ({}), {
    mcpl: false,
    reminders: [{ id: 'rem_old', message: 'old', createdAt: now - 60_000, fireAt: now - 1000, everySeconds: null }],
  });
  t.after(h.close);
  await logged(h, `none of the 1 reminder(s) will fire on this host: ${MCP_ONLY}`);
  const added = await h.call('reminder_add', { message: 'stretch', inMinutes: 5 });
  assert.match(added, new RegExp(String.raw`^Reminder rem_\S+ set: next \S+ \[[^\]]+\] \(~300s\) \| one-shot \| "stretch" `
    + `${escaped(`No wake can be delivered on this host: ${MCP_ONLY}. It won't fire here.`)}$`));
  await logged(h, `none of the 2 reminder(s) will fire on this host: ${MCP_ONLY}`);
  const list = await h.call('reminder_list');
  assert.match(list, /^rem_old \| next .* \(overdue\) \| one-shot \| "old"$/m);
  assert.ok(list.endsWith(`\nNo wake can be delivered on this host: ${MCP_ONLY}. No reminder will fire here.`), list);
  assert.equal(h.pushes.length, 0);
});

test('a pre-0.5 host, whose policy comes only as a Notification, hears that none will fire there, until a Request comes', async (t) => {
  const h = await serverWithHost(() => ({}), { policy: false });
  t.after(h.close);
  h.notify('featureSets/update', POLICY);
  const added = await h.call('reminder_add', { message: 'soon', inSeconds: 1 });
  assert.ok(added.endsWith(`"soon" No wake can be delivered on this host: ${PRE_05}. It won't fire here.`), added);
  await logged(h, `none of the 1 reminder(s) will fire on this host: ${PRE_05}`);
  assert.ok((await h.call('reminder_list')).endsWith(`\nNo wake can be delivered on this host: ${PRE_05}. No reminder will fire here.`));
  // A host that does send a Request speaks 0.5 after all, and the reminder fires.
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  assert.equal(origin(h.pushes[0]!).reminderId, /Reminder (rem_\S+) set/.exec(added)?.[1]);
});

test('once wakes are allowed a reply has no held note, and a malformed Request holds reminders again, saying so', async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.match(added, /^Reminder rem_\S+ set: next \S+ \[[^\]]+\] \(~3600s\) \| one-shot \| "later"$/);
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }));
  await logged(h, `none of the 1 reminder(s) fires until a wake can be delivered: ${NOT_READY}`);
  const list = await h.call('reminder_list');
  assert.ok(list.endsWith(`\nNo wake can be delivered now: ${NOT_READY}. A reminder that falls due waits until one can.`), list);
});

test('a Notification after a malformed Request is a 0.5 host\'s update: a reminder waits, and fires once a valid Request comes', async (t) => {
  // A host that has sent any Request speaks 0.5, so it is never told that no
  // reminder will fire on it, even after a Notification.
  const h = await serverWithHost(() => ({}), { policy: false });
  t.after(h.close);
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }));
  h.notify('featureSets/update', POLICY);
  const added = await h.call('reminder_add', { message: 'soon', atIso: new Date(Date.now() + 1000).toISOString() });
  assert.ok(added.endsWith(`"soon" No wake can be delivered now: ${NOT_READY}. It waits until one can.`), added);
  assert.ok((await h.call('reminder_list')).endsWith(`\nNo wake can be delivered now: ${NOT_READY}. A reminder that falls due waits until one can.`));
  await logged(h, `none of the 1 reminder(s) fires until a wake can be delivered: ${NOT_READY}`);
  assert.doesNotMatch(h.stderr(), /WARNING: initial policy has still not arrived as a Request/);
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  assert.equal(origin(h.pushes[0]!).reminderId, /Reminder (rem_\S+) set/.exec(added)?.[1]);
});
