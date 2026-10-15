/** A tool call's arguments, checked against the tool's input schema, so that
 *  every argument an agent sends is applied, or the call is refused and says
 *  why. Each tool then checks what its schema can't say: ranges, floors and
 *  arguments that contradict each other. */

/** What a tool's input schema declares about one argument. */
export interface ArgumentSchema {
  type: 'number' | 'boolean' | 'string';
  enum?: readonly string[];
  description: string;
}

/** The part of a tool definition the check reads. */
export interface ToolSchema {
  name: string;
  inputSchema: { properties: Record<string, ArgumentSchema>; required?: readonly string[] };
}

export interface ArgumentCheck {
  /** One sentence per argument that can't be applied, saying what to give instead. */
  problems: string[];
  /** Keys that no tool here takes and that look like no argument this one
   *  takes. They did nothing before and do nothing now, so the call goes on
   *  without them, and its result names them. */
  ignored: string[];
}

/** Check `args` against `tool`'s schema. A key the tool doesn't take is a
 *  problem when it is a near miss of one it does, or an argument another of
 *  `tools` takes, since either way the agent believes the call did something
 *  it didn't. Any other key is ignored, unless every key sent is one, since
 *  a call to a tool that takes arguments then can only have meant something
 *  it didn't do. */
export function checkArguments(tool: ToolSchema, args: unknown, tools: readonly ToolSchema[]): ArgumentCheck {
  const problems: string[] = [];
  const ignored: string[] = [];
  const { properties, required = [] } = tool.inputSchema;
  const names = Object.keys(properties);
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    problems.push(`Its arguments are ${describeValue(args)}; give an object of named arguments${names.length ? `, such as {"${names[0]}": …}` : ', or none'}.`);
    return { problems, ignored };
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) {
      const near = closestNames(key, names);
      const owner = tools.find((other) => other !== tool && Object.hasOwn(other.inputSchema.properties, key));
      if (near.length === 0 && !owner) {
        ignored.push(key);
      } else if (owner) {
        problems.push(`"${key}" is ${owner.name}'s argument, not ${tool.name}'s; `
          + (near.length ? `the closest ${tool.name} takes is ${orList(near)}.` : `${takes(tool, tool.name)}.`));
      } else {
        problems.push(`"${key}" isn't an argument ${tool.name} takes; the closest is ${orList(near)}.`);
      }
      continue;
    }
    const schema = properties[key];
    if (typeof value !== schema.type) {
      problems.push(`"${key}" is ${describeValue(value)}; give ${wanted(schema, value)}.`);
    } else if (schema.enum && !schema.enum.includes(value as string)) {
      problems.push(`"${key}" ${JSON.stringify(value)} isn't one ${tool.name} takes; give ${orList(schema.enum)}.`);
    }
  }
  if (ignored.length > 0 && ignored.length === Object.keys(args).length && names.length > 0) {
    problems.unshift(`It doesn't take ${andList(ignored)}; ${takes(tool)}.`);
    ignored.length = 0;
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) problems.push(`"${key}" is missing: ${firstSentence(properties[key].description)}`);
  }
  return { problems, ignored };
}

/** The sentence a result ends with when it went on without some keys. */
export function ignoredNote(tool: ToolSchema, ignored: readonly string[]): string {
  return `${tool.name} ignored ${andList(ignored)}, which it doesn't take; ${takes(tool)}.`;
}

/** "it takes a, b and c", or that it takes none. */
function takes(tool: ToolSchema, subject = 'it'): string {
  const names = Object.keys(tool.inputSchema.properties);
  return names.length ? `${subject} takes ${andList(names)}` : `${subject} takes no arguments`;
}

/** What to give instead of `value`: for text that reads as the type wanted,
 *  the value to copy. */
function wanted(schema: ArgumentSchema, value: unknown): string {
  if (schema.type === 'number') {
    const n = typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? `it as a number: ${n}` : 'a number';
  }
  if (schema.type === 'boolean') {
    return value === 'true' || value === 'false' ? `it as true or false, without quotes: ${value}` : 'true or false';
  }
  return schema.enum ? orList(schema.enum) : 'text, as a string';
}

/** A value as an agent would recognize what it sent. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (typeof value === 'number') return `the number ${value}`;
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : String(value);
}

function firstSentence(description: string): string {
  const sentence = /^[^.]*\./.exec(description)?.[0] ?? description;
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

export function andList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

export function orList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/** A length given in units that add up: each argument given with its value,
 *  and the total in whole seconds. */
export interface Length { given: Array<[string, number]>; seconds: number; }

/** Add up the units of `units` ([argument, seconds per unit]) given in `args`.
 *  Null when none is given, or when one is negative, which is then a problem.
 *  A total too large for a number is Infinity, for the caller's range check. */
export function addUnits(
  args: Record<string, unknown>, units: ReadonlyArray<readonly [string, number]>, problems: string[],
): Length | null {
  const given: Array<[string, number]> = [];
  let seconds = 0;
  let negative = false;
  for (const [name, perUnit] of units) {
    const value = args[name];
    if (typeof value !== 'number') continue; // absent, or the wrong type, which the schema check named
    if (value < 0) {
      problems.push(`"${name}" ${value} is negative; give 0 or more.`);
      negative = true;
    }
    given.push([name, value]);
    seconds += value * perUnit;
  }
  return given.length && !negative ? { given, seconds: Math.round(seconds) } : null;
}

/** `"inHours" 1 and "inMinutes" 30`, as the agent gave them. */
export function givenList(length: Length): string {
  const parts = length.given.map(([name, value]) => `"${name}" ${value}`);
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `"inHours" 1 and "inMinutes" 30 add up to`, or `"inMinutes" 90 is`. */
export function givenText(length: Length, verbs: [one: string, several: string] = ['is', 'add up to']): string {
  return `${givenList(length)} ${length.given.length < 2 ? verbs[0] : verbs[1]}`;
}

/**
 * The names someone most likely meant, when the one they gave matches none,
 * ranked as agent-framework's closest-names helper ranks them, so the house's
 * refusals agree on what counts as a near miss. Case is ignored. A candidate
 * that starts with the name or that it starts with, then one that contains it
 * or that it contains, ranks ahead of one that is only a few edits away. The
 * prefix and substring matches need three characters on the shorter side.
 * Past the edits a slip allows, a candidate is noise, so a name close to
 * nothing gets nothing back.
 */
export function closestNames(name: string, candidates: readonly string[], max = 2): string[] {
  const wanted = name.toLowerCase();
  const ranked: { candidate: string; tier: number; distance: number }[] = [];
  for (const candidate of new Set(candidates)) {
    const other = candidate.toLowerCase();
    const shorter = Math.min(wanted.length, other.length);
    const tier = other === wanted ? 0
      : shorter >= 3 && (other.startsWith(wanted) || wanted.startsWith(other)) ? 1
      : shorter >= 3 && (other.includes(wanted) || wanted.includes(other)) ? 2
      : 3;
    const limit = tier === 3 ? noiseLimit(wanted, other) : Infinity;
    const distance = editDistance(wanted, other, limit);
    if (distance > limit) continue;
    ranked.push({ candidate, tier, distance });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance);
  return ranked.slice(0, Math.max(0, max)).map((entry) => entry.candidate);
}

/** The most edits that still read as a slip: a quarter of what follows the
 *  prefix the two names share, and at least one. */
function noiseLimit(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return Math.max(1, Math.floor((Math.max(a.length, b.length) - shared) / 4));
}

/** Edits between two strings, with a swap of neighbours counting as one
 *  (optimal string alignment). Past `limit`, it answers `limit + 1`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}
