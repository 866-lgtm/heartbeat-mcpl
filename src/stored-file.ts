/**
 * Reading the server's two small JSON files, the config and the reminders, so
 * that no save loses one it can't use, and the texts a reply adds when a store
 * can't stand behind what it shows.
 *
 * - No file: nothing is stored yet.
 * - A file that can't be read at all (EACCES, EIO, EISDIR…) says nothing about
 *   its content, so it stays as it is, and nothing saves over it until a
 *   restart reads it again. The server runs on what it holds in memory
 *   meanwhile.
 * - A file that reads but isn't what the server writes (not UTF-8, not JSON,
 *   or not the shape its store writes) is copied aside first, to
 *   `<file>.unreadable-<hash>`, named by its bytes so that starting on the
 *   same file again keeps one copy. The store then starts without it, and its
 *   next save writes over the file. A store that can load only part of a
 *   file keeps a copy of it the same way (keepAside) and starts with the
 *   rest. When the copy fails, the file is kept as one that can't be read is.
 *
 * Saves write the file in place, so it keeps its mode, owner, group and
 * links. A crash during a save can tear the file; the next start then copies
 * the torn file aside.
 */
import { copyFileSync, constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** What a stored file gave its store. `value` is its parsed content when that
 *  is what the store writes, and undefined otherwise; `bytes` is what the
 *  file held, whenever it could be read, so with every `value`. `unused` says
 *  there was a file whose content the store starts without. `unsaveable`,
 *  when set, says why nothing may be saved over the file until a restart
 *  reads it again. `note` is the log line for whoever runs the host, when
 *  there is one. */
export interface Stored { value: unknown; bytes: Buffer | null; unused: boolean; unsaveable: string | null; note: string | null; }

/** UTF-8, with no byte that isn't. A byte order mark at the start, which an
 *  editor may add, carries nothing, so it's read past, and the next save
 *  leaves it out. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** What keeping a file aside left: why nothing may be saved over it, if the
 *  copy failed, and the log line. */
export interface KeptAside { unsaveable: string | null; note: string; }

/** Read `path`, the `what` file, whose store writes what `isWritten` accepts. */
export function readStored(path: string, what: string, isWritten: (value: unknown) => boolean): Stored {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: undefined, bytes: null, unused: false, unsaveable: null, note: null };
    const unsaveable = `the ${what} file ${path} couldn't be read (${(e as Error).message})`;
    return { value: undefined, bytes: null, unused: true, unsaveable, note: `${unsaveable}; nothing is saved over it until a restart reads it again` };
  }
  // The server writes UTF-8, so a file that isn't, by even one byte, is
  // copied aside, rather than read with replacement characters that the next
  // save would write over those bytes.
  let text: string | undefined;
  try { text = UTF8.decode(bytes); } catch { /* isn't UTF-8 */ }
  let value: unknown;
  let parsed = text !== undefined;
  if (text !== undefined) {
    try { value = JSON.parse(text); } catch { parsed = false; }
  }
  if (parsed && isWritten(value)) return { value, bytes, unused: false, unsaveable: null, note: null };
  const unlike = text === undefined ? `isn't UTF-8` : parsed ? `isn't what this server writes` : `isn't JSON`;
  return { value: undefined, bytes, unused: true, ...keepAside(path, what, bytes, unlike, 'starting without it') };
}

/** Copy `path`, the `what` file, which held `bytes`, aside before anything
 *  saves over it: `why` says what's wrong with it, and `then` what its store
 *  does next. When the copy fails, nothing may save over the file. */
export function keepAside(path: string, what: string, bytes: Buffer, why: string, then: string): KeptAside {
  const copy = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  try {
    copyAside(path, copy, bytes);
  } catch (e) {
    const unsaveable = `the ${what} file ${path} ${why}, and copying it to ${copy} failed (${(e as Error).message})`;
    return { unsaveable, note: `${unsaveable}; nothing is saved over it until a restart reads it again` };
  }
  return { unsaveable: null, note: `the ${what} file ${path} ${why}; copied it to ${copy}, and ${then}` };
}

/** Copy `path` to `copy` with its mode, unless `copy` already holds `bytes`,
 *  as it does when a start before this one copied the same file aside. */
function copyAside(path: string, copy: string, bytes: Buffer): void {
  try {
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!readFileSync(copy).equals(bytes)) throw new Error(`${copy} already exists and holds something else`);
  }
}

/** What a reply adds when the change it made can't be saved, since saving
 *  would write over a file whose content is on disk nowhere else. */
export function unsavedNote(what: string): string {
  return `This change can't be saved, because saving would write over a ${what} file this server couldn't read or copy, `
    + "so it won't last past a restart. Calling again won't change that; ask whoever runs this host if you need it kept.";
}

/** What a reply that shows or counts the reminders adds when this start
 *  couldn't load the reminders saved before it: `all` of them, or only some. */
export function remindersNotLoadedNote(all: boolean): string {
  return all ? "The reminders file couldn't be used at start, so reminders saved before then aren't loaded; ask whoever runs this host."
    : "Some reminders saved before this start couldn't be loaded; ask whoever runs this host.";
}

/** What a reply that shows the schedule adds when this start couldn't load
 *  the config. A change since then shows as made, so the schedule shown
 *  started from the default. */
export const CONFIG_NOT_LOADED = "The config file couldn't be used at start, so the schedule shown started from the default, "
  + 'not from what was saved; ask whoever runs this host.';

/** What a reply adds when writing its change failed. The change holds in
 *  memory. A save writes the file in place, so a write that fails partway may
 *  have emptied it of what was saved before too; a later save that goes
 *  through writes everything again. */
export function failedSaveNote(what: string): string {
  return `This change wasn't saved, because writing the ${what} file failed, so as things stand it won't last past a restart, `
    + 'and the failed write may also have left the file missing what was saved before. A later save of that file that goes through '
    + 'saves everything again; if it keeps happening, ask whoever runs this host.';
}
