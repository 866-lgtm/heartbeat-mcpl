// readStored keeps a file the server can't use from being lost to a save: one
// that can't be read is left alone and marked unsaveable, and one that reads
// but isn't what the server writes is copied aside, named by its content,
// before anything saves over it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStored } from '../src/stored-file.js';

const copyOf = (path: string, text: string) => `${path}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

function fresh(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-stored-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'reminders.json');
}

test('no file is nothing stored yet, and a file the store writes is read', (t) => {
  const path = fresh(t);
  assert.deepEqual(readStored(path, 'reminders', Array.isArray), { value: undefined, unsaveable: null, note: null });
  writeFileSync(path, '[{"id":"rem_1"}]');
  assert.deepEqual(readStored(path, 'reminders', Array.isArray), { value: [{ id: 'rem_1' }], unsaveable: null, note: null });
});

test('a file that can\'t be read at all is left alone, and nothing may save over it', (t) => {
  const path = fresh(t);
  mkdirSync(path);
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.equal(stored.value, undefined);
  assert.match(String(stored.unsaveable), /^the reminders file .* couldn't be read \(EISDIR/);
  assert.match(String(stored.note), /; nothing is saved over it until a restart reads it again$/);
});

test('a file that isn\'t JSON, or isn\'t the shape its store writes, is copied aside with its mode, once', (t) => {
  for (const [text, unlike] of [['[{"id": "rem_1"', "isn't JSON"], ['{"id": "rem_1"}', "isn't what this server writes"]]) {
    const path = fresh(t);
    writeFileSync(path, text, { mode: 0o600 });
    const copy = copyOf(path, text);
    const stored = readStored(path, 'reminders', Array.isArray);
    assert.deepEqual(stored, { value: undefined, unsaveable: null, note: `the reminders file ${path} ${unlike}; copied it to ${copy}, and starting without it` });
    assert.equal(readFileSync(copy, 'utf8'), text);
    assert.equal(statSync(copy).mode & 0o777, 0o600, 'no more open than the file it copies');
    assert.equal(readFileSync(path, 'utf8'), text, 'the file itself is left for the next save');
    // Starting on the same content again keeps the one copy.
    assert.equal(readStored(path, 'reminders', Array.isArray).unsaveable, null);
  }
});

test('a file whose copy can\'t be made is kept as one that can\'t be read is', (t) => {
  const path = fresh(t);
  writeFileSync(path, 'not json');
  mkdirSync(copyOf(path, 'not json'));
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.equal(stored.value, undefined);
  assert.match(String(stored.unsaveable), /isn't JSON, and copying it to .* failed/);
  assert.equal(existsSync(path) && readFileSync(path, 'utf8'), 'not json');
});
