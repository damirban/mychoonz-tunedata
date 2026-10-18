// Builds MyChoonz's tune database from The Session's data dump.
//
//   node src/build.js --input thesession.db --out out [--dump-commit SHA] [--dump-date ISO] [--tag TAG] [--file-url URL]
//
// Writes out/tunedata.db, out/tunedata.db.gz, out/manifest.json and
// out/report.json. The report and the console output hold names, counts and
// row numbers only, never values from the dump: the dump's licence forbids
// passing its content to AI tools, so anything printed here must be safe to
// share with one.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SCHEMA_VERSION = 1;

const ATTRIBUTION =
  'Contains information from The Session (https://thesession.org/), ' +
  'made available under the ODC Open Database License (ODbL) v1.0.';

/** The dump's tables and the columns we read from each. */
const REQUIRED = {
  tunes: ['tune_id', 'setting_id', 'name', 'type', 'meter', 'mode', 'abc', 'date', 'username', 'composer'],
  aliases: ['tune_id', 'alias'],
  tune_popularity: ['tune_id', 'tunebooks'],
  sets: ['tuneset', 'date', 'member_id', 'username', 'settingorder', 'tune_id', 'setting_id'],
  recordings: ['id', 'artist', 'recording', 'track', 'number', 'tune', 'tune_id'],
};

/** Columns that must hold a whole number; a row without one is skipped. */
const WHOLE_NUMBERS = {
  tunes: ['tune_id', 'setting_id'],
  aliases: ['tune_id'],
  tune_popularity: ['tune_id', 'tunebooks'],
  sets: ['tuneset', 'member_id', 'settingorder', 'tune_id'],
  recordings: ['id', 'track', 'number'],
};

/** A table whose skipped rows pass this share fails the build: the dump's format has probably changed. */
const MAX_SKIPPED_SHARE = 0.01;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- One row per tune. name, type and composer come from its first setting.
CREATE TABLE tunes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  composer TEXT,
  tunebooks INTEGER NOT NULL DEFAULT 0,
  settings INTEGER NOT NULL
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  tune_id INTEGER NOT NULL,
  meter TEXT,
  mode TEXT,
  abc TEXT NOT NULL,
  date TEXT,
  username TEXT
);
CREATE TABLE aliases (
  tune_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (tune_id, alias)
) WITHOUT ROWID;

-- Members' sets: the members, one row per set, and each set's tunes in order.
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  username TEXT
);
CREATE TABLE member_sets (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL,
  date TEXT
);
-- position is 1, 2, 3... by the dump's settingorder, then by the dump's row order
-- where a set has two tunes at the same settingorder.
CREATE TABLE member_set_tunes (
  set_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  tune_id INTEGER NOT NULL,
  setting_id INTEGER,
  PRIMARY KEY (set_id, position)
) WITHOUT ROWID;

-- Recordings, and the tunes on each track (number: the tune's place in the track).
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY,
  artist TEXT,
  title TEXT
);
CREATE TABLE recording_tracks (
  recording_id INTEGER NOT NULL,
  track INTEGER NOT NULL,
  number INTEGER NOT NULL,
  tune_id INTEGER,
  tune_name TEXT,
  PRIMARY KEY (recording_id, track, number)
) WITHOUT ROWID;

-- Search over tune names (alias = 0) and aliases (alias = 1). text is the
-- name folded for search (see fold()), with a space at each end, so the app
-- can match each word of a query at a word start: text LIKE '% word%'.
-- A plain table rather than FTS5, which Android's own SQLite doesn't always have.
CREATE TABLE tune_search (
  tune_id INTEGER NOT NULL,
  alias INTEGER NOT NULL,
  text TEXT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX settings_tune ON settings (tune_id);
CREATE INDEX tunes_popular ON tunes (tunebooks DESC) WHERE tunebooks > 0;
CREATE INDEX member_sets_member ON member_sets (member_id);
CREATE INDEX recording_tracks_tune ON recording_tracks (tune_id);
`;

/** Tables in the content hash, each with its row order. */
const HASHED = {
  tunes: 'id',
  settings: 'id',
  aliases: 'tune_id, alias',
  members: 'id',
  member_sets: 'id',
  member_set_tunes: 'set_id, position',
  recordings: 'id',
  recording_tracks: 'recording_id, track, number',
  tune_search: 'tune_id, alias, text',
};

class BuildError extends Error {}

/**
 * Letters folded to their plain form for search. The app folds a query
 * with the same table (lib/services/tune_data.dart), so keep them in step.
 */
const FOLD = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a', æ: 'ae',
  ç: 'c', ć: 'c', č: 'c', ď: 'd', đ: 'd', ð: 'd',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ė: 'e', ę: 'e', ě: 'e',
  ğ: 'g', ì: 'i', í: 'i', î: 'i', ï: 'i', ī: 'i', į: 'i', ı: 'i',
  ł: 'l', ľ: 'l', ñ: 'n', ń: 'n', ň: 'n',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o', ő: 'o', œ: 'oe',
  ŕ: 'r', ř: 'r', ś: 's', š: 's', ş: 's', ß: 'ss', ť: 't', ţ: 't', þ: 'th',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ū: 'u', ů: 'u', ű: 'u', ų: 'u',
  ý: 'y', ÿ: 'y', ź: 'z', ż: 'z', ž: 'z',
};

/**
 * A name as search sees it: lower case, accents folded, apostrophes dropped
 * ("Coffey's" -> "coffeys"), other punctuation a word break, single spaces.
 */
function fold(name) {
  const lower = name.toLowerCase().replace(/['’`]/g, '');
  let out = '';
  for (const ch of lower) out += FOLD[ch] ?? ch;
  return out.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const q = (name) => '"' + name.replace(/"/g, '""') + '"';
/** SQL that is true when [col] holds a whole number. */
const whole = (col) => `(${col} <> '' AND ${col} NOT GLOB '*[^0-9]*')`;
const int = (col) => `CAST(${col} AS INTEGER)`;
/**
 * SQL for a name with a trailing ", The" moved to the front ("Kesh, The" ->
 * "The Kesh"), as the app and The Session's pages show it. The dump stores
 * names sorted that way; other articles are too rare to move.
 */
const named = (col) => `CASE WHEN ${col} GLOB '*, The' THEN 'The ' || substr(${col}, 1, length(${col}) - 5) ELSE ${col} END`;

function checkColumns(db) {
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = db.prepare(`PRAGMA src.table_info(${q(table)})`).all().map((c) => c.name);
    if (have.length === 0) throw new BuildError(`The dump has no table "${table}".`);
    for (const c of cols) {
      if (!have.includes(c)) throw new BuildError(`The dump's table "${table}" has no column "${c}".`);
    }
  }
}

/**
 * Counts the rows of each table that the build skips, and names the faults
 * by column and row number (rowid in the dump), never by value.
 */
function checkRows(db, report) {
  for (const [table, cols] of Object.entries(WHOLE_NUMBERS)) {
    const total = db.prepare(`SELECT count(*) AS n FROM src.${q(table)}`).get().n;
    report.source[table] = total;
    const bad = cols.map((c) => `NOT ${whole(q(c))}`).join(' OR ');
    const skipped = db.prepare(`SELECT count(*) AS n FROM src.${q(table)} WHERE ${bad}`).get().n;
    if (skipped === 0) continue;
    for (const c of cols) {
      const rows = db
        .prepare(`SELECT rowid AS r FROM src.${q(table)} WHERE NOT ${whole(q(c))} ORDER BY rowid LIMIT 5`)
        .all()
        .map((r) => r.r);
      const count = db.prepare(`SELECT count(*) AS n FROM src.${q(table)} WHERE NOT ${whole(q(c))}`).get().n;
      if (count > 0) {
        report.problems.push({ table, column: c, fault: 'not a whole number', rows: count, firstRows: rows });
      }
    }
    if (skipped / total > MAX_SKIPPED_SHARE) {
      throw new BuildError(
        `${skipped} of ${total} rows of "${table}" have a column that isn't a whole number ` +
          `(more than ${MAX_SKIPPED_SHARE * 100}%). The dump's format may have changed.`,
      );
    }
  }
}

/** A row is used only when all its whole-number columns are whole numbers. */
function okRow(table) {
  return WHOLE_NUMBERS[table].map((c) => whole(q(c))).join(' AND ');
}

function count(db, sql) {
  return db.prepare(sql).get().n;
}

function copyTunes(db, report) {
  const ok = okRow('tunes');
  db.exec(`
    INSERT INTO tunes (id, name, type, composer, settings)
    SELECT tid, name, type, composer, 0 FROM (
      SELECT ${int('tune_id')} AS tid, ${named('trim(name)')} AS name, NULLIF(type, '') AS type,
             max(NULLIF(composer, '')) OVER w AS composer,
             row_number() OVER (w ORDER BY ${int('setting_id')}, rowid) AS rn
      FROM src.tunes WHERE ${ok}
      WINDOW w AS (PARTITION BY ${int('tune_id')})
    ) WHERE rn = 1;

    INSERT OR IGNORE INTO settings (id, tune_id, meter, mode, abc, date, username)
    SELECT ${int('setting_id')}, ${int('tune_id')}, NULLIF(meter, ''), NULLIF(mode, ''), abc,
           NULLIF(date, ''), NULLIF(username, '')
    FROM src.tunes WHERE ${ok} ORDER BY rowid;

    UPDATE tunes SET settings = c.n
    FROM (SELECT tune_id, count(*) AS n FROM settings GROUP BY tune_id) AS c
    WHERE c.tune_id = tunes.id;
  `);
  const used = count(db, `SELECT count(*) AS n FROM src.tunes WHERE ${ok}`);
  const settings = count(db, 'SELECT count(*) AS n FROM settings');
  report.dropped.duplicateSettings = used - settings;
  // Of those, settings whose rows were not identical (the first row is kept).
  report.dropped.duplicateSettingsThatDiffer = count(
    db,
    `SELECT count(*) AS n FROM (
       SELECT setting_id FROM src.tunes WHERE ${ok} GROUP BY ${int('setting_id')}
       HAVING count(DISTINCT tune_id || char(31) || meter || char(31) || mode || char(31) || abc || char(31) || date) > 1)`,
  );
}

function copyAliases(db, report) {
  const ok = okRow('aliases');
  db.exec(`
    INSERT OR IGNORE INTO aliases (tune_id, alias)
    SELECT ${int('tune_id')}, ${named('trim(alias)')} FROM src.aliases
    WHERE ${ok} AND trim(alias) <> '' AND ${int('tune_id')} IN (SELECT id FROM tunes)
    ORDER BY rowid;
  `);
  report.dropped.aliasesForUnknownTunes = count(
    db,
    `SELECT count(*) AS n FROM src.aliases WHERE ${ok} AND ${int('tune_id')} NOT IN (SELECT id FROM tunes)`,
  );
}

function copyPopularity(db, report) {
  const ok = okRow('tune_popularity');
  db.exec(`
    UPDATE tunes SET tunebooks = p.n
    FROM (SELECT ${int('tune_id')} AS tid, max(${int('tunebooks')}) AS n
          FROM src.tune_popularity WHERE ${ok} GROUP BY tid) AS p
    WHERE tunes.id = p.tid;
  `);
  report.dropped.popularityForUnknownTunes = count(
    db,
    `SELECT count(DISTINCT ${int('tune_id')}) AS n FROM src.tune_popularity
     WHERE ${ok} AND ${int('tune_id')} NOT IN (SELECT id FROM tunes)`,
  );
}

function copySets(db, report) {
  const ok = okRow('sets');
  // Each member's username, and each set's member and date, come from their first row.
  db.exec(`
    INSERT INTO members (id, username)
    SELECT mid, username FROM (
      SELECT ${int('member_id')} AS mid, NULLIF(username, '') AS username,
             row_number() OVER (PARTITION BY ${int('member_id')} ORDER BY rowid) AS rn
      FROM src.sets WHERE ${ok}
    ) WHERE rn = 1;

    INSERT INTO member_sets (id, member_id, date)
    SELECT sid, mid, date FROM (
      SELECT ${int('tuneset')} AS sid, ${int('member_id')} AS mid, NULLIF(date, '') AS date,
             row_number() OVER (PARTITION BY ${int('tuneset')} ORDER BY rowid) AS rn
      FROM src.sets WHERE ${ok}
    ) WHERE rn = 1;

    INSERT INTO member_set_tunes (set_id, position, tune_id, setting_id)
    SELECT ${int('tuneset')},
           row_number() OVER (PARTITION BY ${int('tuneset')} ORDER BY ${int('settingorder')}, rowid),
           ${int('tune_id')},
           CASE WHEN ${whole('setting_id')} THEN ${int('setting_id')} END
    FROM src.sets WHERE ${ok};
  `);
  report.notes.setsWithTunesAtTheSameOrder = count(
    db,
    `SELECT count(DISTINCT tuneset) AS n FROM (SELECT tuneset FROM src.sets WHERE ${ok}
     GROUP BY ${int('tuneset')}, ${int('settingorder')} HAVING count(*) > 1)`,
  );
  report.notes.membersWithDifferingUsernames = count(
    db,
    `SELECT count(*) AS n FROM (SELECT member_id FROM src.sets WHERE ${ok}
     GROUP BY ${int('member_id')} HAVING count(DISTINCT username) > 1)`,
  );
  report.notes.setTunesWithUnknownSetting = count(
    db,
    `SELECT count(*) AS n FROM member_set_tunes
     WHERE setting_id IS NULL OR setting_id NOT IN (SELECT id FROM settings)`,
  );
  report.notes.setTunesWithUnknownTune = count(
    db,
    'SELECT count(*) AS n FROM member_set_tunes WHERE tune_id NOT IN (SELECT id FROM tunes)',
  );
}

function copyRecordings(db, report) {
  const ok = okRow('recordings');
  db.exec(`
    INSERT INTO recordings (id, artist, title)
    SELECT rid, artist, title FROM (
      SELECT ${int('id')} AS rid, NULLIF(artist, '') AS artist, NULLIF(recording, '') AS title,
             row_number() OVER (PARTITION BY ${int('id')} ORDER BY rowid) AS rn
      FROM src.recordings WHERE ${ok}
    ) WHERE rn = 1;

    INSERT OR IGNORE INTO recording_tracks (recording_id, track, number, tune_id, tune_name)
    SELECT ${int('id')}, ${int('track')}, ${int('number')},
           CASE WHEN ${whole('tune_id')} AND ${int('tune_id')} > 0 THEN ${int('tune_id')} END,
           NULLIF(${named('trim(tune)')}, '')
    FROM src.recordings WHERE ${ok} ORDER BY rowid;
  `);
  const used = count(db, `SELECT count(*) AS n FROM src.recordings WHERE ${ok}`);
  report.dropped.recordingTracksRepeated = used - count(db, 'SELECT count(*) AS n FROM recording_tracks');
  report.notes.recordingsWithDifferingNames = count(
    db,
    `SELECT count(*) AS n FROM (SELECT id FROM src.recordings WHERE ${ok} GROUP BY ${int('id')}
     HAVING count(DISTINCT artist || char(31) || recording) > 1)`,
  );
  report.notes.recordingTracksWithoutTune = count(
    db,
    'SELECT count(*) AS n FROM recording_tracks WHERE tune_id IS NULL',
  );
  report.notes.recordingTracksWithUnknownTune = count(
    db,
    'SELECT count(*) AS n FROM recording_tracks WHERE tune_id IS NOT NULL AND tune_id NOT IN (SELECT id FROM tunes)',
  );
}

function fillSearch(db) {
  const insert = db.prepare('INSERT INTO tune_search (tune_id, alias, text) VALUES (?, ?, ?)');
  const names = db.prepare('SELECT id, name, 0 AS alias FROM tunes UNION ALL SELECT tune_id, alias, 1 FROM aliases');
  for (const r of names.iterate()) {
    const text = fold(r.name);
    if (text) insert.run(r.id, r.alias, ` ${text} `);
  }
}

/** A hash of the content, independent of SQLite's file layout and of build time. */
function contentHash(db) {
  const h = crypto.createHash('sha256');
  h.update(`schema ${SCHEMA_VERSION}\n`);
  for (const [table, order] of Object.entries(HASHED)) {
    h.update(`table ${table}\n`);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      h.update(JSON.stringify(Object.values(row)));
      h.update('\n');
    }
  }
  return h.digest('hex');
}

/**
 * Builds [output] from the dump at [input]. Returns the report: counts and
 * problems, with no values from the dump.
 */
function build({ input, output, dumpCommit = null, dumpDate = null }) {
  if (!fs.existsSync(input)) throw new BuildError(`No dump at ${input}.`);
  fs.rmSync(output, { force: true });
  const db = new DatabaseSync(output);
  const report = { schema: SCHEMA_VERSION, source: {}, counts: {}, dropped: {}, notes: {}, problems: [] };
  try {
    db.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.prepare('ATTACH DATABASE ? AS src').run(input);
    checkColumns(db);
    checkRows(db, report);

    db.exec('BEGIN');
    db.exec(SCHEMA);
    copyTunes(db, report);
    copyAliases(db, report);
    copyPopularity(db, report);
    copySets(db, report);
    copyRecordings(db, report);
    fillSearch(db);
    db.exec(INDEXES);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', String(SCHEMA_VERSION));
    meta.run('source', 'https://github.com/adactio/TheSession-data');
    meta.run('licence', 'ODbL-1.0');
    meta.run('attribution', ATTRIBUTION);
    if (dumpCommit) meta.run('dump_commit', dumpCommit);
    if (dumpDate) meta.run('dump_date', dumpDate);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE src');

    for (const t of Object.keys(HASHED)) report.counts[t] = count(db, `SELECT count(*) AS n FROM ${t}`);
    report.contentHash = contentHash(db);
    db.exec('ANALYZE; VACUUM;');
  } finally {
    db.close();
  }
  return report;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Builds the database, gzips it and writes the manifest and report into [out]. */
function buildAll({ input, out, dumpCommit, dumpDate, tag, fileUrl }) {
  fs.mkdirSync(out, { recursive: true });
  const dbFile = path.join(out, 'tunedata.db');
  const gzFile = dbFile + '.gz';
  const report = build({ input, output: dbFile, dumpCommit, dumpDate });
  fs.writeFileSync(gzFile, zlib.gzipSync(fs.readFileSync(dbFile), { level: 9 }));

  const manifest = {
    schema: SCHEMA_VERSION,
    tag: tag || null,
    dumpCommit: dumpCommit || null,
    dumpDate: dumpDate || null,
    builtAt: new Date().toISOString(),
    contentHash: report.contentHash,
    file: path.basename(gzFile),
    // Where the published file will be, so the app needn't work it out from the manifest's URL.
    fileUrl: fileUrl || null,
    size: fs.statSync(dbFile).size,
    sha256: sha256File(dbFile),
    gzipSize: fs.statSync(gzFile).size,
    gzipSha256: sha256File(gzFile),
    counts: report.counts,
    licence: 'ODbL-1.0',
    attribution: ATTRIBUTION,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return { manifest, report };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[i + 1];
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.out) {
    console.error('Usage: node src/build.js --input thesession.db --out out [--dump-commit SHA] [--dump-date ISO] [--tag TAG] [--file-url URL]');
    process.exit(2);
  }
  try {
    const { manifest, report } = buildAll(args);
    console.log(JSON.stringify({ manifest, report }, null, 2));
  } catch (e) {
    if (e instanceof BuildError) {
      console.error(`Build failed: ${e.message}`);
      process.exit(1);
    }
    // An error from SQLite could quote a value, so print only its kind.
    console.error(`Build failed: ${e.name} (${e.code || 'no code'}). Run the tests to find the step.`);
    process.exit(1);
  }
}

module.exports = { build, buildAll, fold, BuildError, SCHEMA_VERSION, ATTRIBUTION };
