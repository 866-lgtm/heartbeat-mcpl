// sendPush says what came of a push/event, in words for the agent, and a push
// the host never answers fails after 30 s, so a reminder waiting on its answer
// can't wait forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection, RpcError } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { sendPush } from '../src/push.js';
import type { PushOutcome } from '../src/push.js';

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

/** The errors `conn`'s requests reject with, as mcpl-core gives them. */
function rejections(conn: McplConnection): Error[] {
  const seen: Error[] = [];
  const send = conn.sendRequest.bind(conn);
  conn.sendRequest = ((...args: Parameters<typeof send>) => {
    const sent = send(...args);
    sent.catch((e: Error) => { seen.push(e); });
    return sent;
  }) as typeof conn.sendRequest;
  return seen;
}

/** The refusal for a push that failed with `error`: "the push failed: " and the
 *  error's message, without the "RPC error <code>: " that mcpl-core 0.2 starts
 *  an RpcError's message with. The error answer below pins that with a message
 *  of the test's own. The timeout and the closed connection take mcpl-core's
 *  message from the error, since its words are mcpl-core's to change. */
function failedWith(error: Error): string {
  const why = error instanceof RpcError ? error.message.replace(`RPC error ${error.code}: `, '') : error.message;
  return `the push failed: ${why}`;
}

test('each answer is told apart: taken, refused with or without a reason, or an error; only accepted: false refuses', async (t) => {
  const cases: Array<[string, { error?: [number, string]; result?: unknown }, string | null]> = [
    ['taken', { result: { accepted: true, inferenceId: 'i' } }, null],
    ['an answer that says nothing of accepted', { result: {} }, null],
    ['a null answer', { result: null }, null],
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
  // The connection's own default is no timeout here, so only the bound that
  // sendPush gives can end the wait, whatever mcpl-core's default is.
  c.server.requestTimeout = 0;
  const seen = rejections(c.server);
  let outcome: PushOutcome | undefined;
  void sendPush(c.server, params).then((o) => { outcome = o; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(outcome, undefined, 'still waiting a millisecond before 30 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(seen.length, 1, 'the push failed at 30 s');
  assert.ok(outcome && 'error' in outcome, 'it came back as a failure');
  assert.equal(outcome.error, seen[0]);
  assert.equal(outcome.refusal, failedWith(seen[0]));
});

test('a push out when the connection closes fails', async () => {
  const c = connected(() => undefined);
  const seen = rejections(c.server);
  const pending = sendPush(c.server, params);
  c.close();
  const outcome = await pending;
  assert.equal(seen.length, 1, 'the push failed when the connection closed');
  assert.ok('error' in outcome, 'it came back as a failure');
  assert.equal(outcome.error, seen[0]);
  assert.equal(outcome.refusal, failedWith(seen[0]));
});
