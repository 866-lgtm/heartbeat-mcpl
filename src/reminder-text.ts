/** Agent-visible text of a fired reminder. */
import { formatAgentDateTime } from './timezone.js';

export interface FiredReminder {
  id: string;
  message: string;
  createdAt: number; // epoch ms
  fireAt: number; // epoch ms: when it was due
  everySeconds: number | null; // null = one-shot
}

/** How late a reminder fires before its header says when it was due. */
const LATE_MS = 60_000;

/** A time `formatAgentDateTime` can render. A hand-edited reminders file can
 *  hold a number outside the Date range, and formatting it would throw inside
 *  the reminder timer. */
function isRenderableTime(ms: number): boolean {
  return !Number.isNaN(new Date(ms).getTime());
}

/** The reminder's own message behind a header that says it is a reminder, which
 *  one, and the time, the way a heartbeat tick carries `[current time: …]`.
 *
 *  Hosts store push content as-is, so without the header a fired reminder
 *  reaches the agent as unattributed text. A message that opens `Name: …`
 *  then reads like a chat line from that person, and the agent has no clock
 *  reading for the wake.
 *
 *  A one-shot names when it was set, because its message was written then and
 *  often counts from then ("in two days", "you said this morning"). A recurring
 *  reminder names its interval instead. A reminder that fires a minute or more
 *  after it was due, having waited for the server to come back or for the host
 *  to allow wakes, names when it was due. */
export function formatReminderText(rem: FiredReminder, now: Date | number, timeZone: string): string {
  let schedule = '';
  if (rem.everySeconds !== null) schedule = `, repeats every ${rem.everySeconds}s`;
  else if (isRenderableTime(rem.createdAt)) schedule = `, set ${formatAgentDateTime(rem.createdAt, timeZone)}`;
  if (+now - rem.fireAt >= LATE_MS && isRenderableTime(rem.fireAt)) schedule += `, due ${formatAgentDateTime(rem.fireAt, timeZone)}`;
  return `[reminder ${rem.id}${schedule} · current time: ${formatAgentDateTime(now, timeZone)}] ${rem.message}`;
}
