const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function offsetMilliseconds(offset: string): number {
  if (/^(Z|GMT)$/i.test(offset)) return 0;
  const match = /^(?:GMT)?([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(offset);
  if (!match || +match[2] > 23 || +match[3] > 59 || +(match[4] ?? 0) > 59) {
    throw new Error(`Invalid UTC offset: ${offset}`);
  }
  return (match[1] === '-' ? -1 : 1)
    * (+match[2] * 3600 + +match[3] * 60 + +(match[4] ?? 0)) * 1000;
}

/** Read wall times in the agent zone, while explicit offsets name their own instant.
 *  A gap or repeated wall time requires the caller to choose a time or offset. */
export function parseReminderTime(atIso: string, timeZone: string): number {
  const invalid = `"atIso" is not a valid ISO-8601 timestamp: ${atIso}`;
  const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-][\d:]+)?)?$/.exec(atIso);
  if (!parts) throw new Error(invalid);
  // Parse the wall fields as UTC first. Unlike Date.UTC, this preserves years 0–99.
  const wall = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4] ?? '00'}:${parts[5] ?? '00'}:${parts[6] ?? '00'}.${(parts[7] ?? '0').slice(0, 3).padEnd(3, '0')}Z`);
  const date = new Date(wall);
  if (!Number.isFinite(wall) || date.getUTCFullYear() !== +parts[1]
    || date.getUTCMonth() + 1 !== +parts[2] || date.getUTCDate() !== +parts[3]) {
    throw new Error(invalid);
  }

  if (parts[8]) {
    const instant = wall - offsetMilliseconds(parts[8]);
    if (Math.abs(instant) > MAX_DATE_MS) throw new Error(invalid);
    return instant;
  }

  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const offsetAt = (ms: number) => {
    const name = formatter.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value;
    if (!name) throw new Error(`Cannot read the UTC offset for ${timeZone}.`);
    return { ms: offsetMilliseconds(name), label: name === 'GMT' ? '+00:00' : name.slice(3) };
  };

  // Offsets on either side cover ordinary times and both sides of a transition.
  // Validate each candidate at its own instant: a gap has none, a fold has two.
  const offsets = new Map<number, string>();
  for (const delta of [-DAY_MS, DAY_MS]) {
    const sample = Math.abs(wall + delta) <= MAX_DATE_MS ? wall + delta : wall;
    const offset = offsetAt(sample);
    offsets.set(offset.ms, offset.label);
  }
  const candidates = [...offsets].filter(([offset]) => {
    const instant = wall - offset;
    return Math.abs(instant) <= MAX_DATE_MS && offsetAt(instant).ms === offset;
  });
  if (candidates.length === 1) return wall - candidates[0][0];
  if (candidates.length > 1) {
    throw new Error(
      `"atIso" ${atIso} occurs twice in ${timeZone}. Include ${candidates.map(([, label]) => label).join(' or ')} to choose the intended instant.`,
    );
  }
  throw new Error(
    `"atIso" ${atIso} does not exist in ${timeZone}. Choose an existing local time or give an explicit UTC offset.`,
  );
}
