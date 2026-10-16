import { andList } from './arguments.js';

/** What the agent reads when a tools/call names no tool here: nothing ran,
 *  and these are the tools there are. */
export function noSuchTool(name: unknown, tools: readonly string[]): string {
  const named = typeof name === 'string' ? `There's no tool named ${JSON.stringify(name)} here`
    : name === undefined ? "The call doesn't name a tool"
    : `The call gives ${JSON.stringify(name)} as its tool's name, and a tool's name is a string`;
  return `${named}, so nothing ran. heartbeat-mcpl's tools are ${andList(tools)}.`;
}

/** A thrown value as text. Anything can be thrown, not only an Error, and this
 *  runs where a call is answered, so it never throws itself. */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  try {
    return (typeof thrown === 'object' && thrown !== null ? JSON.stringify(thrown) : undefined) ?? String(thrown);
  } catch {
    return 'a value that can\'t be shown as text';
  }
}

/** What the agent reads when a tool threw. It may have changed something
 *  first, so the agent looks before it calls again; a fault that comes back
 *  is for whoever runs the host. */
export function toolThrew(name: unknown, thrown: unknown): string {
  return `${typeof name === 'string' ? name : 'The tool'} failed inside heartbeat-mcpl: ${describeThrown(thrown).replace(/\.$/, '')}. `
    + 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again. '
    + 'If it fails the same way again, ask whoever runs this host.';
}
