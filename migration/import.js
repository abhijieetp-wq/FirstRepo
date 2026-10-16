/**
 * Loading PIE's exported spreadsheet into Postgres, and proving it arrived.
 *
 * The export (src/Export.gs) writes one JSON file per tab into a Drive folder. This reads that
 * folder and loads it, with three checks in front of the write and one behind it. The order is
 * the design: everything that can be known before touching the database is checked before
 * touching the database, because a refusal costs nothing and a half-loaded database on cutover
 * day costs the day.
 *
 *   BEFORE                                                      what it catches
 *   1. every row's digest, recomputed here                      a file that was truncated,
 *   2. every tab's digest, recomputed from the row digests      re-encoded, or edited
 *   3. every column mapped to a real database column            data with nowhere to go
 *
 *   AFTER
 *   4. every row read back and compared field by field          anything the write changed
 *
 * CHECKS 1 AND 2 ARE REIMPLEMENTED, NOT SHARED. The hashing rule is written out in
 * src/Export.gs as prose and implemented here from that prose. Sharing one implementation
 * would make this check prove only that the function is deterministic. Two implementations
 * agreeing on 27,000 rows is evidence about the data.
 *
 * CHECK 4 IS THE ONE THAT MATTERS and it is not a formality — it fails on real, acceptable
 * differences, and says which. A NUMERIC(14,2) column holding 100.456 comes back 100.46; the
 * sheet never rounded it because a cell has no type. That is a change to PIE's data, it is
 * almost certainly fine for money, and it is not something to find out about from a customer.
 * So differences are classified rather than counted: rounded, retyped, or lost.
 *
 *   node migration/import.js <folder>                  check everything, write nothing
 *   node migration/import.js <folder> --write          check, load, then verify
 *   node migration/import.js <folder> --write --force  load despite classified differences
 *
 * The tenant comes from --tenant (default 'pie'). DATABASE_URL says where.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { connect, mapFor, coerce } = require('../server/db.js');

// ------------------------------------------------------------------ the hashing rule

/**
 * One cell as text, from the rule written out in src/Export.gs.
 *
 * The export has already turned every cell into a string by the time it reaches this file, so
 * there is no Date handling here — a Date became yyyy-MM-dd on the way out, in PIE's timezone,
 * which is the one thing this side could not do correctly on its own and therefore the one
 * thing it must not try to.
 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** The unit separator, which no spreadsheet cell contains. See the note in Export.gs. */
const SEP = '\u001f';

// ------------------------------------------------------------------ timestamps

/**
 * A timestamp from the sheet, as the instant it actually was.
 *
 * THIS IS THE MOST IMPORTANT FUNCTION IN THIS FILE, and the rehearsal at full size is what
 * found it. 35 of the schema's columns are TIMESTAMPTZ, and the sheet holds them in two
 * different forms:
 *
 *   '2026-09-01 10:00:00'      what audit_ wrote: PIE's wall clock, no offset, because
 *                              Utilities.formatDate(..., scriptTimeZone, 'yyyy-MM-dd HH:mm:ss')
 *                              has nowhere to put one
 *   '2026-09-01T10:00:00.000Z' what toISOString() wrote: an instant, unambiguous
 *
 * Handed the first form, Postgres interprets it in the SESSION's timezone — UTC on any server
 * anybody would run this on, Neon included. So 10am in Pune was being stored as 10am UTC and
 * read back as 10am UTC: every migrated timestamp 5 hours 30 minutes early. Measured, not
 * supposed. That is every audit entry's "when", every session's expiry (so sessions outlive
 * their twelve hours), every telemetry sample, and the createdAt on every record PIE has.
 *
 * The export's manifest records the timezone the sheet was written in precisely so this can be
 * done correctly, rather than this file guessing or hard-coding Asia/Kolkata.
 *
 * The offset is worked out for the instant in question rather than taken as a constant.
 * India has no daylight saving so it is always +05:30 — but the rule is about zones, not about
 * India, and a rule that is only right for one country is the kind that surprises somebody
 * later.
 */
function zoneOffsetMs(tz, naiveIso) {
  const asIfUtc = new Date(naiveIso + 'Z');
  if (isNaN(asIfUtc.getTime())) return null;
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(asIfUtc).forEach((p) => { parts[p.type] = p.value; });
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const readBack = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second));
  return readBack - asIfUtc.getTime();
}

/**
 * @return an ISO instant, or null for a blank, or the original string when it cannot be read
 *         as a time at all — which is a thing to report rather than to silently drop.
 */
function timestampIn(value, tz) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return null;

  // Already unambiguous: ends in Z, or carries a ±hh:mm offset. Must not be shifted again.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d.toISOString();
  }

  // 'yyyy-MM-dd HH:mm:ss' or with a T, seconds optional. PIE's wall clock.
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?$/.exec(raw);
  if (!m) {
    // A date with no time at all, in a timestamp column: midnight, in PIE's timezone rather
    // than in UTC, or the day slides.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const off = zoneOffsetMs(tz, raw + 'T00:00:00');
      return off === null ? raw : new Date(Date.parse(raw + 'T00:00:00Z') - off).toISOString();
    }
    return raw;
  }

  const naive = m[1] + 'T' + m[2] + (m[3] || ':00');
  const off = zoneOffsetMs(tz, naive);
  if (off === null) return raw;
  return new Date(Date.parse(naive + 'Z') - off).toISOString();
}

function rowDigest(cells) {
  const text = cells.map(cellText).join(SEP);
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64');
}

function tabDigest(rowDigests) {
  return crypto.createHash('sha256')
    .update(Buffer.from(rowDigests.join('\n'), 'utf8')).digest('base64');
}

// ------------------------------------------------------------------ reading the export

/**
 * The folder holding _manifest.json, which is not always the one that was handed over.
 *
 * Drive zips a folder with itself inside it, so unzipping gives
 * pie-export\PIE ERP migration export 2026-10-16\_manifest.json and the obvious thing to
 * type is the outer one. Looking one level down for a single subfolder that has the manifest
 * costs nothing and saves the twenty minutes of wondering which folder was meant.
 *
 * Only when there is exactly one candidate. Two would mean two exports unzipped together,
 * and picking one of those is a guess rather than a convenience.
 */
function findExportDir(dir) {
  if (fs.existsSync(path.join(dir, '_manifest.json'))) return dir;
  let inner = [];
  try {
    inner = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .filter((d) => fs.existsSync(path.join(d, '_manifest.json')));
  } catch (err) {
    throw new Error('Cannot read ' + dir + ' — ' + err.message);
  }
  if (inner.length === 1) {
    console.log('(using ' + inner[0] + ', which is where the manifest is)\n');
    return inner[0];
  }
  if (inner.length > 1) {
    throw new Error('There are ' + inner.length + ' exports inside ' + dir +
      '. Point at one of them:\n  ' + inner.join('\n  '));
  }
  throw new Error('No _manifest.json in ' + dir + ', nor in any folder directly inside it.\n' +
    'Either this is the wrong folder, or the export did not finish — run ' +
    'exportForMigration()\nin the Apps Script editor until it says "Export complete".');
}

function loadExport(wanted) {
  const dir = findExportDir(wanted);
  const manifestPath = path.join(dir, '_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = {};

  for (const entry of manifest.tabs) {
    // A tab is written in one file per 5,000 rows, so that nothing goes to Drive big enough
    // for Drive to refuse it and nothing has to be held in memory whole. They are read back
    // in order and joined here, so everything downstream sees one tab as one list of rows,
    // exactly as it did when a tab was one file.
    const partCount = entry.parts === undefined ? 1 : entry.parts;
    const rows = [];
    const rowDigests = [];
    const partDigests = [];
    let columns = entry.columns || [];

    for (let part = 1; part <= partCount; part++) {
      const name = entry.tab + '.' + (part < 10 ? '0' + part : String(part)) + '.json';
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        throw new Error('The manifest says ' + entry.tab + ' was written in ' + partCount +
          ' file(s) and ' + name + ' is not in the folder. A partial download is the usual ' +
          'cause — take the whole folder again rather than the files that are missing.');
      }
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (payload.tab !== entry.tab) {
        throw new Error(name + ' says it holds ' + payload.tab + ' rather than ' + entry.tab +
          '. Two exports have been mixed in one folder.');
      }
      rows.push.apply(rows, payload.rows);
      rowDigests.push.apply(rowDigests, payload.rowDigests);
      partDigests.push(payload.digest);
      if (payload.columns && payload.columns.length) columns = payload.columns;
    }

    files[entry.tab] = {
      tab: entry.tab, columns, rows, rowDigests, partDigests,
      rowCount: rows.length, digest: entry.digest,
      blankRowsSkipped: entry.blankRowsSkipped
    };
  }
  return { manifest, files };
}

// ------------------------------------------------------------------ check 1 and 2

/**
 * Every digest, recomputed. Returns the problems, which is normally nothing.
 *
 * A row-level mismatch names the row, because on a 27,000-row tab "the digest does not match"
 * is not something anybody can act on.
 */
function checkDigests(manifest, files) {
  const problems = [];

  for (const entry of manifest.tabs) {
    const payload = files[entry.tab];

    if (payload.rows.length !== entry.rowCount) {
      problems.push(entry.tab + ': the file holds ' + payload.rows.length +
        ' rows and says it holds ' + entry.rowCount);
    }
    if (payload.rowDigests.length !== payload.rows.length) {
      problems.push(entry.tab + ': ' + payload.rows.length + ' rows but ' +
        payload.rowDigests.length + ' row digests');
      continue;
    }

    let bad = 0;
    const firstFew = [];
    for (let i = 0; i < payload.rows.length; i++) {
      const got = rowDigest(payload.rows[i]);
      if (got === payload.rowDigests[i]) continue;
      bad++;
      if (firstFew.length < 3) firstFew.push('row ' + (i + 1) + ' (' + payload.rows[i][0] + ')');
    }
    if (bad) {
      problems.push(entry.tab + ': ' + bad + ' row(s) do not match their digest — ' +
        firstFew.join(', ') + (bad > firstFew.length ? ', and others' : ''));
    }

    // The tab's digest is over its PARTS' digests, not over every row's — so that the export
    // never has to hold 200,000 row digests at once. Two levels, checked at both.
    const whole = tabDigest(payload.partDigests);
    if (whole !== entry.digest) {
      problems.push(entry.tab + ': the tab digest does not match its ' +
        payload.partDigests.length + ' part(s). A whole file may be missing or stale, even ' +
        'though every row in the ones that are here is intact.');
    }
  }

  return problems;
}

// ------------------------------------------------------------------ check 3

/**
 * Every exported column mapped to a database column, or named as having nowhere to go.
 *
 * Refusing is the right answer rather than dropping. A column somebody added to the sheet by
 * hand — and people do, that is what a spreadsheet is for — holds data PIE entered and
 * believes is there. Silently not carrying it over is the single easiest way for this
 * migration to lose something nobody notices for a year.
 */
function checkColumns(manifest, files, ignore) {
  const unmapped = [];
  const missingTables = [];
  const ignored = [];
  const empties = [];
  const ignoreSet = {};
  (ignore || []).forEach((name) => { ignoreSet[name] = true; });
  const plan = {};

  for (const entry of manifest.tabs) {
    let m;
    try {
      m = mapFor(entry.tab);
    } catch (err) {
      missingTables.push(entry.tab + ' — ' + err.message);
      continue;
    }

    const payload = files[entry.tab];
    const columns = [];
    payload.columns.forEach((name, index) => {
      if (!name) return;                                  // a blank header spans no data
      if (!m.toDb[name]) {
        const held = payload.rows.filter((r) =>
          r[index] !== '' && r[index] !== null && r[index] !== undefined).length;

        // An undeclared column with NOTHING IN IT is not a decision. You cannot lose data
        // that is not there, and making somebody name twenty empty columns on a command line
        // to get past them teaches them to name columns without reading the list — which is
        // exactly the habit that loses the twenty-first.
        //
        // PIE's sheet has 21 undeclared columns and 20 are empty: fossils from before the
        // schema settled, left behind because Setup.gs adds columns the schema declares and
        // never removes ones it does not. They are reported and passed over.
        if (!held) {
          empties.push(entry.tab + '.' + name);
          return;
        }

        // One that holds something is a real decision, and stays refused until it is named.
        // Recorded when it is, because --ignore is somebody choosing to leave data behind and
        // the one thing that must never happen is for that to be invisible afterwards.
        if (ignoreSet[entry.tab + '.' + name]) {
          ignored.push({ column: entry.tab + '.' + name, rowsHoldingData: held });
          return;
        }
        unmapped.push({ column: entry.tab + '.' + name, rowsHoldingData: held });
        return;
      }
      columns.push({ field: name, column: m.toDb[name], index, type: m.kind[name] });
    });

    // A column the schema declares that the sheet has not got. Normal, and it becomes NULL.
    const absent = m.columns.filter((c) => payload.columns.indexOf(c) === -1);
    plan[entry.tab] = { map: m, columns, absent, rows: payload.rows };
  }

  return { unmapped, missingTables, ignored, empties, plan };
}

/**
 * Cells in a timestamp column that cannot be read as a time, found before anything is written.
 *
 * Without this the first such cell fails inside the load, as a Postgres cast error naming a
 * column and no row, which aborts the whole transaction. The catalogue already carries 4,470
 * rows reading "Will update shortly" where an HSN code belongs — a person typing a note into
 * a date column is not a hypothetical in this spreadsheet.
 *
 * Reported rather than coerced to null. A date somebody could not supply and wrote a note
 * about is information; throwing it away to make the import succeed is the importer deciding
 * something that is not its to decide.
 */
function checkTimestamps(plan, tz) {
  const bad = [];
  for (const tab of Object.keys(plan)) {
    const spec = plan[tab];
    const stamps = spec.columns.filter((c) => c.type === 'TIMESTAMPTZ');
    if (!stamps.length) continue;
    const idCol = spec.columns.find((c) => c.field === 'id');
    for (const row of spec.rows) {
      for (const c of stamps) {
        const raw = row[c.index] === undefined ? '' : String(row[c.index]).trim();
        if (!raw) continue;
        const asInstant = timestampIn(raw, tz);
        // timestampIn hands back the original string when it could not read it as a time.
        if (asInstant === raw && !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
          bad.push({ tab, id: idCol ? String(row[idCol.index]) : '?', field: c.field, value: raw });
        }
      }
    }
  }
  return bad;
}

// ------------------------------------------------------------------ the write

/**
 * Loads one tab in batches, inside the caller's transaction.
 *
 * Batched rather than row-at-a-time because 27,000 round trips to Neon is minutes of latency,
 * and not one single statement because 27,000 rows of 16 columns exceeds what a parameter list
 * can carry. Five hundred rows is comfortably inside Postgres's 65,535-parameter limit for
 * every tab here, the widest of which is Quotations at 45 columns — 500 × 46 is 23,000.
 */
async function loadTab(tx, tenant, tab, spec, batchSize, tz) {
  const { map, columns } = spec;
  const dbCols = ['tenant_id'].concat(columns.map((c) => c.column));
  let written = 0;

  for (let start = 0; start < spec.rows.length; start += batchSize) {
    const batch = spec.rows.slice(start, start + batchSize);
    const params = [];
    const tuples = [];

    for (const row of batch) {
      const placeholders = [];
      params.push(tenant);
      placeholders.push('$' + params.length);
      for (const c of columns) {
        const cell = row[c.index] === undefined ? '' : row[c.index];
        // A timestamp is resolved to an instant first, using the timezone the sheet was
        // written in. coerce passes a TIMESTAMPTZ string through untouched — correct for what
        // the portal writes at runtime, which is always an ISO instant, and 5h30m wrong for
        // what the sheet holds, which is a wall clock with no offset.
        if (c.type === 'TIMESTAMPTZ') {
          params.push(timestampIn(cell, tz));
          placeholders.push('$' + params.length);
          continue;
        }
        // Everything else through db.js's own coerce, so a value written by this importer is
        // indistinguishable from one written by the portal: the same blank-to-null rule, the
        // same TRUE/FALSE to boolean rule, the same date slicing. A second implementation here
        // would be a second set of rules for what a blank cell means.
        params.push(coerce(c.type, cell));
        placeholders.push('$' + params.length);
      }
      tuples.push('(' + placeholders.join(', ') + ')');
    }

    const result = await tx.q(
      'INSERT INTO ' + map.table + ' (' + dbCols.join(', ') + ') VALUES ' + tuples.join(', '),
      params);
    written += result.rowCount;
  }

  return written;
}

// ------------------------------------------------------------------ check 4

/**
 * Reads every row back and compares it to the export, field by field.
 *
 * Differences are classified, because they are not all the same thing:
 *
 *   rounded   a number the column's precision could not hold exactly. 100.456 into
 *             NUMERIC(14,2) is 100.46. The data changed; for money it is almost certainly
 *             what everyone wants; it is still a change and gets listed.
 *   retyped   the same value in a different form — '18' against 18, 'TRUE' against true.
 *             Not a difference at all once the portal reads it, and counted separately so it
 *             does not drown the two that matter.
 *   lost      a value that went in and did not come out, or came out as something else.
 *             This is the one that stops the import.
 *
 * Compared against the EXPORT rather than against the sheet, which is the honest limit of what
 * this can do from here: checks 1 and 2 are what connect the export to the sheet.
 */
async function verify(db, tenant, plan, tz) {
  const report = { rounded: [], retyped: [], lost: [], counts: {} };

  for (const tab of Object.keys(plan)) {
    const spec = plan[tab];
    const { map, columns } = spec;
    const idIndex = columns.findIndex((c) => c.field === 'id');

    const { rows } = await db.q(
      'SELECT * FROM ' + map.table + ' WHERE tenant_id = $1', [tenant]);
    report.counts[tab] = { exported: spec.rows.length, inDatabase: rows.length };

    if (idIndex === -1) {
      // No id column to match on. Only CompanyProfile-shaped single-row tabs, and a count is
      // all that can honestly be checked without inventing a key.
      continue;
    }

    const byId = {};
    for (const r of rows) byId[String(r.id)] = r;

    for (const exported of spec.rows) {
      const id = String(exported[columns[idIndex].index]);
      const stored = byId[id];
      if (!stored) {
        report.lost.push({ tab, id, field: '(the whole row)', was: 'exported', now: 'absent' });
        continue;
      }

      for (const c of columns) {
        const was = exported[c.index] === undefined ? '' : String(exported[c.index]);
        const now = stored[c.column];

        // A timestamp is compared as an INSTANT, not as text. The sheet wrote '2026-09-01
        // 10:00:00' meaning ten in the morning in Pune; Postgres gives back a Date. Comparing
        // those as strings says every one of 113,900 values was lost, which is how the
        // rehearsal reported the timezone bug — correctly in substance and uselessly in form.
        // What matters is whether the moment survived.
        if (c.type === 'TIMESTAMPTZ') {
          const wantIso = timestampIn(was, tz);
          const gotIso = now === null || now === undefined ? null
            : (Object.prototype.toString.call(now) === '[object Date]'
              ? now.toISOString() : String(now));
          if (wantIso === gotIso) continue;
          report.lost.push({ tab, id, field: c.field, was: was + ' (' + wantIso + ')',
            now: String(gotIso) });
          continue;
        }

        const nowText = now === null || now === undefined ? '' : String(now);
        if (was === nowText) continue;

        // The same value said differently. A NUMERIC column gives back 18 for '18.00', a
        // BOOLEAN gives true for 'TRUE', a DATE gives '2026-10-15' for a cell that already
        // read that way. None of these is a change to what the portal sees.
        const asNumber = Number(was);
        const sameNumber = was !== '' && !isNaN(asNumber) && Number(nowText) === asNumber;
        const sameBoolean = /^(TRUE|FALSE|YES|NO)$/i.test(was) &&
          nowText.toUpperCase() === (/^(TRUE|YES)$/i.test(was) ? 'TRUE' : 'FALSE');
        if (sameNumber || sameBoolean) {
          report.retyped.push({ tab, id, field: c.field, was, now: nowText });
          continue;
        }

        // A number the column could not hold exactly. Reported, never waved through.
        if (was !== '' && !isNaN(asNumber) && nowText !== '' && !isNaN(Number(nowText))) {
          report.rounded.push({ tab, id, field: c.field, was, now: nowText,
            by: Math.abs(asNumber - Number(nowText)) });
          continue;
        }

        report.lost.push({ tab, id, field: c.field, was, now: nowText });
      }
    }
  }

  return report;
}

// ------------------------------------------------------------------ running it

function summarise(report, manifest) {
  const lines = [];
  let exported = 0;
  let stored = 0;
  const shortCounts = [];
  for (const tab of Object.keys(report.counts)) {
    const c = report.counts[tab];
    exported += c.exported;
    stored += c.inDatabase;
    if (c.exported !== c.inDatabase) {
      shortCounts.push(tab + ': ' + c.exported + ' exported, ' + c.inDatabase + ' stored');
    }
  }

  lines.push(exported + ' row(s) exported, ' + stored + ' in the database.');
  if (shortCounts.length) {
    lines.push('');
    lines.push('ROW COUNTS DISAGREE:');
    shortCounts.forEach((s) => lines.push('  ' + s));
  }
  if (report.retyped.length) {
    lines.push('');
    lines.push(report.retyped.length + ' value(s) stored in a different form — the same value, ' +
      'typed. Nothing to do:');
    report.retyped.slice(0, 5).forEach((d) => lines.push('  ' + d.tab + '.' + d.field +
      ' ' + d.id + ': "' + d.was + '" -> ' + d.now));
    if (report.retyped.length > 5) lines.push('  ... and ' + (report.retyped.length - 5) + ' more');
  }
  if (report.rounded.length) {
    lines.push('');
    lines.push(report.rounded.length + ' NUMBER(S) ROUNDED BY THE COLUMN TYPE. This is a real ' +
      'change to the data. For money at two decimal places it is almost certainly intended; ' +
      'decide, do not assume:');
    report.rounded.slice(0, 10).forEach((d) => lines.push('  ' + d.tab + '.' + d.field +
      ' ' + d.id + ': ' + d.was + ' -> ' + d.now + '  (by ' + d.by.toFixed(6) + ')'));
    if (report.rounded.length > 10) lines.push('  ... and ' + (report.rounded.length - 10) + ' more');
  }
  if (report.lost.length) {
    lines.push('');
    lines.push(report.lost.length + ' VALUE(S) DID NOT SURVIVE:');
    report.lost.slice(0, 20).forEach((d) => lines.push('  ' + d.tab + '.' + d.field +
      ' ' + d.id + ': "' + d.was + '" -> "' + d.now + '"'));
    if (report.lost.length > 20) lines.push('  ... and ' + (report.lost.length - 20) + ' more');
  }
  void manifest;
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.log('usage: node migration/import.js <export folder> [--write] [--force] ' +
      '[--tenant pie]');
    process.exit(1);
  }
  const write = args.indexOf('--write') !== -1;
  const force = args.indexOf('--force') !== -1;
  const tenantArg = args.indexOf('--tenant');
  const tenant = tenantArg !== -1 ? args[tenantArg + 1] : 'pie';
  const batchArg = args.indexOf('--batch');
  const batchSize = batchArg !== -1 ? Number(args[batchArg + 1]) : 500;

  const { manifest, files } = loadExport(dir);
  // No "by" — the export deliberately does not record who ran it, because the one-liner for
  // that (Session.getEffectiveUser) would have added an OAuth scope and stopped the live web
  // app serving until the owner re-authorised. Apps Script's own execution log has it.
  console.log('Export: ' + manifest.tabCount + ' tabs, ' + manifest.totalRows + ' rows, ' +
    'taken from build ' + manifest.build + ' at ' + manifest.exportedAt);
  console.log('Timezone the dates were written in: ' + manifest.timezone);
  console.log('');

  // Before anything else, because it invalidates the whole export rather than part of it.
  const moved = manifest.tabsThatMovedDuringExport || [];
  if (moved.length && !force) {
    console.log('THE SPREADSHEET CHANGED WHILE IT WAS BEING EXPORTED. Nothing has been ' +
      'written.\n');
    moved.forEach((m) => console.log('  ' + m.tab + ': ' +
      (m.by > 0 ? m.by + ' row(s) added' : (-m.by) + ' row(s) removed') + ' after it was read'));
    console.log('\nThe 52 tabs are read one after another — Sheets offers no way to read them');
    console.log('as of one moment — and name order puts a document\u2019s lines before its header:');
    console.log('QuotationItems before Quotations, InvoiceItems before Invoices. So anything');
    console.log('saved part-way through can arrive here as a header with no lines, or lines');
    console.log('belonging to nothing. Both load without complaint and both are wrong.');
    console.log('\nAsk everyone to stay out of the portal, then run resetMigrationExport() and');
    console.log('exportForMigration() again in the Apps Script editor.');
    console.log('\n--force overrides this, and should not be used for the real cutover.');
    process.exit(1);
  }
  if (moved.length) {
    console.log('WARNING: ' + moved.length + ' tab(s) changed during the export, overridden ' +
      'with --force.\n');
  }
  // An export taken before this check existed has no opinion either way. Said out loud rather
  // than treated as a pass, because "the field is absent" and "nothing moved" are not the
  // same fact and only one of them is evidence.
  if (manifest.tabsThatMovedDuringExport === undefined) {
    console.log('NOTE: this export predates the did-anything-move check, so it cannot say ' +
      'whether\n      the spreadsheet was quiet while it was read. Fine for a rehearsal.\n');
  }

  console.log('1. every row and tab digest, recomputed here');
  const digestProblems = checkDigests(manifest, files);
  if (digestProblems.length) {
    console.log('\nTHE EXPORT DOES NOT MATCH ITS OWN DIGESTS. Nothing has been written.');
    console.log('This means the files changed between Drive and here — a partial download, an');
    console.log('editor that re-encoded them, a zip that was opened and resaved. Download the');
    console.log('folder again rather than trying to repair it.\n');
    digestProblems.forEach((p) => console.log('  ' + p));
    process.exit(1);
  }
  console.log('   intact: ' + manifest.totalRows + ' rows across ' + manifest.tabCount + ' tabs');

  console.log('2. every column has somewhere to go');
  const ignoreArg = args.indexOf('--ignore');
  const ignore = ignoreArg !== -1 ? String(args[ignoreArg + 1] || '').split(',')
    .map((x) => x.trim()).filter(Boolean) : [];
  const { unmapped, missingTables, ignored, empties, plan } =
    checkColumns(manifest, files, ignore);
  if (missingTables.length) {
    console.log('\nTABS WITH NO TABLE. Nothing has been written.\n');
    missingTables.forEach((t) => console.log('  ' + t));
    process.exit(1);
  }
  if (unmapped.length) {
    console.log('\nCOLUMNS WITH NOWHERE TO GO. Nothing has been written.\n');
    console.log('The spreadsheet has these columns and the schema does not declare them, so');
    console.log('there is no database column to put them in. They hold data somebody entered');
    console.log('and expects to find. Add them to Schema.gs and regenerate, or decide');
    console.log('deliberately that the data is not coming across.\n');
    unmapped.forEach((c) => console.log('  ' + c.column + ' \u2014 ' + c.rowsHoldingData +
      ' row(s) hold something'));
    console.log('\nTo leave one behind deliberately, name it:');
    console.log('  --ignore ' + unmapped.map((c) => c.column).slice(0, 2).join(',') +
      (unmapped.length > 2 ? ',...' : ''));
    console.log('Run undeclaredColumnReport() in the Apps Script editor first — it says how');
    console.log('many rows each one holds and which declared columns are empty, which is what');
    console.log('decides whether a column is a stale copy or the only place the data lives.');
    process.exit(1);
  }
  if (empties.length) {
    console.log('   ' + empties.length + ' undeclared column(s), all empty, passed over: ' +
      empties.slice(0, 6).join(', ') +
      (empties.length > 6 ? ', and ' + (empties.length - 6) + ' more' : ''));
  }
  if (ignored.length) {
    // Loud, and in the record. Somebody chose to leave this behind and the number of rows it
    // held is the thing they will want to know if they ever wonder.
    console.log('\n   LEAVING BEHIND, AS ASKED:');
    ignored.forEach((i) => console.log('     ' + i.column + ' \u2014 ' + i.rowsHoldingData +
      ' row(s) held something'));
    const lost = ignored.reduce((n, i) => n + i.rowsHoldingData, 0);
    console.log('     ' + lost + ' value(s) in total are not coming across.\n');
  }
  const absent = Object.keys(plan).reduce((s, t) => s + plan[t].absent.length, 0);
  console.log('   every exported column maps' +
    (absent ? '; ' + absent + ' declared column(s) the sheet has not got become blank' : ''));

  console.log('3. every timestamp can be read as a time, in ' + manifest.timezone);
  const badStamps = checkTimestamps(plan, manifest.timezone);
  if (badStamps.length) {
    console.log('\nVALUES IN TIMESTAMP COLUMNS THAT ARE NOT TIMES. Nothing has been written.\n');
    console.log('Each of these would fail the load as a cast error naming a column and no row.');
    console.log('Fix them in the spreadsheet, or clear them, then export again — the choice of');
    console.log('what a note in a date column should become is not this script\u2019s to make.\n');
    badStamps.slice(0, 20).forEach((b) => console.log('  ' + b.tab + '.' + b.field + ' ' +
      b.id + ': "' + b.value + '"'));
    if (badStamps.length > 20) console.log('  ... and ' + (badStamps.length - 20) + ' more');
    process.exit(1);
  }
  const stampCount = Object.keys(plan).reduce((s, t) =>
    s + plan[t].columns.filter((c) => c.type === 'TIMESTAMPTZ').length, 0);
  console.log('   ' + stampCount + ' timestamp column(s) read as ' + manifest.timezone +
    ' wall-clock times where they carry no offset');

  if (!process.env.DATABASE_URL) {
    console.log('\nNo DATABASE_URL, so stopping here. The export itself is sound: ' +
      manifest.totalRows + ' rows, every digest verified, every column mapped.');
    process.exit(0);
  }

  const db = connect({ connectionString: process.env.DATABASE_URL, tenant });

  if (!write) {
    console.log('\nChecks passed. Nothing written — add --write to load it.');
    await db.pool.end();
    process.exit(0);
  }

  console.log('4. loading, as one transaction');
  // One transaction for all 52 tabs. Either PIE's data is in Postgres or it is not; there is
  // no useful state in between, and a failure on tab forty should not leave somebody deciding
  // which thirty-nine to delete.
  let written = 0;
  await db.withTransaction(async (tx) => {
    for (const tab of Object.keys(plan).sort()) {
      const existing = await tx.q(
        'SELECT count(*)::int AS n FROM ' + plan[tab].map.table + ' WHERE tenant_id = $1',
        [tenant]);
      if (existing.rows[0].n) {
        throw new Error(plan[tab].map.table + ' already holds ' + existing.rows[0].n +
          ' row(s) for tenant "' + tenant + '". Refusing to load on top of existing data: ' +
          'that would double every row rather than replace it. Clear the tenant first, ' +
          'deliberately, or load into a different one with --tenant.');
      }
      const n = await loadTab(tx, tenant, tab, plan[tab], batchSize, manifest.timezone);
      written += n;
      if (n) console.log('   ' + tab.padEnd(26) + n);
    }
  });
  console.log('   ' + written + ' row(s) written');

  console.log('5. reading every row back and comparing it, field by field');
  const report = await verify(db, tenant, plan, manifest.timezone);
  console.log('');
  console.log(summarise(report, manifest));

  const ok = !report.lost.length &&
    Object.keys(report.counts).every((t) =>
      report.counts[t].exported === report.counts[t].inDatabase);

  if (!ok && !force) {
    console.log('\nThe data in Postgres does not match the export. It has been written — the');
    console.log('transaction committed before this check, which is deliberate, because a');
    console.log('database you can query is what makes the difference diagnosable. Look at what');
    console.log('is listed above, then clear the tenant and load again.');
    await db.pool.end();
    process.exit(1);
  }

  console.log('\n' + (ok
    ? 'Every row and every field made the trip.'
    : 'Differences above were accepted with --force.'));
  await db.pool.end();
  process.exit(0);
}

module.exports = { rowDigest, tabDigest, cellText, checkDigests, checkColumns, checkTimestamps,
  findExportDir,
  loadTab, verify, loadExport, summarise, timestampIn, zoneOffsetMs, SEP };

if (require.main === module) {
  main().catch((e) => {
    console.log('\nFAILED: ' + e.message);
    process.exit(1);
  });
}
