/**
 * Reading the server's two small JSON files, the config and the reminders, so
 * that no save loses one it can't use.
 *
 * - No file: nothing is stored yet.
 * - A file that can't be read at all (EACCES, EIO, EISDIR…) says nothing about
 *   its content, so it stays as it is, and nothing saves over it until a
 *   restart reads it again. The server runs on what it holds in memory
 *   meanwhile.
 * - A file that reads but isn't what the server writes (not JSON, or not the
 *   shape its store writes) is copied aside first, to
 *   `<file>.unreadable-<hash>`, named by its content so that starting on the
 *   same content again keeps one copy. The store then starts without it, and
 *   its next save writes over the file. When the copy fails, the file is kept
 *   as one that can't be read is.
 *
 * Saves write the file in place, so it keeps its mode, owner, group and
 * links. A crash during a save can tear the file; the next start then copies
 * the torn file aside.
 */
import { copyFileSync, constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** What a stored file gave its store. `value` is its parsed content when that
 *  is what the store writes, and undefined otherwise. `unsaveable`, when set,
 *  says why nothing may be saved over the file until a restart reads it
 *  again. `note` is the log line for whoever runs the host, when there is one. */
export interface Stored { value: unknown; unsaveable: string | null; note: string | null; }

/** Read `path`, the `what` file, whose store writes what `isWritten` accepts. */
export function readStored(path: string, what: string, isWritten: (value: unknown) => boolean): Stored {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: undefined, unsaveable: null, note: null };
    const unsaveable = `the ${what} file ${path} couldn't be read (${(e as Error).message})`;
    return { value: undefined, unsaveable, note: `${unsaveable}; nothing is saved over it until a restart reads it again` };
  }
  let value: unknown;
  let parsed = true;
  try { value = JSON.parse(text); } catch { parsed = false; }
  if (parsed && isWritten(value)) return { value, unsaveable: null, note: null };
  const unlike = parsed ? `isn't what this server writes` : `isn't JSON`;
  const copy = `${path}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  try {
    copyAside(path, copy, text);
  } catch (e) {
    const unsaveable = `the ${what} file ${path} ${unlike}, and copying it to ${copy} failed (${(e as Error).message})`;
    return { value: undefined, unsaveable, note: `${unsaveable}; nothing is saved over it until a restart reads it again` };
  }
  return { value: undefined, unsaveable: null, note: `the ${what} file ${path} ${unlike}; copied it to ${copy}, and starting without it` };
}

/** Copy `path` to `copy` with its mode, unless `copy` already holds `text`,
 *  as it does when a start before this one copied the same content aside. */
function copyAside(path: string, copy: string, text: string): void {
  try {
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (readFileSync(copy, 'utf8') !== text) throw new Error(`${copy} already exists and holds something else`);
  }
}

/** What a reply says when the change it made can't be saved. */
export function unsavedNote(what: string): string {
  return `This change can't be saved, because the ${what} file can't be used, so it won't last past a restart. `
    + "Calling again won't change that; ask whoever runs this host if you need it kept.";
}
