// The ambient heartbeat's interval, against the built server through the same
// HostSession as reminders.harness.mjs: an interval longer than setTimeout can
// hold waits for it, and a stored interval heartbeat_configure couldn't have
// saved falls back to the default. Before, both fired about every millisecond.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server on its own files, with a stored config if one is given, past the
 *  initial policy, counting the heartbeats it pushes. */
async function start(t, storedConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-interval-'));
  const config = join(dir, 'config.json');
  if (storedConfig) writeFileSync(config, JSON.stringify(storedConfig));
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: config, HEARTBEAT_REMINDERS_FILE: join(dir, 'reminders.json') },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const heartbeats = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'heartbeat') heartbeats.push(ev.data);
  });
  await session.start();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  const status = async () => (await session.callTool('heartbeat_status', {})).content[0].text;
  return { session, heartbeats, status };
}

test('a 720-hour interval waits for its time, and the status counts down to it', async (t) => {
  const { session, heartbeats, status } = await start(t);
  await session.callTool('heartbeat_configure', { intervalHours: 720 });
  await sleep(2000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the two seconds after setting it');
  const next = Number(/next in ~(\d+)s/.exec(await status())?.[1]);
  assert.ok(next > 2_591_000 && next <= 2_592_000, `next in ~${next}s, of 2592000`);
});

test('a stored interval heartbeat_configure could not have saved falls back to the default', async (t) => {
  // heartbeat_configure saves an infinite interval as null, which read as 0.
  const { heartbeats, status } = await start(t, { intervalSeconds: null });
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting');
  assert.match(await status(), /interval=14400s/);
});
