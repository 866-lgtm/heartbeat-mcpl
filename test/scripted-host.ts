// A server under test, with a scripted host in place of mcpl-harness: the test
// decides how each push/event is answered, and reads the server's log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const POLICY = { effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [], enabled: ['heartbeat'], disabled: [] };
export const origin = (p: PushEventParams) => (p.origin ?? {}) as Record<string, unknown>;

/** How the host answers a push/event: with an error, or with a result
 *  (`{ accepted: true, … }` when neither is given). */
export type PushAnswer = { error?: [number, string]; result?: unknown };

/** Start the server on a fresh config, with `reminders` stored, and act as its
 *  host: initialize, send the policy as a Request, and answer each push/event
 *  as `answerPush` says. With `mcpl` false it initializes as an MCP-only host,
 *  which sends no policy; with `policy` false it sends none either, as a
 *  pre-0.5 host's Request never comes. */
export async function serverWithHost(
  answerPush: (p: PushEventParams) => PushAnswer,
  { reminders = [] as unknown[], mcpl = true, policy = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-scripted-host-'));
  const remindersFile = join(dir, 'reminders.json');
  writeFileSync(remindersFile, JSON.stringify(reminders));
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), '--stdio'], {
    cwd: ROOT,
    env: { ...process.env, HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: remindersFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const conn = McplConnection.fromStreams(child.stdout, child.stdin);
  const pushes: PushEventParams[] = [];
  const pushWaiters: Array<() => void> = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await conn.nextMessage();
        if (msg.type !== 'request' || msg.request.method !== 'push/event') continue;
        const p = msg.request.params as PushEventParams;
        pushes.push(p);
        const answer = answerPush(p);
        if (answer.error) conn.sendError(msg.request.id, ...answer.error);
        else conn.sendResponse(msg.request.id, answer.result ?? { accepted: true, inferenceId: 'i' });
        pushWaiters.splice(0).forEach((w) => w());
      }
    } catch { /* closed */ }
  })();
  await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true } } } : {},
    clientInfo: { name: 'test-host', version: '0' },
  }, 10_000);
  const request = (method: string, params: unknown) => conn.sendRequest(method, params, 10_000);
  if (mcpl && policy) await request('featureSets/update', POLICY);
  const notify = (method: string, params: unknown) => conn.sendNotification(method, params);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await conn.sendRequest('tools/call', { name, arguments: args }, 10_000)) as { content: Array<{ text: string }> }).content[0]!.text;
  const pushCount = async (n: number) => {
    const deadline = Date.now() + 5_000;
    while (pushes.length < n) {
      assert.ok(Date.now() < deadline, `expected ${n} push/event(s), saw ${pushes.length}`);
      await new Promise<void>((r) => { pushWaiters.push(r); setTimeout(r, 100); });
    }
  };
  // Let the response to the last push be read and logged by the server.
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const close = () => { conn.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); };
  return { pushes, call, request, notify, pushCount, settle, stderr: () => stderr, close };
}
