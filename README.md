# MyChoonz tune database

Builds the tune database that the MyChoonz app bundles and keeps up to date: a compact SQLite file made from The Session's weekly data dump (<https://github.com/adactio/TheSession-data>). Design: MyChoonz Jira KAN-65 and KAN-84.

**Contains information from The Session (<https://thesession.org/>), made available under the ODbL.** See [LICENSE-DATA.md](LICENSE-DATA.md).

## How it runs

The GitHub Action [`build.yml`](.github/workflows/build.yml) runs every Sunday at 20:00 UTC, and by hand from the Actions tab. It:

1. runs the tests;
2. downloads the latest `thesession.db` from the dump repository;
3. builds `tunedata.db`, gzips it, and writes `manifest.json` and `report.json`;
4. keeps the three files as the run's `tunedata` artifact for 30 days (the private copy for development builds of the app);
5. publishes a GitHub Release with `tunedata.db.gz` and `manifest.json`, **only when the repository variable `PUBLISH` is `true`**, and only when the content has changed since the last release (or when run by hand with "force").

Publishing is off while this repository is private. Before turning it on: settle the licence questions, choose a licence for the code, make the repository public, then set `PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables).

GitHub turns off scheduled workflows in a public repository after 60 days without activity; re-enable it from the Actions tab if that happens.

## Building locally

Needs Node 24 or later (it uses the built-in `node:sqlite`). No dependencies.

```sh
npm test
curl -fsSL -o work/thesession.db https://media.githubusercontent.com/media/adactio/TheSession-data/main/thesession.db
npm run build -- --input work/thesession.db --out out
```

`work/` and `out/` are git-ignored. Never commit the dump or the built file.

## Working with the data

The Session's licence forbids processing the data with AI tools. The build script was written without an AI seeing any of the data, and these rules keep it that way:

- The build's output and `report.json` hold names, counts and row numbers only, never values from the dump. Keep it so.
- Tests use made-up tunes only. Never copy rows from the dump into tests or issues.
- To look into a problem, open the rows yourself by the row numbers in the report.

## The file

`tunedata.db`, schema version 1 (also `PRAGMA user_version`). All IDs are The Session's.

| Table | Rows (18 Oct 2026) | Contents |
|---|---|---|
| `meta` | | `schema_version`, `source`, `licence`, `attribution`, `dump_commit`, `dump_date` |
| `tunes` | 23,355 | `id`, `name`, `type`, `composer`, `tunebooks` (popularity, 0 when not listed), `settings` (count). Name and type from the tune's first setting |
| `settings` | 55,574 | `id`, `tune_id`, `meter`, `mode`, `abc`, `date`, `username` (who posted it) |
| `aliases` | 29,517 | `tune_id`, `alias` |
| `members` | 11,585 | `id`, `username` |
| `member_sets` | 130,297 | `id`, `member_id`, `date` |
| `member_set_tunes` | 329,282 | `set_id`, `position` (1, 2, 3…), `tune_id`, `setting_id` |
| `recordings` | 7,981 | `id`, `artist`, `title` |
| `recording_tracks` | 203,361 | `recording_id`, `track`, `number` (the tune's place in the track), `tune_id` (null when the tune isn't on the site), `tune_name` as listed |
| `tune_search` | | FTS5 over tune names (`alias` = 0) and aliases (`alias` = 1); ignores case and accents; prefix queries |

Size on 18 Oct 2026: 43.4 MB, 17.5 MB gzipped. Builds in about 20 seconds.

What the build changes from the dump:

- **Names:** the dump stores names with a trailing ", The" ("Kesh, The"). The build moves it to the front ("The Kesh"), as the app and The Session's pages show names, in tune names, aliases and track names. Other articles (", La", ", An") are left as they are; there are only a handful.
- **Duplicate settings** (the same `setting_id` twice) are kept once.
- **Set positions:** some sets have two tunes at the same `settingorder` (1,657 sets on 18 Oct). All tunes are kept and numbered by `settingorder`, then by the dump's row order.
- **Usernames** of members move to `members`; the ABC in the dump's `sets` is dropped (it's in `settings`).
- **Sessions and events** are left out.
- Rows whose ID columns aren't whole numbers are skipped and reported by row number. If more than 1% of a table's rows are skipped, the build fails, because the dump's format has probably changed.

`manifest.json` has the schema version, tag, dump commit and date, build time, `contentHash` (the content, independent of the file's layout), the file's size and SHA-256 (uncompressed and gzipped), the row counts, and the licence and attribution.
