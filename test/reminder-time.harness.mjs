// Exercise the built server through the same HostSession used by reminders.harness.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

test('reminder_add uses the agent zone, not the process zone, and refuses ambiguous or invalid times before saving', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-zone-'));
  const reminders = join(dir, 'reminders.json');
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: {
      // A process zone unlike the agent's, so reading wall times in the
      // process zone shows on a UTC runner too.
      TZ: 'Asia/Tokyo',
      AGENT_TIMEZONE: 'America/New_York',
      HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'),
      HEARTBEAT_REMINDERS_FILE: reminders,
    },
    autoApprove: true,
  });
  const saved = () => existsSync(reminders) ? readFileSync(reminders, 'utf8') : '';
  try {
    await session.start();
    await session.raw('featureSets/update', {
      effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
      enabled: ['heartbeat'], disabled: [],
    });

    await t.test('the tool schema names its offset-less zone and DST rule', async () => {
      const { tools } = await session.raw('tools/list', {});
      const description = tools.find((tool) => tool.name === 'reminder_add')
        .inputSchema.properties.atIso.description;
      assert.match(description, /America\/New_York/);
      assert.match(description, /nonexistent or repeated/);
    });

    for (const [atIso, reason] of [
      ['2099-11-01T01:30:00', /occurs twice.*America\/New_York.*-04:00.*-05:00/],
      ['2099-03-08T02:30:00', /does not exist in America\/New_York/],
      ['2099-07-15T25:00:00Z', /valid ISO-8601/],
      ['2099-07-15T09:60:00-04:00', /valid ISO-8601/],
      ['2099-07-15T09:00:00+05:3000', /invalid UTC offset/],
      ['+275760-09-13T00:00:00-01:00', /outside the times a reminder can hold/],
    ]) {
      await t.test(`reject ${atIso} without changing persisted reminders`, async () => {
        const before = saved();
        const result = await session.callTool('reminder_add', { message: 'ambiguous', atIso });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, reason);
        assert.equal(saved(), before);
      });
    }

    for (const [atIso, expected] of [
      ['2099-11-01T09:00:00', '2099-11-01T14:00:00Z'],
      ['2099-11-01T01:30:00-04:00', '2099-11-01T05:30:00Z'],
      ['2099-11-01T01:30:00-05:00', '2099-11-01T06:30:00Z'],
      ['2099-07-15', '2099-07-15T04:00:00Z'],
      ['2099-07-15T09:00-04', '2099-07-15T13:00:00Z'],
    ]) {
      await t.test(`persist the exact instant for ${atIso}`, async () => {
        const result = await session.callTool('reminder_add', { message: atIso, atIso });
        assert.notEqual(result.isError, true, result.content[0].text);
        const reminder = JSON.parse(saved()).find((row) => row.message === atIso);
        assert.equal(reminder.fireAt, Date.parse(expected));
        await session.callTool('reminder_cancel', { id: reminder.id });
      });
    }
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
