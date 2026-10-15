#!/usr/bin/env node
/**
 * heartbeat-mcpl — periodic self-wake + reminder scheduler MCPL server.
 *
 * Two independent wake sources, both delivered as push/event on the same
 * `heartbeat` feature set:
 *   1. The ambient heartbeat — one global periodic wake (intervalSeconds,
 *      paused, message), configured via heartbeat_* tools. Unchanged.
 *   2. Reminders — any number of one-shot or recurring wakes, each with its own
 *      message, added/listed/cancelled via reminder_* tools. Persisted so they
 *      survive a server restart.
 *
 * Ambient config persists to $HEARTBEAT_CONFIG_FILE (default
 * ./heartbeat-config.json); reminders to $HEARTBEAT_REMINDERS_FILE (default
 * ./heartbeat-reminders.json).
 *
 * Usage: heartbeat-mcpl --stdio
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type {
  McplInitializeParams, PushEventParams, JsonRpcId,
} from '@animalabs/mcpl-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { formatAgentDateTime, resolveAgentTimeZone } from './timezone.js';
import { sendSilentWithFallback } from './silent-delivery.js';
import { sendPush } from './push.js';
import { formatReminderText } from './reminder-text.js';
import { FIRST_REMINDER_TIME, LAST_REMINDER_TIME, canHoldTime, parseReminderTime } from './reminder-time.js';
import { callAt } from './timer.js';
import { addUnits, checkArguments, givenList, givenText, ignoredNote } from './arguments.js';
import type { Length, ToolSchema } from './arguments.js';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetState, FeatureSetWireEntry,
  Grant, InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';

const CONFIG_PATH = process.env.HEARTBEAT_CONFIG_FILE ?? './heartbeat-config.json';
const REMINDERS_PATH = process.env.HEARTBEAT_REMINDERS_FILE ?? './heartbeat-reminders.json';
const FS_NAME = 'heartbeat';
const AGENT_TIME_ZONE = resolveAgentTimeZone();
// Floor on a repeating reminder's interval — keeps a runaway "every 0s" from
// spamming the agent, while still allowing brisk test cadences. A one-off
// can't repeat, so its delay has none.
const MIN_REMINDER_SECONDS = 5;
// Floor on the ambient heartbeat's interval.
const MIN_HEARTBEAT_SECONDS = 60;

// Each length's units, which add up: [argument, seconds per unit].
const INTERVAL_UNITS = [['intervalSeconds', 1], ['intervalMinutes', 60], ['intervalHours', 3600]] as const;
const DELAY_UNITS = [['inSeconds', 1], ['inMinutes', 60], ['inHours', 3600]] as const;
const EVERY_UNITS = [['everySeconds', 1], ['everyMinutes', 60], ['everyHours', 3600]] as const;

type HeartbeatDeliveryMode = 'message' | 'silent';
interface HeartbeatConfig { intervalSeconds: number; paused: boolean; message: string; deliveryMode: HeartbeatDeliveryMode; }
const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalSeconds: 4 * 60 * 60,
  paused: false,
  deliveryMode: 'message',
  message: '[heartbeat] Periodic self-check-in. Review anything pending — reminders, schedules, follow-ups — and act if needed; otherwise a brief note to yourself is fine.',
};

/** A scheduled wake. `everySeconds === null` ⇒ one-shot, removed once the host
 *  takes its push; otherwise `fireAt` advances to its next future time each
 *  time the host takes one, and the reminder ends instead once that would pass
 *  the last time a reminder can hold. */
interface Reminder {
  id: string;
  message: string;
  createdAt: number; // epoch ms
  fireAt: number;    // epoch ms — the next time this reminder is due
  everySeconds: number | null; // recurrence interval; null = one-shot
}

function log(...a: unknown[]): void { console.error('[heartbeat-mcpl]', ...a); }
/** The silent-mode fallback is explained once per process, not on every tick. */
let silentFallbackExplained = false;
function loadConfig(): HeartbeatConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const merged = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } as HeartbeatConfig;
      if (merged.deliveryMode !== 'message' && merged.deliveryMode !== 'silent') merged.deliveryMode = 'message';
      // A stored interval means what heartbeat_configure would have made of it.
      // It saves an infinite interval as null, so null means "never": it
      // loads paused, at the default for when it's resumed. Under 60 s is
      // raised to 60 (Math.max(60, …)). Anything else that isn't a finite
      // number falls back to the default, since its owner wanted some
      // interval, and a pause would stop the wake that lets the agent notice.
      // Before, null, zero or a negative number fired the heartbeat about
      // every millisecond.
      const stored: unknown = merged.intervalSeconds;
      if (stored === null) {
        log(`config intervalSeconds is null, as heartbeat_configure saves an infinite interval; loading paused, at the default ${DEFAULT_CONFIG.intervalSeconds}s for when it's resumed`);
        merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
        merged.paused = true;
      } else if (typeof stored !== 'number' || !Number.isFinite(stored)) {
        log(`config intervalSeconds ${JSON.stringify(stored)} is not a number of seconds; using the default, ${DEFAULT_CONFIG.intervalSeconds}s`);
        merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
      } else if (stored < 60) {
        log(`config intervalSeconds ${stored} is under the 60-second floor; using 60s`);
        merged.intervalSeconds = 60;
      }
      return merged;
    }
  } catch (e) { log('config read failed:', (e as Error).message); }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(c: HeartbeatConfig): void {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
  catch (e) { log('config write failed:', (e as Error).message); }
}

/** A reminder as the file may hold it: earlier versions saved a time too large
 *  for a number, which JSON writes as null. */
type StoredReminder = Omit<Reminder, 'fireAt'> & { fireAt: number | null };
/** Structural guard so a corrupt/hand-edited reminders file can't crash the
 *  server or inject malformed entries — bad rows are dropped, good ones kept. */
function isStoredReminder(x: unknown): x is StoredReminder {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.message === 'string'
    && typeof r.createdAt === 'number'
    && (r.fireAt === null || typeof r.fireAt === 'number')
    && (r.everySeconds === null || typeof r.everySeconds === 'number');
}
function loadReminders(): Reminder[] {
  try {
    if (existsSync(REMINDERS_PATH)) {
      const parsed = JSON.parse(readFileSync(REMINDERS_PATH, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        // A stored time outside a Date's range can't be listed, since formatting
        // it throws, and that took reminder_list down for every reminder. One
        // past the range, or the null JSON wrote for one too large for a number,
        // could never fire; reminder_add saved such times before it checked
        // them. One below the range is dropped the same way. The log line keeps
        // the row, message and all, since the next save leaves it out of the file.
        const holdable = parsed.filter(isStoredReminder).filter((r): r is Reminder => {
          if (r.fireAt !== null && canHoldTime(r.fireAt)) return true;
          log(`dropped reminder ${JSON.stringify(r)}: its stored time is outside the times a reminder can hold, `
            + `${FIRST_REMINDER_TIME} to ${LAST_REMINDER_TIME}`);
          return false;
        });
        // A stored interval means what reminder_add made of it when it was
        // saved. Earlier versions read 0 or less as no interval and raised one
        // under MIN_REMINDER_SECONDS to it, so a stored one loads as a one-off
        // or as the floor; reminder_add now refuses both. Before, 0 or less
        // fired again at once on every advance, about every millisecond.
        return holdable.map((r) => {
          if (r.everySeconds === null || r.everySeconds >= MIN_REMINDER_SECONDS) return r;
          if (r.everySeconds <= 0) {
            log(`reminder ${r.id}: stored interval ${r.everySeconds}s is no interval; it fires once`);
            return { ...r, everySeconds: null };
          }
          log(`reminder ${r.id}: stored interval ${r.everySeconds}s is under the ${MIN_REMINDER_SECONDS}-second floor; using ${MIN_REMINDER_SECONDS}s`);
          return { ...r, everySeconds: MIN_REMINDER_SECONDS };
        });
      }
      log('reminders file is not an array; ignoring');
    }
  } catch (e) { log('reminders read failed:', (e as Error).message); }
  return [];
}
function saveReminders(reminders: Reminder[]): void {
  try { writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2)); }
  catch (e) { log('reminders write failed:', (e as Error).message); }
}

// `uses` must name every capability the feature set actually exercises (SPEC
// §6.2 vocabulary; §6.4 derivation). This set answers tools/call AND delivers
// every wake as push/event, so it needs both `tools` and `pushEvents` — the
// declaration previously said only `tools` while pushing. `hostState` was
// removed from the declaration in 0.4.1 and is gone; `rollback` survives (§8.1).
const featureSetDecl: FeatureSetDeclaration05 = {
  description: 'Periodic self-wake heartbeats, one-shot/recurring reminders, and schedule configuration',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};
// The name-keyed view §6.4/§6.7 derive over — one feature set here.
const declaredFeatureSets: FeatureSetMap = { [FS_NAME]: featureSetDecl };
// On the wire, still the 0.4 array-of-{name, …} shape. §6.1 and App. B.2 say
// object-keyed-by-name, but mcpl-harness reads only the array
// (src/session.ts:493-497) and agent-framework accepts either
// (feature-set-manager.ts:154-161). See the note in mcpl05.ts — flipping this is
// an ecosystem migration (it also feeds the §17.2 digest), not a one-server edit.
const featureSets: FeatureSetWireEntry[] = [{ name: FS_NAME, ...featureSetDecl }];

/** A tool as tools/list sends it. Its inputSchema is also what dispatch checks
 *  each call's arguments against (see checkArguments). */
interface ToolDefinition extends ToolSchema {
  description: string;
  inputSchema: ToolSchema['inputSchema'] & { type: 'object' };
}

const toolDefinitions: ToolDefinition[] = [
  { name: 'heartbeat_status', description: 'Show your current heartbeat schedule (interval, paused state, time to next wake, message) and how many reminders are pending.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'heartbeat_configure',
    description: 'Change your own ambient heartbeat schedule. Give any of: the interval, in intervalSeconds, intervalMinutes and intervalHours, which add up, 60 seconds or more; paused; deliveryMode; message. Persists across restarts. With no arguments it changes nothing and shows the schedule. (Reminders are separate — see reminder_add.)',
    inputSchema: { type: 'object', properties: {
      intervalSeconds: { type: 'number', description: 'Wake interval in seconds. Adds to intervalMinutes and intervalHours; together, 60 seconds or more.' },
      intervalMinutes: { type: 'number', description: 'Wake interval in minutes. Adds to intervalSeconds and intervalHours.' },
      intervalHours: { type: 'number', description: 'Wake interval in hours. Adds to intervalSeconds and intervalMinutes.' },
      paused: { type: 'boolean', description: 'Pause (true) or resume (false) heartbeats.' },
      deliveryMode: { type: 'string', enum: ['message', 'silent'], description: 'message = durable prompt; silent = ephemeral private tick with no durable message or automatic prose.' },
      message: { type: 'string', description: 'The text delivered to you in message mode.' },
    } } },
  { name: 'heartbeat_trigger', description: 'Fire an ambient heartbeat immediately (does not change the schedule).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'reminder_add',
    description: 'Schedule a reminder that wakes you with a specific message. One-off: give a delay, in inSeconds, inMinutes and inHours, which add up, or an absolute time, atIso. Repeating: give an interval, in everySeconds, everyMinutes and everyHours, which add up, 5 seconds or more. A repeating reminder first fires one interval out, or at the delay or atIso you also give. Survives restarts. Returns the reminder id.',
    inputSchema: { type: 'object', properties: {
      message: { type: 'string', description: 'The text delivered to you when the reminder fires. It arrives after a header naming the reminder, when it was set (or its interval) and the current time, e.g. `[reminder <id>, set <time> · current time: <time>] <message>`.' },
      inSeconds: { type: 'number', description: 'Fire this many seconds from now. Adds to inMinutes and inHours.' },
      inMinutes: { type: 'number', description: 'Fire this many minutes from now. Adds to inSeconds and inHours.' },
      inHours: { type: 'number', description: 'Fire this many hours from now. Adds to inSeconds and inMinutes.' },
      atIso: { type: 'string', description: `When it fires, or first fires if it repeats: an ISO-8601 date/time. Without an offset, read in AGENT_TIMEZONE (${AGENT_TIME_ZONE}), and a date alone (YYYY-MM-DD) is midnight there; nonexistent or repeated wall times are refused so no DST choice is made for you. For a repeated time, supply one of the offsets named in the error. Z or a numeric offset specifies the instant directly (e.g. 2026-07-01T09:00:00-04:00). A past time fires as soon as a wake can be delivered.` },
      everySeconds: { type: 'number', description: 'Repeat every N seconds. Adds to everyMinutes and everyHours; together, 5 seconds or more.' },
      everyMinutes: { type: 'number', description: 'Repeat every N minutes. Adds to everySeconds and everyHours.' },
      everyHours: { type: 'number', description: 'Repeat every N hours. Adds to everySeconds and everyMinutes.' },
    }, required: ['message'] } },
  { name: 'reminder_list', description: 'List your pending reminders (id, next fire time, recurrence, message).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'reminder_cancel', description: 'Cancel a reminder by its id (from reminder_add / reminder_list).',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'The id of the reminder to cancel, as reminder_add returned it and reminder_list shows it; it starts with rem_.' },
    }, required: ['id'] } },
];

/** What a refused call of each tool leaves undone, to open its refusal. */
const REFUSED: Record<string, string> = {
  heartbeat_status: 'nothing was shown',
  heartbeat_configure: 'nothing was changed',
  heartbeat_trigger: 'no heartbeat was sent',
  reminder_add: 'no reminder was set',
  reminder_list: 'nothing was listed',
  reminder_cancel: 'nothing was cancelled',
};

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }
interface NotifMsg { method: string; params?: unknown; }

class HeartbeatServer {
  private conn: McplConnection | null = null;
  private config = loadConfig();
  private reminders = loadReminders();
  /** Cancel the pending ambient heartbeat or reminder wake (see callAt). */
  private cancelHeartbeat: (() => void) | null = null;
  private cancelReminderWake: (() => void) | null = null;
  private nextFireAt = 0;
  private mcplEnabled = false;
  /** The effective grant (§5.4). Empty until the host sends one — there is no
   *  server-side default, and nothing this server says can add to it. */
  private grant: Grant = EMPTY_GRANT;
  /** §5.3/§6.7: only a Request-form featureSets/update establishes ready state.
   *  Until then every capability-dependent behavior is unavailable. */
  private policyReady = false;
  /** The host has sent featureSets/update only as a Notification, with no
   *  Request: a pre-0.5 host, on whose connection no wake is ever delivered
   *  (§5.3, §6.7). A Request, valid or not, clears it for good. */
  private notificationOnly = false;
  /** A featureSets/update Request has come on this connection, valid or not.
   *  Such a host speaks 0.5, so a Notification after it is a policy update,
   *  not a sign of a pre-0.5 host. */
  private requestSeen = false;
  /** The host refused the most recent silent tick as an empty push, so it
   *  went out in message mode (see silent-delivery.ts). */
  private silentFellBack = false;
  /** Ids of the reminders whose push has gone out and whose answer hasn't come
   *  (settleReminder). Arming skips them. It isn't saved: until the host
   *  answers, the file holds each as it was, so a crash meanwhile fires it
   *  again at the next start rather than losing it. */
  private inFlight = new Set<string>();
  /** The reminders whose last push the host refused, or whose push failed:
   *  when, and why, until the next push of each is sent. dueAt says when each
   *  is tried again. It isn't saved either: the file holds each as it was, so
   *  a restart tries it again. */
  private refused = new Map<string, { at: number; reason: string }>();

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    this.reschedule();
    // Reminders loaded from disk wait until their wakes can be delivered, which
    // the host's policy decides; meanwhile the log says how many there are.
    this.scheduleReminders();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        // Notifications used to be discarded here before method lookup, which is
        // exactly how a featureSets/update Notification went missing (§6.7).
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    this.cancelHeartbeat?.();
    this.cancelReminderWake?.();
    this.conn = null;
  }

  /** Consumes exactly the `initialize` request. `notifications/initialized` and
   *  anything the host sends next — including the initial policy of §5.3 — are
   *  left for the main loop rather than swallowed by a second blind read. */
  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    // §5.1: advertisement mirrors the capability paths, and `false` or absence
    // means none — so every path this server does not implement is simply
    // absent rather than spelled out as `false`. The old block also carried
    // `rollback`, which is not a §6.2 capability path at all: it is a
    // feature-set property (§8.1) and lives on the declaration.
    // `revision` (§17.2) is omitted: this manifest is fixed for the connection.
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'heartbeat-mcpl', version: '0.1.0' } };
    conn.sendResponse(msg.request.id, result);
    log('initialize answered' + (this.mcplEnabled ? ' (MCPL mode; awaiting featureSets/update policy)' : ' (MCP mode; push events unavailable)'));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, this.handleToolCall(params.name as string, params.arguments ?? {})); break;
        case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateRequest(req); break;
        // §6.6: a method that will never be answered MUST return an error, so
        // everything else — channels/* included, since no channel capability is
        // advertised or granted — falls through to -32601.
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private handleNotification(notif: NotifMsg): void {
    switch (notif.method) {
      case 'notifications/initialized':
        log('initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
        break;
      case method.FEATURE_SETS_UPDATE:
        this.handleFeatureSetsUpdateNotification(notif);
        break;
      default:
        log(`ignored notification: ${notif.method}`);
    }
  }

  // ── Negotiated policy (§5.3, §5.4, §6.7) ──

  /**
   * `featureSets/update` as a Request: apply the grant, then answer with a
   * degradation receipt.
   *
   * Ordering per §6.7 — the new grant is installed *before* the response goes
   * out, so a reduction takes effect atomically first and never waits on our
   * consent. The receipt that follows is testimony about consequences only; it
   * asks for nothing, and the host is barred from widening anything because of
   * it.
   */
  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const conn = this.conn!;
    const parsed = parsePolicy(req.params);
    // A host that sends a Request speaks 0.5, whatever this one holds.
    this.requestSeen = true;
    this.notificationOnly = false;
    if (!parsed.ok) {
      // §5.4: reject a malformed policy message, and hold no grant meanwhile.
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      log(`featureSets/update rejected as malformed: ${parsed.error}; grant cleared`);
      conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      this.retryRefused();
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    const receipt = buildReceipt(declaredFeatureSets, this.grant);
    log(`featureSets/update applied (Request): grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
    if (!parsed.hadEffectiveCapabilities) {
      log('featureSets/update carried no effectiveCapabilities; per §5.4 absence is denial, so nothing is granted');
    }
    // §5.4: deniedCapabilities is diagnostic data only. It is logged so an
    // operator can see what the host withheld, and it takes part in no decision
    // above — the grant was computed from effectiveCapabilities alone.
    if (this.grant.denied.length > 0) {
      log(`host reported deniedCapabilities (diagnostic only): [${this.grant.denied.join(', ')}]`);
    }
    for (const note of receipt.notes ?? []) log(`receipt note: ${note}`);
    conn.sendResponse(req.id, receipt);
    this.retryRefused();
  }

  /**
   * `featureSets/update` as a Notification (§6.7): valid only for metadata that
   * does not alter the grant, and it cannot establish ready state. A host that
   * changes the grant this way is non-conforming, so the message is honoured in
   * the one direction that is always safe — narrowing. Every dimension can only
   * shrink, and nothing here flips `policyReady`.
   */
  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) {
      log(`featureSets/update (Notification) malformed: ${parsed.error}; ignored, grant unchanged`);
      return;
    }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    log(`featureSets/update (Notification) applied as reduction only: grant=[${this.grant.patterns.join(', ')}]`
      + (this.policyReady ? '' : '; ready state NOT established — §6.7 requires a Request'));
    if (!this.requestSeen) this.notificationOnly = true;
    this.retryRefused();
    if (this.notificationOnly) {
      // The one moment we can positively identify a pre-0.5 host: it is talking
      // policy, but in the form §6.7 says cannot establish ready state. Say so
      // once, in full, because the consequence is that no wake will ever be
      // delivered on this connection and the operator needs to know why.
      log('WARNING: initial policy has still not arrived as a Request. Per SPEC §5.3 every '
        + 'capability-dependent behavior stays unavailable, so NO heartbeat or reminder will be '
        + 'delivered on this connection. The host must send featureSets/update as a Request '
        + 'carrying effectiveCapabilities (including "pushEvents").');
    }
  }

  private featureSetState(): FeatureSetState {
    return deriveFeatureSetState(FS_NAME, featureSetDecl, this.grant);
  }

  /** Why a wake cannot be delivered right now, or null when it can. */
  private pushBlockedReason(): string | null {
    // Once the host has gone, nothing may be armed: a reminder that can't be
    // sent stays due, and arming it would wake the process every millisecond.
    // A push still out when the host goes away fails, and its answer calls
    // scheduleReminders; this guard keeps that from arming anything. With
    // mcpl-core 0.2.1 that answer settles after serve has ended, which
    // `!this.conn` covers. isClosed covers it settling once the connection has
    // closed but before serve ends, so nothing is armed or sent into a closed
    // connection meanwhile. Which comes first depends on the promise steps on
    // both sides, mcpl-core's among them, so this code alone doesn't fix it.
    if (!this.conn || this.conn.isClosed) return 'the connection to the host has closed';
    if (!this.mcplEnabled) return 'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)';
    if (this.notificationOnly) {
      return 'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
        + 'so no wake is delivered on this connection';
    }
    if (!this.policyReady) {
      return 'no valid featureSets/update Request in force (none yet, or the last was malformed); '
        + 'capability-dependent behavior is unavailable until one arrives (§5.3)';
    }
    const state = this.featureSetState();
    if (state.active) return null;
    if (state.reason === 'capability_denied') return `capability not granted: ${state.missing.join(', ')} (§5.4 — absence is denial)`;
    return `feature set "${FS_NAME}" is ${state.reason}`;
  }

  private text(t: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) };
  }

  private statusText(): string {
    const c = this.config;
    const remaining = this.nextFireAt ? Math.max(0, Math.round((this.nextFireAt - Date.now()) / 1000)) : null;
    const blocked = this.pushBlockedReason();
    const mode = c.deliveryMode === 'silent' && this.silentFellBack
      ? 'silent (host refused the empty silent push; ticks fall back to message mode)'
      : c.deliveryMode;
    return `Heartbeat ${c.paused ? 'PAUSED' : 'ACTIVE'} | mode=${mode} | interval=${c.intervalSeconds}s (${(c.intervalSeconds / 3600).toFixed(2)}h)` +
      (c.paused || remaining === null ? '' : ` | next in ~${remaining}s`) +
      ` | reminders=${this.reminders.length}` +
      // Surfaced to the agent deliberately: if wakes cannot be delivered, the
      // agent asking "when do I next wake?" should be told, not reassured.
      ` | delivery=${blocked ? `BLOCKED (${blocked})` : 'ok'}` +
      ` | message="${c.message}"`;
  }

  /** Every argument a call sends is applied, or the call is refused, applies
   *  nothing, and names each problem at once: the schema's (checkArguments)
   *  and the tool's own. A key no tool takes, and like none, is left out, and
   *  the result says so. */
  private handleToolCall(name: string, rawArgs: unknown) {
    const tool = toolDefinitions.find((t) => t.name === name);
    if (!tool) return this.text(`Unknown tool: ${name}`, true);
    const { problems, ignored } = checkArguments(tool, rawArgs, toolDefinitions);
    // Arguments that aren't an object are a problem named above; read them as none.
    const args = (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
    const result = this.callTool(name, args, problems);
    if (ignored.length > 0) result.content[0].text += ` ${ignoredNote(tool, ignored)}`;
    return result;
  }

  /** Run a known tool, which adds its own problems to `problems` and is
   *  refused if there are any. */
  private callTool(name: string, args: Record<string, unknown>, problems: string[]) {
    switch (name) {
      case 'heartbeat_configure': return this.configure(args, problems);
      case 'reminder_add': return this.addReminder(args, problems);
      case 'reminder_cancel': return this.cancelReminder(args, problems);
    }
    if (problems.length > 0) return this.refuse(name, problems);
    switch (name) {
      case 'heartbeat_trigger': {
        const blocked = this.pushBlockedReason();
        this.fire('manual');
        return this.text((blocked ? `Heartbeat NOT delivered — ${blocked}. ` : 'Heartbeat fired. ') + this.statusText());
      }
      case 'reminder_list':
        return this.text(this.listRemindersText());
      default: // heartbeat_status
        return this.text(this.statusText());
    }
  }

  private refuse(tool: string, problems: readonly string[]) {
    return this.text(`${tool}: ${REFUSED[tool]}. ${problems.join(' ')}`, true);
  }

  private configure(args: Record<string, unknown>, problems: string[]) {
    const interval = addUnits(args, INTERVAL_UNITS, problems);
    if (interval && !Number.isFinite(interval.seconds)) {
      problems.push(`${givenText(interval, ['is', 'are'])} too long to save; give a shorter interval, or pause the heartbeat with "paused": true.`);
    } else if (interval && interval.seconds < MIN_HEARTBEAT_SECONDS) {
      problems.push(`${givenText(interval)} ${interval.seconds} s, under the heartbeat's ${MIN_HEARTBEAT_SECONDS}-second floor; `
        + `give ${MIN_HEARTBEAT_SECONDS} seconds or more, or pause it with "paused": true.`);
    }
    if (typeof args.message === 'string' && !args.message.trim()) {
      problems.push('"message" is blank; give the text each heartbeat should bring, or leave it out to keep the one it has.');
    }
    if (problems.length > 0) return this.refuse('heartbeat_configure', problems);
    const c = this.config;
    let changed = false;
    if (interval) { c.intervalSeconds = interval.seconds; changed = true; }
    if (typeof args.paused === 'boolean') { c.paused = args.paused; changed = true; }
    if (args.deliveryMode === 'message' || args.deliveryMode === 'silent') { c.deliveryMode = args.deliveryMode; changed = true; }
    if (typeof args.message === 'string') { c.message = args.message; changed = true; }
    if (changed) { saveConfig(c); this.reschedule(); }
    return this.text((changed ? 'Updated. ' : 'No changes. ') + this.statusText());
  }

  // ── Ambient heartbeat ──

  private reschedule(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    if (this.config.paused) { this.nextFireAt = 0; log('paused; no next fire scheduled'); return; }
    this.nextFireAt = Date.now() + this.config.intervalSeconds * 1000;
    this.cancelHeartbeat = callAt(this.nextFireAt, () => { this.fire('schedule'); this.reschedule(); });
    log(`next heartbeat in ${this.config.intervalSeconds}s`);
  }

  private fire(reason: string): void {
    if (this.config.paused && reason === 'schedule') return;
    // Prefix the current time so each heartbeat is temporally anchored — without
    // it every heartbeat is byte-identical, giving the agent no sense of "when"
    // (and identical repeats invite confabulation/looping).
    const now = formatAgentDateTime(new Date(), AGENT_TIME_ZONE);
    const text = `[current time: ${now}] ${this.config.message}`;
    const silent = this.config.deliveryMode === 'silent';
    const sent = silent
      ? this.emitSilentHeartbeat(reason, now, text)
      : this.emitPush(text, { source: 'heartbeat', reason }, 'heartbeat');
    log(`${sent ? 'fired' : 'DROPPED'} heartbeat (${reason}${silent ? ', silent' : ''})`);
  }

  /** Silent tick: the empty marker push, falling back to message mode for this
   *  tick when the host refuses it as empty (wrong server id, or a host
   *  without silent wakes that rejects empty pushes). */
  private emitSilentHeartbeat(reason: string, now: string, text: string): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlockedReason();
    if (blocked) { log(`suppressed heartbeat push/event — ${blocked}`); return false; }
    sendSilentWithFallback(
      (params) => conn.sendRequest(method.PUSH_EVENT, params),
      this.pushParams('heartbeat', { source: 'heartbeat', reason, silent: true, scheduledAt: now }, []),
      () => this.pushParams('heartbeat', { source: 'heartbeat', reason, silentFallback: true }, [{ type: 'text', text }]),
    )
      .then((outcome) => {
        this.silentFellBack = outcome.delivered === 'message';
        if (outcome.delivered === 'message' && !silentFallbackExplained) {
          silentFallbackExplained = true;
          log(`WARNING: the host refused the silent heartbeat as an empty push (${outcome.rejection}). `
            + 'Silent ticks are being delivered in message mode instead. Silent mode needs agent-framework >= 0.20.0 '
            + 'with this server configured under the id "heartbeat" (see README). Logged once per process.');
        }
        this.logPushResult(outcome.result, 'heartbeat');
      })
      .catch((e) => log('push failed (heartbeat):', (e as Error).message));
    return true;
  }

  private pushParams(kind: string, origin: Record<string, unknown>, content: Array<{ type: 'text'; text: string }>): PushEventParams {
    return {
      featureSet: FS_NAME,
      eventId: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      origin,
      payload: { content },
    };
  }

  private logPushResult(r: unknown, kind: string): void {
    // §9.3 result, or §6.6 rejection. Either is diagnostics: it is recorded
    // so a dropped wake is visible, and it changes no grant here — a
    // rejection never re-grants or re-negotiates anything (§6.6).
    const accepted = (r as { accepted?: unknown } | null)?.accepted;
    if (accepted === false) log(`push/event NOT accepted (${kind}):`, JSON.stringify(r));
    else log('push response:', JSON.stringify(r));
  }

  /** Shared push/event emission for both heartbeats and reminders. Push events
   *  that arrive while the agent is mid-inference are buffered host-side by the
   *  agent-framework gate (bufferForInference), so no server-side buffering is
   *  needed here — we just emit and let the host deliver when idle.
   *
   *  Gated on the capability grant: `pushEvents` is what a wake costs, and until
   *  the host has granted it the wake is dropped with a logged reason rather
   *  than sent hopefully (§5.3, §5.4). Dropping is loud on purpose — a silent
   *  drop is the failure this whole migration is about.
   *
   *  Returns whether the event actually went out, so callers do not log "fired"
   *  over a wake that was suppressed. `onSettled` hears what came of one that
   *  did: null when the host took it, or why it didn't arrive. */
  private emitPush(text: string, origin: Record<string, unknown>, kind: string, onSettled?: (refusal: string | null) => void): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlockedReason();
    if (blocked) { log(`suppressed ${kind} push/event — ${blocked}`); return false; }
    void sendPush(conn, this.pushParams(kind, origin, [{ type: 'text', text }])).then((outcome) => {
      if ('error' in outcome) log(`push failed (${kind}):`, outcome.error.message);
      else this.logPushResult(outcome.result, kind);
      onSettled?.(outcome.refusal);
    }).catch((e) => log(`handling the host's answer to a ${kind} push failed:`, e));
    return true;
  }

  // ── Reminders ──

  private addReminder(args: Record<string, unknown>, problems: string[]) {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (typeof args.message === 'string' && !message) problems.push('"message" is blank; give the text to deliver when it fires.');
    const delay = addUnits(args, DELAY_UNITS, problems);
    const every = addUnits(args, EVERY_UNITS, problems);
    if (every && every.seconds < MIN_REMINDER_SECONDS) {
      problems.push(`${givenText(every)} ${every.seconds} s, under the ${MIN_REMINDER_SECONDS}-second floor for a repeating reminder; `
        + `give ${MIN_REMINDER_SECONDS} seconds or more, or leave the interval out for a one-off.`);
    }
    const atIso = typeof args.atIso === 'string' ? args.atIso : null;
    if (atIso !== null && delay) problems.push(`"atIso" and the delay, ${givenList(delay)}, both set when it first fires; give one of them.`);
    const timeGiven = [...DELAY_UNITS, ...EVERY_UNITS].some(([name]) => Object.hasOwn(args, name)) || Object.hasOwn(args, 'atIso');
    if (!timeGiven) {
      problems.push('No time was given: give a delay in inSeconds, inMinutes or inHours, a time in atIso, '
        + 'or an interval to repeat in everySeconds, everyMinutes or everyHours.');
    }
    let at: number | null = null;
    if (atIso !== null) {
      try {
        at = parseReminderTime(atIso, AGENT_TIME_ZONE);
      } catch (error) {
        problems.push((error as Error).message);
      }
      // A past time is allowed: it fires on the next tick a wake can be delivered.
    }

    // The first fire: at the delay or atIso, else one interval out.
    const now = Date.now();
    const first = delay ? now + delay.seconds * 1000 : at ?? (every ? now + every.seconds * 1000 : null);
    // A delay or interval can reach past the last time a Date holds (atIso's
    // parser refuses its own). Refuse it before anything is saved: a time past
    // it can never fire, and listing it throws.
    const pastTheLastTime = (length: Length, which: string, remedy: string) =>
      `${givenText(length, ['puts', 'put'])} ${which} past ${LAST_REMINDER_TIME}, the last time a reminder can hold. ${remedy}`;
    if (first !== null && !canHoldTime(first)) {
      problems.push(delay
        ? pastTheLastTime(delay, every ? 'its first fire' : 'it', 'Give a shorter delay, or an atIso before then.')
        : pastTheLastTime(every!, 'its first fire', 'Give a shorter interval.'));
    } else if (first !== null && every && !canHoldTime(first + every.seconds * 1000)) {
      problems.push(pastTheLastTime(every, 'its second fire', 'Give a shorter interval.'));
    }
    if (problems.length > 0 || first === null) return this.refuse('reminder_add', problems);

    const rem: Reminder = {
      id: `rem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message,
      createdAt: now,
      fireAt: first,
      everySeconds: every?.seconds ?? null,
    };
    this.reminders.push(rem);
    saveReminders(this.reminders);
    this.retryRefused();
    log(`added reminder ${rem.id} fireAt=${new Date(first).toISOString()} every=${rem.everySeconds ?? 'once'}`);
    // A fire time the reminder won't keep would be a false success.
    const blocked = this.pushBlockedReason();
    return this.text(`Reminder ${rem.id} set: ${this.describeReminder(rem, now)}${blocked ? ` ${this.heldText(blocked, true)}` : ''}`);
  }

  /** Whether no wake can ever be delivered on this connection: an MCP-only
   *  host, or a pre-0.5 one. */
  private neverDelivers(): boolean {
    return !this.mcplEnabled || this.notificationOnly;
  }

  /** What a due reminder does while no wake can be delivered, for
   *  reminder_list (`one` false) and for the reminder reminder_add has just
   *  set (`one` true): it waits until one can, unless none ever can here. */
  private heldText(blocked: string, one: boolean): string {
    if (this.neverDelivers()) return `No wake can be delivered on this host: ${blocked}. ${one ? "It won't fire" : 'No reminder will fire'} here.`;
    return `No wake can be delivered now: ${blocked}. ${one ? 'It' : 'A reminder that falls due'} waits until one can.`;
  }

  private describeReminder(rem: Reminder, now: number): string {
    let when = this.inFlight.has(rem.id) ? "sent, waiting for the host's answer"
      : rem.fireAt <= now ? 'overdue' : `~${Math.round((rem.fireAt - now) / 1000)}s`;
    const refused = this.refused.get(rem.id);
    if (refused) when += `; ${refused.reason}, at ${formatAgentDateTime(refused.at, AGENT_TIME_ZONE)}`;
    const rec = rem.everySeconds !== null ? `repeats every ${rem.everySeconds}s` : 'one-shot';
    return `next ${formatAgentDateTime(rem.fireAt, AGENT_TIME_ZONE)} (${when}) | ${rec} | "${rem.message}"`;
  }

  private listRemindersText(): string {
    if (this.reminders.length === 0) return 'No reminders set.';
    const now = Date.now();
    const lines = [...this.reminders]
      .sort((a, b) => a.fireAt - b.fireAt)
      .map((r) => `${r.id} | ${this.describeReminder(r, now)}`);
    // While no wake can be delivered, say so and what that means for the
    // reminders, where the agent looks for them.
    const blocked = this.pushBlockedReason();
    const waiting = blocked ? `\n${this.heldText(blocked, false)}` : '';
    const refused = this.reminders.some((r) => this.refused.has(r.id))
      ? '\nA reminder whose push was refused or failed is tried again when the host next updates its settings, when a reminder is added or cancelled, or when the server restarts, and a recurring one also an interval after it was refused or failed.'
      : '';
    return `${this.reminders.length} reminder(s):\n${lines.join('\n')}${waiting}${refused}`;
  }

  private cancelReminder(args: Record<string, unknown>, problems: string[]) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (typeof args.id === 'string' && !id.trim()) problems.push('"id" is blank; give the reminder\'s id, as reminder_list shows it.');
    if (problems.length > 0) return this.refuse('reminder_cancel', problems);
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    if (this.reminders.length === before) return this.text(`No reminder with id ${id}.`);
    saveReminders(this.reminders);
    this.retryRefused();
    log(`cancelled reminder ${id}`);
    return this.text(`Cancelled ${id}. ${this.reminders.length} reminder(s) remain.`);
  }

  /** (Re)arm a single wake for the earliest due reminder. One wake covers all
   *  reminders; it re-arms after each fire, and each change of the host's
   *  policy re-arms it. A reminder fires only when its wake can be delivered:
   *  while something blocks it (an MCP-only or pre-0.5 host, no valid policy
   *  yet, a malformed one, or one that denies wakes), nothing is armed, and a due
   *  reminder waits, overdue, rather than being pushed into nothing and
   *  removed. It runs at start, at each policy update, add and cancel, after
   *  a fire, and when the host answers the push of a reminder still listed,
   *  never on a timer of its own, so its log line for held reminders comes
   *  once for each of those. */
  private scheduleReminders(): void {
    this.cancelReminderWake?.();
    this.cancelReminderWake = null;
    if (this.reminders.length === 0) return;
    const blocked = this.pushBlockedReason();
    if (blocked !== null) {
      log(`none of the ${this.reminders.length} reminder(s) `
        + `${this.neverDelivers() ? 'will fire on this host' : 'fires until a wake can be delivered'}: ${blocked}`);
      return;
    }
    const due = this.reminders.map((r) => this.dueAt(r)).filter((t): t is number => t !== null);
    if (due.length === 0) return;
    this.cancelReminderWake = callAt(Math.min(...due), () => this.processDueReminders());
  }

  /** A policy update, an add or a cancel: try each refused reminder again,
   *  then arm. A host that refuses again marks it again, so each trigger
   *  makes at most one try. A restart needs nothing here: no mark is saved. */
  private retryRefused(): void {
    this.refused.clear();
    this.scheduleReminders();
  }

  /** When a reminder may next be pushed, or null while it may not be. One in
   *  flight waits for the host's answer. One the host refused waits for the
   *  next retryRefused, so a host that keeps refusing isn't asked on every
   *  fire. A recurring one also comes due again an interval after the
   *  refusal, so a refusal that no policy update follows doesn't stop it, and
   *  a host that keeps refusing is asked again an interval after each refusal. */
  private dueAt(rem: Reminder): number | null {
    if (this.inFlight.has(rem.id)) return null;
    const refused = this.refused.get(rem.id);
    if (!refused) return rem.fireAt;
    return rem.everySeconds === null ? null : refused.at + rem.everySeconds * 1000;
  }

  /** Push every reminder that is due. Nothing about it changes until the host
   *  answers (settleReminder); meanwhile it is in flight. */
  private processDueReminders(): void {
    const now = Date.now();
    for (const rem of this.reminders.filter((r) => (this.dueAt(r) ?? Infinity) <= now)) this.fireReminder(rem);
    this.scheduleReminders();
  }

  private fireReminder(rem: Reminder): void {
    const sent = this.emitPush(
      formatReminderText(rem, new Date(), AGENT_TIME_ZONE),
      { source: 'reminder', reminderId: rem.id, recurring: rem.everySeconds !== null },
      'reminder',
      (refusal) => this.settleReminder(rem.id, refusal),
    );
    const kind = rem.everySeconds !== null ? 'recurring' : 'one-shot';
    if (sent) {
      // Sent again, it's no longer refused: the host's answer to this push
      // decides. One that isn't sent keeps its refusal, and waits as before.
      this.refused.delete(rem.id);
      this.inFlight.add(rem.id);
      log(`fired reminder ${rem.id} (${kind})`);
    } else {
      log(`reminder ${rem.id} (${kind}) not sent; it stays due`);
    }
  }

  /** The host's answer to a reminder's push decides what becomes of it. Taken:
   *  a one-shot is removed, and a recurring one advances to its next future
   *  time, or ends, logged whole, if that time is past the last a reminder can
   *  hold. Refused, or the push failed: it stays as it was, and is marked
   *  refused, which dueAt reads. Cancelled while its push was out: it stays
   *  gone, and nothing is re-armed, since the cancel was. Any other answer
   *  re-arms. */
  private settleReminder(id: string, refusal: string | null): void {
    this.inFlight.delete(id);
    const i = this.reminders.findIndex((r) => r.id === id);
    if (i === -1) return;
    const rem = this.reminders[i]!;
    if (refusal !== null) {
      this.refused.set(id, { at: Date.now(), reason: refusal });
      log(`reminder ${id}: ${refusal}; holding it until the next policy update, add, cancel or restart`
        + (rem.everySeconds === null ? '' : `, or for its interval, ${rem.everySeconds}s`));
    } else {
      if (rem.everySeconds === null) {
        this.reminders.splice(i, 1);
      } else {
        // Advance to the next future time. If we were behind (e.g. the server was
        // down through several intervals), skip ahead rather than firing a burst.
        const now = Date.now();
        let next = rem.fireAt + rem.everySeconds * 1000;
        if (next <= now) next = now + rem.everySeconds * 1000;
        // A next time past the last a Date holds could never fire, and listing
        // it would throw, so the reminder ends here. The log line keeps the
        // row, message and all, since this save leaves it out of the file.
        if (canHoldTime(next)) this.reminders[i] = { ...rem, fireAt: next };
        else {
          this.reminders.splice(i, 1);
          log(`ended recurring reminder ${JSON.stringify(rem)}: its next time, ${next}, is past ${LAST_REMINDER_TIME}, `
            + 'the last time a reminder can hold');
        }
      }
      saveReminders(this.reminders);
    }
    this.scheduleReminders();
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('Usage: heartbeat-mcpl --stdio'); process.exit(1); }
  log('starting on stdio; config=' + CONFIG_PATH + ' reminders=' + REMINDERS_PATH);
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await new HeartbeatServer().serve(conn);
}
main().catch((e) => { console.error('[heartbeat-mcpl] fatal:', e); process.exit(1); });
