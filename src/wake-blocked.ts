import type { FeatureSetState } from './mcpl05.js';

/** Why a wake can't be delivered: `log` in the protocol's terms, for whoever
 *  runs the host, and `reason` and `remedy` in plain words, for the agent,
 *  who can't see the host's settings or act on its spec sections. `final`
 *  when no wake will come on this connection from a host like this one: a
 *  host that has gone, an MCP-only host, one that has sent its policy only as
 *  a Notification, a form older than MCPL 0.5, or a malformed declaration of
 *  this server's own. A host that sends a Request after all speaks 0.5, and
 *  its policy then decides, as any host's does. */
export interface WakeBlocked { log: string; reason: string; remedy: string; final: boolean; }

const ASK_FOR_WAKES = "Calling again won't change that; ask whoever runs this host if you need wakes.";

/** The host has gone. Nothing more reaches this connection, so no agent reads
 *  `reason` or `remedy`; the log line is what says it. */
export const HOST_GONE: WakeBlocked = {
  log: 'the connection to the host has closed',
  reason: 'the host has disconnected',
  remedy: "Calling again won't change that.",
  final: true,
};

/** Why a wake can't be delivered right now, or null when it can.
 *  `notificationOnly`: the host has sent its policy only as a Notification,
 *  with no Request, as a pre-0.5 host does. `state` is read only once the
 *  host's policy has arrived. */
export function wakeBlocked(
  mcplEnabled: boolean,
  notificationOnly: boolean,
  policyReady: boolean,
  state: () => FeatureSetState,
  featureSet: string,
): WakeBlocked | null {
  if (!mcplEnabled) {
    return {
      log: 'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)',
      reason: "the host doesn't support the push events wakes need",
      remedy: ASK_FOR_WAKES,
      final: true,
    };
  }
  if (notificationOnly) {
    return {
      log: 'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
        + 'so no wake is delivered on this connection',
      reason: 'the host set this server up in an older form that can\'t turn wakes on',
      remedy: ASK_FOR_WAKES,
      final: true,
    };
  }
  if (!policyReady) {
    return {
      log: 'no valid featureSets/update Request in force (none yet, or the last was malformed); '
        + 'capability-dependent behavior is unavailable until one arrives (§5.3)',
      reason: "the host hasn't finished setting this server up, or its last settings message was malformed",
      remedy: 'Try again shortly; if it persists, ask whoever runs this host.',
      final: false,
    };
  }
  const current = state();
  if (current.active) return null;
  switch (current.reason) {
    case 'capability_denied':
      return {
        log: `capability not granted: ${current.missing.join(', ')} (§5.4 — absence is denial)`,
        reason: "the host hasn't granted this server what its wakes need",
        remedy: ASK_FOR_WAKES,
        final: false,
      };
    case 'host_disabled':
      return {
        log: `feature set "${featureSet}" is host_disabled`,
        reason: 'the host has turned heartbeat off for this server',
        remedy: ASK_FOR_WAKES,
        final: false,
      };
    case 'not_enabled':
      return {
        log: `feature set "${featureSet}" is not_enabled`,
        reason: "the host hasn't enabled heartbeat for this server",
        remedy: ASK_FOR_WAKES,
        final: false,
      };
    default:
      return {
        log: `feature set "${featureSet}" is ${current.reason ?? 'invalid_uses'}`,
        reason: "this server's own heartbeat declaration is malformed",
        remedy: "Calling again won't change that; ask whoever runs this host to report it to heartbeat-mcpl's maintainers.",
        final: true,
      };
  }
}

/** What a due reminder does while no wake can be delivered, for reminder_list
 *  (`one` false) and for the reminder reminder_add has just set (`one` true).
 *  It waits until a wake can be delivered, unless none will come here. */
export function heldNote(blocked: WakeBlocked, one: boolean): string {
  if (blocked.final) {
    return `No wake can be delivered on this host, because ${blocked.reason}, `
      + `so ${one ? "it won't fire" : 'no reminder will fire'} here. ${blocked.remedy}`;
  }
  return `No wake can be delivered now, because ${blocked.reason}`
    + (one ? ', so it waits until one can.' : '. A reminder that falls due waits until one can.')
    + " If that doesn't change, ask whoever runs this host.";
}
