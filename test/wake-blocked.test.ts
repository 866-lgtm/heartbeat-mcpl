// Why a wake can't be delivered: the log keeps the protocol's terms for whoever
// runs the host, and the agent gets plain words and what to do, since it can't
// see the host's settings or act on the spec's sections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldNote, wakeBlocked } from '../src/wake-blocked.js';
import type { FeatureSetState } from '../src/mcpl05.js';

const state = (s: FeatureSetState) => () => s;
const ask = "Calling again won't change that; ask whoever runs this host if you need wakes.";

test('a wake can be delivered once the host has granted what it needs', () => {
  assert.equal(wakeBlocked(true, false, true, state({ active: true, missing: [] }), 'heartbeat'), null);
});

test('each reason a wake is blocked reads in plain words, with what to do', () => {
  const cases: Array<[boolean, boolean, boolean, FeatureSetState, string, string, string, boolean]> = [
    [false, false, false, { active: false, missing: [] },
      "the host doesn't support the push events wakes need", ask,
      'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)', true],
    [true, true, false, { active: false, missing: [] },
      "the host set this server up in an older form that can't turn wakes on", ask,
      'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
        + 'so no wake is delivered on this connection', true],
    [true, false, false, { active: false, missing: [] },
      "the host hasn't finished setting this server up, or its last settings message was malformed",
      'Try again shortly; if it persists, ask whoever runs this host.',
      'no valid featureSets/update Request in force (none yet, or the last was malformed); '
        + 'capability-dependent behavior is unavailable until one arrives (§5.3)', false],
    [true, false, true, { active: false, missing: ['pushEvents'], reason: 'capability_denied' },
      "the host hasn't granted this server what its wakes need", ask,
      'capability not granted: pushEvents (§5.4 — absence is denial)', false],
    [true, false, true, { active: false, missing: [], reason: 'host_disabled' },
      'the host has turned heartbeat off for this server', ask, 'feature set "heartbeat" is host_disabled', false],
    [true, false, true, { active: false, missing: [], reason: 'not_enabled' },
      "the host hasn't enabled heartbeat for this server", ask, 'feature set "heartbeat" is not_enabled', false],
    [true, false, true, { active: false, missing: [], reason: 'invalid_uses' },
      "this server's own heartbeat declaration is malformed",
      "Calling again won't change that; ask whoever runs this host to report it to heartbeat-mcpl's maintainers.",
      'feature set "heartbeat" is invalid_uses', true],
  ];
  for (const [mcpl, notified, ready, s, reason, remedy, log, final] of cases) {
    assert.deepEqual(wakeBlocked(mcpl, notified, ready, state(s), 'heartbeat'), { log, reason, remedy, final }, log);
  }
});

test('the feature-set state is read only once the host has sent its policy', () => {
  let read = 0;
  const counted = () => { read++; return { active: true, missing: [] }; };
  wakeBlocked(false, false, true, counted, 'heartbeat');
  wakeBlocked(true, true, false, counted, 'heartbeat');
  wakeBlocked(true, false, false, counted, 'heartbeat');
  assert.equal(read, 0);
});

test('a due reminder waits until a wake can be delivered, unless none ever can on this host', () => {
  const denied = wakeBlocked(true, false, true, state({ active: false, missing: ['pushEvents'], reason: 'capability_denied' }), 'heartbeat')!;
  assert.equal(heldNote(denied, false), "No wake can be delivered now, because the host hasn't granted this server what its wakes need. "
    + "A reminder that falls due waits until one can. If that doesn't change, ask whoever runs this host.");
  assert.equal(heldNote(denied, true), "No wake can be delivered now, because the host hasn't granted this server what its wakes need, "
    + "so it waits until one can. If that doesn't change, ask whoever runs this host.");
  const mcpOnly = wakeBlocked(false, false, false, state({ active: false, missing: [] }), 'heartbeat')!;
  assert.equal(heldNote(mcpOnly, false), "No wake can be delivered on this host, because the host doesn't support the push events "
    + `wakes need, so no reminder will fire here. ${ask}`);
  assert.equal(heldNote(mcpOnly, true), "No wake can be delivered on this host, because the host doesn't support the push events "
    + `wakes need, so it won't fire here. ${ask}`);
});
