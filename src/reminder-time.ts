import { Temporal } from '@js-temporal/polyfill';

/** Read wall times in the agent zone, while explicit offsets name their own instant.
 *  A gap or repeated wall time requires the caller to choose a time or offset. */
export function parseReminderTime(atIso: string, timeZone: string): number {
  let earlier: Temporal.ZonedDateTime;
  let later: Temporal.ZonedDateTime;
  try {
    const zonedInput = `${atIso}[${timeZone}]`;
    earlier = Temporal.ZonedDateTime.from(zonedInput, { offset: 'use', disambiguation: 'earlier' });
    later = Temporal.ZonedDateTime.from(zonedInput, { offset: 'use', disambiguation: 'later' });
  } catch {
    throw new Error(`"atIso" is not a valid ISO-8601 timestamp: ${atIso}`);
  }

  if (earlier.epochMilliseconds === later.epochMilliseconds) return earlier.epochMilliseconds;

  const requested = Temporal.PlainDateTime.from(atIso);
  if (earlier.toPlainDateTime().equals(requested)) {
    throw new Error(
      `"atIso" ${atIso} occurs twice in ${timeZone}. Include ${earlier.offset} or ${later.offset} to choose the intended instant.`,
    );
  }
  throw new Error(
    `"atIso" ${atIso} does not exist in ${timeZone}. Choose an existing local time or give an explicit UTC offset.`,
  );
}
