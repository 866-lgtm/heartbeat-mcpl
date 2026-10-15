import { andList } from './arguments.js';

/** What the agent reads when a tools/call names no tool here: nothing ran,
 *  and these are the tools there are. */
export function noSuchTool(name: unknown, tools: readonly string[]): string {
  const named = typeof name === 'string' ? `There's no tool named ${JSON.stringify(name)} here` : "The call doesn't name a tool";
  return `${named}, so nothing ran. heartbeat-mcpl's tools are ${andList(tools)}.`;
}

/** What the agent reads when a tool threw. It may have changed something
 *  first, so the agent looks before it calls again; a fault that comes back
 *  isn't one the agent can fix. Anything can be thrown, not only an Error. */
export function toolThrew(name: unknown, thrown: unknown): string {
  const what = thrown instanceof Error ? thrown.message : String(thrown);
  return `${typeof name === 'string' ? name : 'The tool'} failed inside heartbeat-mcpl: ${what.replace(/\.$/, '')}. `
    + 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again. '
    + "If it fails the same way again, calling won't fix it; ask whoever runs this host.";
}
