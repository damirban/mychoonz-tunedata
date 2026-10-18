// Tests for the build, on a small made-up dump with the same tables and
// columns as The Session's. Every tune, name and ABC here is invented: no
// data from The Session goes into these tests.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { build, buildAll, fold, BuildError, SCHEMA_VERSION } = require('../src/build');

const COLUMNS = {
  tunes: ['tune_id', 'setting_id', 'name', 'type', 'meter', 'mode', 'abc', 'date', 'username', 'composer'],
  aliases: ['tune_id', 'alias', 'name'],
  tune_popularity: ['name', 'tune_id', 'tunebooks'],
  sets: ['tuneset', 'date', 'member_id', 'username', 'settingorder', 'name', 'tune_id', 'setting_id',
    'type', 'meter', 'mode', 'abc'],
  recordings: ['id', 'artist', 'recording', 'track', 'number', 'tune', 'tune_id'],
  sessions: ['id', 'name', 'address', 'town', 'area', 'country', 'latitude', 'longitude', 'date'],
  events: ['id', 'event', 'dtstart', 'dtend', 'venue', 'address', 'town', 'area', 'country', 'latitude', 'longitude'],
};

const ABC1 = 'X:1\nM:4/4\nL:1/8\nK:D\n|:A2FA DAFA|B2GB DBGB:|';
const ABC2 = 'X:1\nM:6/8\nL:1/8\nK:G\n|:GAB c2A|BAG E3:|';

/** A made-up dump in the dump's layout: every column TEXT. */
function baseRows() {
  return {
    tunes: [
      // tune_id, setting_id, name, type, meter, mode, abc, date, username, composer
      ['1', '11', 'Copper Kettle, The', 'reel', '4/4', 'Dmajor', ABC1, '2001-01-01 10:00:00', 'piper', ''],
      ['1', '12', 'Copper Kettle, The', 'reel', '4/4', 'Dmajor', ABC1 + 'x', '2002-02-02 10:00:00', 'fiddler', 'A. Maker'],
      ['2', '21', 'Cailín na Spéire', 'jig', '6/8', 'Gmajor', ABC2, '2003-03-03 10:00:00', 'piper', ''],
      ['3', '31', 'Banjo Breakdown', 'reel', '4/4', 'Gmajor', ABC1, '2004-04-04 10:00:00', 'picker', ''],
      // A setting listed twice, as in the real dump.
      ['3', '31', 'Banjo Breakdown', 'reel', '4/4', 'Gmajor', ABC1, '2004-04-04 10:00:00', 'picker', ''],
    ],
    aliases: [
      ['1', 'Tin Kettle, The', 'Copper Kettle, The'],
      ['1', 'Tin Kettle, The', 'Copper Kettle, The'],
      ['2', 'Sky Girl', 'Cailín na Spéire'],
      ['99', 'Nobody Knows', 'Missing'],
    ],
    tune_popularity: [
      ['The Copper Kettle', '1', '250'],
      ['Banjo Breakdown', '3', '12'],
      ['Missing', '99', '40'],
    ],
    sets: [
      // tuneset, date, member_id, username, settingorder, name, tune_id, setting_id, type, meter, mode, abc
      ['500', '2010-05-05 10:00:00', '7', 'player7', '1', 'The Copper Kettle', '1', '12', 'reel', '4/4', 'Dmajor', ABC1],
      ['500', '2010-05-05 10:00:00', '7', 'player7', '2', 'Banjo Breakdown', '3', '31', 'reel', '4/4', 'Gmajor', ABC1],
      ['501', '2011-06-06 10:00:00', '8', 'player8', '1', 'Cailín na Spéire', '2', '21', 'jig', '6/8', 'Gmajor', ABC2],
      ['501', '2011-06-06 10:00:00', '8', 'player8', '2', 'Gone Tune', '98', '981', 'jig', '6/8', 'Gmajor', ABC2],
    ],
    recordings: [
      // id, artist, recording, track, number, tune, tune_id
      ['900', 'The Made-Up Band', 'First Album', '1', '1', 'Copper Kettle, The', '1'],
      ['900', 'The Made-Up Band', 'First Album', '1', '2', 'Banjo Breakdown', '3'],
      ['900', 'The Made-Up Band', 'First Album', '2', '1', 'Some Unknown Air', ''],
      ['901', 'A Duo', 'Second Album', '1', '1', 'Cailín na Spéire', '2'],
    ],
    sessions: [['1', 'A Session', '1 Street', 'Town', 'Area', 'Country', '1.0', '2.0', '2001-01-01']],
    events: [['1', 'An Event', '2001-01-01', '2001-01-02', 'Hall', '1 Street', 'Town', 'Area', 'Country', '1.0', '2.0']],
  };
}

function makeDump(dir, rows = baseRows(), columns = COLUMNS) {
  const file = path.join(dir, 'dump.db');
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  for (const [table, cols] of Object.entries(columns)) {
    db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${c} TEXT`).join(', ')})`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => '?').join(', ')})`);
    for (const r of rows[table] || []) insert.run(...r);
  }
  db.close();
  return file;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunedata-'));
}

function buildFrom(rows, columns) {
  const dir = tmp();
  const input = makeDump(dir, rows, columns);
  const output = path.join(dir, 'tunedata.db');
  const report = build({ input, output, dumpCommit: 'abc123', dumpDate: '2026-10-18T12:00:00Z' });
  return { report, db: new DatabaseSync(output, { readOnly: true }), dir };
}

const all = (db, sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));

test('tunes take name, type and composer from their settings; IDs are integers', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT id, name, type, composer, settings FROM tunes ORDER BY id'), [
    { id: 1, name: 'The Copper Kettle', type: 'reel', composer: 'A. Maker', settings: 2 },
    { id: 2, name: 'Cailín na Spéire', type: 'jig', composer: null, settings: 1 },
    { id: 3, name: 'Banjo Breakdown', type: 'reel', composer: null, settings: 1 },
  ]);
  assert.strictEqual(db.prepare("SELECT typeof(id) AS t FROM settings LIMIT 1").get().t, 'integer');
  assert.strictEqual(report.counts.tunes, 3);
});

test('a trailing ", The" moves to the front of names, aliases and track names; other articles stay', () => {
  const rows = baseRows();
  rows.tunes.push(['4', '41', 'Danse, La', 'waltz', '3/4', 'Dmajor', ABC1, '', 'x', '']);
  const { db } = buildFrom(rows);
  assert.strictEqual(db.prepare('SELECT name FROM tunes WHERE id = 1').get().name, 'The Copper Kettle');
  assert.strictEqual(db.prepare('SELECT name FROM tunes WHERE id = 4').get().name, 'Danse, La');
  assert.strictEqual(db.prepare('SELECT alias FROM aliases WHERE tune_id = 1').get().alias, 'The Tin Kettle');
  assert.strictEqual(
    db.prepare('SELECT tune_name FROM recording_tracks WHERE recording_id = 900 AND track = 1 AND number = 1').get().tune_name,
    'The Copper Kettle',
  );
});

test('a setting listed twice is kept once', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT id, tune_id FROM settings ORDER BY id').map((r) => r.id), [11, 12, 21, 31]);
  assert.strictEqual(report.dropped.duplicateSettings, 1);
  assert.strictEqual(report.dropped.duplicateSettingsThatDiffer, 0);
});

test('aliases: repeats are dropped, and aliases of unknown tunes are counted', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT tune_id, alias FROM aliases ORDER BY tune_id'), [
    { tune_id: 1, alias: 'The Tin Kettle' },
    { tune_id: 2, alias: 'Sky Girl' },
  ]);
  assert.strictEqual(report.dropped.aliasesForUnknownTunes, 1);
});

test('popularity is the tunebooks count on each tune, 0 when not listed', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT id, tunebooks FROM tunes ORDER BY id'), [
    { id: 1, tunebooks: 250 }, { id: 2, tunebooks: 0 }, { id: 3, tunebooks: 12 },
  ]);
  assert.strictEqual(report.dropped.popularityForUnknownTunes, 1);
});

test('members\' sets: one row per set and its tunes in order, without the ABC', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT * FROM members ORDER BY id'), [
    { id: 7, username: 'player7' },
    { id: 8, username: 'player8' },
  ]);
  assert.deepStrictEqual(all(db, 'SELECT * FROM member_sets ORDER BY id'), [
    { id: 500, member_id: 7, date: '2010-05-05 10:00:00' },
    { id: 501, member_id: 8, date: '2011-06-06 10:00:00' },
  ]);
  assert.deepStrictEqual(all(db, 'SELECT * FROM member_set_tunes WHERE set_id = 500 ORDER BY position'), [
    { set_id: 500, position: 1, tune_id: 1, setting_id: 12 },
    { set_id: 500, position: 2, tune_id: 3, setting_id: 31 },
  ]);
  const cols = all(db, 'PRAGMA table_info(member_set_tunes)').map((c) => c.name);
  assert.ok(!cols.includes('abc'));
  // The tune and setting that are no longer on the site are kept, and counted.
  assert.strictEqual(report.notes.setTunesWithUnknownTune, 1);
  assert.strictEqual(report.notes.setTunesWithUnknownSetting, 1);
});

test('a set with two tunes at the same order keeps both, numbered in the dump\'s row order', () => {
  const rows = baseRows();
  // Set 502: orders 2, 1, 1 (the last two tied), as some real sets have.
  rows.sets.push(
    ['502', '2012-07-07 10:00:00', '7', 'player7', '2', 'Banjo Breakdown', '3', '31', 'reel', '4/4', 'Gmajor', ABC1],
    ['502', '2012-07-07 10:00:00', '7', 'player7', '1', 'The Copper Kettle', '1', '11', 'reel', '4/4', 'Dmajor', ABC1],
    ['502', '2012-07-07 10:00:00', '7', 'player7', '1', 'Cailín na Spéire', '2', '21', 'jig', '6/8', 'Gmajor', ABC2],
  );
  const { db, report } = buildFrom(rows);
  assert.deepStrictEqual(
    all(db, 'SELECT position, tune_id FROM member_set_tunes WHERE set_id = 502 ORDER BY position'),
    [{ position: 1, tune_id: 1 }, { position: 2, tune_id: 2 }, { position: 3, tune_id: 3 }],
  );
  assert.strictEqual(report.notes.setsWithTunesAtTheSameOrder, 1);
});

test('recordings are normalised; a track tune without a tune ID keeps its name', () => {
  const { db, report } = buildFrom(baseRows());
  assert.deepStrictEqual(all(db, 'SELECT * FROM recordings ORDER BY id'), [
    { id: 900, artist: 'The Made-Up Band', title: 'First Album' },
    { id: 901, artist: 'A Duo', title: 'Second Album' },
  ]);
  assert.deepStrictEqual(all(db, 'SELECT * FROM recording_tracks WHERE recording_id = 900 ORDER BY track, number'), [
    { recording_id: 900, track: 1, number: 1, tune_id: 1, tune_name: 'The Copper Kettle' },
    { recording_id: 900, track: 1, number: 2, tune_id: 3, tune_name: 'Banjo Breakdown' },
    { recording_id: 900, track: 2, number: 1, tune_id: null, tune_name: 'Some Unknown Air' },
  ]);
  assert.strictEqual(report.notes.recordingTracksWithoutTune, 1);
});

test('sessions and events are left out', () => {
  const { db } = buildFrom(baseRows());
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  assert.ok(!tables.includes('sessions'));
  assert.ok(!tables.includes('events'));
});

test('fold: lower case, accents folded, apostrophes dropped, punctuation splits words', () => {
  assert.strictEqual(fold('Cailín na Spéire'), 'cailin na speire');
  assert.strictEqual(fold("Coffey's"), 'coffeys');
  assert.strictEqual(fold('Ríl Mhór, An (No. 2)'), 'ril mhor an no 2');
  assert.strictEqual(fold('Ærø Œuvre Straße'), 'aero oeuvre strasse');
});

test('search: each word matches a word start in a name or alias, ignoring case and accents', () => {
  const { db } = buildFrom(baseRows());
  // As the app searches: every word of the folded query at a word start.
  const find = (query) => {
    const words = fold(query).split(' ').filter(Boolean);
    const where = words.map(() => "text LIKE '% ' || ? || '%'").join(' AND ');
    return all(db, `SELECT DISTINCT tune_id FROM tune_search WHERE ${where} ORDER BY tune_id`, ...words).map((r) => r.tune_id);
  };
  assert.deepStrictEqual(find('cailin'), [2]);
  assert.deepStrictEqual(find('SPÉIRE'), [2]);
  assert.deepStrictEqual(find('banj'), [3]);
  assert.deepStrictEqual(find('anjo'), []);
  assert.deepStrictEqual(find('tin kettle'), [1]);
  assert.deepStrictEqual(find('the kett'), [1]);
  assert.deepStrictEqual(find('sky'), [2]);
  const row = db.prepare('SELECT text FROM tune_search WHERE tune_id = 1 AND alias = 0').get();
  assert.strictEqual(row.text, ' the copper kettle ');
});

test('meta records the schema, source, licence and dump', () => {
  const { db } = buildFrom(baseRows());
  const meta = Object.fromEntries(all(db, 'SELECT key, value FROM meta').map((r) => [r.key, r.value]));
  assert.strictEqual(meta.schema_version, String(SCHEMA_VERSION));
  assert.strictEqual(meta.licence, 'ODbL-1.0');
  assert.match(meta.attribution, /Contains information from The Session/);
  assert.strictEqual(meta.dump_commit, 'abc123');
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
});

test('a row with a broken ID is skipped and reported by row number, never by value', () => {
  const rows = baseRows();
  // 100 good rows, so one bad one stays under the failure threshold.
  for (let i = 0; i < 100; i++) rows.tunes.push([String(100 + i), String(1000 + i), `Made-Up ${i}`, 'reel', '4/4', 'Dmajor', ABC1, '', 'x', '']);
  rows.tunes.push(['SECRET-VALUE', '77', 'Leaky Tune', 'reel', '4/4', 'Dmajor', ABC1, '', 'x', '']);
  const { report } = buildFrom(rows);
  assert.deepStrictEqual(report.problems, [
    { table: 'tunes', column: 'tune_id', fault: 'not a whole number', rows: 1, firstRows: [rows.tunes.length] },
  ]);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('SECRET-VALUE'));
  assert.ok(!text.includes('Leaky Tune'));
});

test('too many broken rows fail the build, without quoting them', () => {
  const rows = baseRows();
  rows.tunes.push(['SECRET-VALUE', '77', 'Leaky Tune', 'reel', '4/4', 'Dmajor', ABC1, '', 'x', '']);
  assert.throws(() => buildFrom(rows), (e) => {
    assert.ok(e instanceof BuildError);
    assert.match(e.message, /"tunes"/);
    assert.ok(!e.message.includes('SECRET-VALUE'));
    return true;
  });
});

test('a missing column fails the build and names it', () => {
  const columns = { ...COLUMNS, sets: COLUMNS.sets.filter((c) => c !== 'member_id') };
  const rows = baseRows();
  rows.sets = rows.sets.map((r) => r.filter((_, i) => i !== 2));
  assert.throws(() => buildFrom(rows, columns), /table "sets" has no column "member_id"/);
});

test('the content hash is the same for the same data and changes with it', () => {
  const a = buildFrom(baseRows()).report.contentHash;
  const b = buildFrom(baseRows()).report.contentHash;
  const rows = baseRows();
  rows.tune_popularity[0][2] = '251';
  const c = buildFrom(rows).report.contentHash;
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('buildAll writes the gzipped file and a manifest that matches it', () => {
  const dir = tmp();
  const input = makeDump(dir);
  const out = path.join(dir, 'out');
  const { manifest } = buildAll({ input, out, dumpCommit: 'abc123', dumpDate: '2026-10-18T12:00:00Z', tag: 'v1-20261018', fileUrl: 'https://example.test/v1-20261018/tunedata.db.gz' });
  const gz = fs.readFileSync(path.join(out, manifest.file));
  const db = zlib.gunzipSync(gz);
  assert.strictEqual(manifest.schema, SCHEMA_VERSION);
  assert.strictEqual(manifest.tag, 'v1-20261018');
  assert.strictEqual(manifest.fileUrl, 'https://example.test/v1-20261018/tunedata.db.gz');
  assert.strictEqual(manifest.size, db.length);
  assert.strictEqual(manifest.sha256, crypto.createHash('sha256').update(db).digest('hex'));
  assert.strictEqual(manifest.gzipSha256, crypto.createHash('sha256').update(gz).digest('hex'));
  assert.strictEqual(manifest.counts.tunes, 3);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')), manifest);
});
