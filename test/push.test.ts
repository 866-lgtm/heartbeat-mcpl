// sendPush says what came of a push/event, in words for the agent, and a push
// the host never answers fails after 30 s, so a reminder waiting on its answer
// can't wait forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { sendPush } from '../src/push.js';

const params: PushEventParams = {
  featureSet: 'heartbeat', eventId: 'reminder_1', timestamp: '2026-10-15T12:00:00.000Z',
  origin: { source: 'reminder' }, payload: { content: [{ type: 'text', text: 'hello' }] },
};

/** The server's end of a connection, and the host's end, which answers each
 *  request as `answer` says, or never when it returns undefined. */
function connected(answer: () => { error?: [number, string]; result?: unknown } | undefined) {
  const toHost = new PassThrough();
  const toServer = new PassThrough();
  const server = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);
  void (async () => {
    try {
      for (;;) {
        const msg = await host.nextMessage();
        if (msg.type !== 'request') continue;
        const a = answer();
        if (a?.error) host.sendError(msg.request.id, ...a.error);
        else if (a) host.sendResponse(msg.request.id, a.result);
      }
    } catch { /* closed */ }
  })();
  return { server, host, close: () => { host.close(); server.close(); } };
}

test('each answer is told apart: taken, refused with or without a reason, or an error', async (t) => {
  const cases: Array<[string, { error?: [number, string]; result?: unknown }, string | null]> = [
    ['taken', { result: { accepted: true, inferenceId: 'i' } }, null],
    ['refused with a reason', { result: { accepted: false, reason: 'busy' } }, 'the host refused it: busy'],
    ['refused without one', { result: { accepted: false } }, 'the host refused it'],
    ['an error answer', { error: [-32001, 'Feature set not enabled: heartbeat'] }, 'the push failed: Feature set not enabled: heartbeat'],
  ];
  for (const [name, answer, refusal] of cases) {
    const c = connected(() => answer);
    t.after(c.close);
    assert.equal((await sendPush(c.server, params)).refusal, refusal, name);
  }
});

test('a push the host never answers fails at 30 s, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = connected(() => undefined);
  t.after(c.close);
  let refusal: string | null | undefined;
  void sendPush(c.server, params).then((outcome) => { refusal = outcome.refusal; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(refusal, undefined, 'still waiting a millisecond before 30 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(refusal, 'the push failed: Request timed out after 30000ms: push/event');
});

test('a push out when the connection closes fails', async () => {
  const c = connected(() => undefined);
  const outcome = sendPush(c.server, params);
  c.close();
  assert.equal((await outcome).refusal, 'the push failed: Connection closed');
});
