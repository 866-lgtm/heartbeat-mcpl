// Reminders that came due while the server was down are due the instant it
// restarts — before the host's initial featureSets/update Request (§5.3) has
// arrived. They must be held for that Request, not fired into the suppression
// gate and consumed (one-shots deleted, recurring ones advanced) over a push
// that was never sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StoredReminder { id: string; fireAt: number; everySeconds: number | null }

test('end to end: reminders overdue at startup are held for the policy Request, then delivered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-startup-reminders-'));
  const remindersPath = join(dir, 'reminders.json');
  const past = Date.now() - 60_000;
  writeFileSync(remindersPath, JSON.stringify([
    { id: 'rem_once', message: 'ONE-SHOT', createdAt: past - 1000, fireAt: past, everySeconds: null },
    { id: 'rem_every', message: 'RECURRING', createdAt: past - 1000, fireAt: past, everySeconds: 3600 },
  ]));
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), '--stdio'], {
    cwd: ROOT,
    env: { ...process.env, HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: remindersPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const conn = McplConnection.fromStreams(child.stdout, child.stdin);
  t.after(() => { conn.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); });

  const pushes: PushEventParams[] = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await conn.nextMessage();
        if (msg.type !== 'request' || msg.request.method !== 'push/event') continue;
        pushes.push(msg.request.params as PushEventParams);
        conn.sendResponse(msg.request.id, { accepted: true, inferenceId: 'i' });
      }
    } catch { /* closed */ }
  })();

  await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } },
    clientInfo: { name: 'test-host', version: '0' },
  }, 10_000);
  conn.sendNotification('notifications/initialized', {});

  // A host doing other startup work before its policy round-trip.
  await sleep(400);
  assert.equal(pushes.length, 0, 'nothing is pushed before the policy Request');
  assert.doesNotMatch(stderr, /DROPPED reminder/);
  assert.match(stderr, /holding 2 due reminder\(s\) until the host's initial featureSets\/update Request/);
  const held = JSON.parse(readFileSync(remindersPath, 'utf8')) as StoredReminder[];
  assert.deepEqual(held.map((r) => [r.id, r.fireAt]), [['rem_once', past], ['rem_every', past]], 'reminders file untouched while held');

  await conn.sendRequest('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], enabled: ['heartbeat'],
  }, 10_000);

  const deadline = Date.now() + 5_000;
  while (pushes.length < 2 && Date.now() < deadline) await sleep(50);
  await sleep(200);
  assert.deepEqual(pushes.map((p) => (p.origin as { reminderId?: string }).reminderId).sort(), ['rem_every', 'rem_once']);
  for (const p of pushes) assert.equal((p.origin as { source?: string }).source, 'reminder');

  const after = JSON.parse(readFileSync(remindersPath, 'utf8')) as StoredReminder[];
  assert.deepEqual(after.map((r) => r.id), ['rem_every'], 'the one-shot is consumed only once delivered');
  assert.ok(after[0]!.fireAt > Date.now(), 'the recurring reminder advanced to a future slot');
});
