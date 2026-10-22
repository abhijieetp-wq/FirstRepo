/**
 * Every record in the database, as one file that migration/import.js loads into another one.
 *
 * Switching database — another Neon project, another provider, a fresh one after an accident —
 * is otherwise a job for somebody with database tools and the connection string. This makes it
 * a button: Settings → System → Download All Data, then the same import the cutover uses.
 *
 * THE SAME FORMAT AS THE CUTOVER EXPORT (src/Export.gs), on purpose. One JSON file per tab per
 * 5,000 rows, a manifest, a digest on every row and on every tab. migration/import.js already
 * checks all of that before it writes a thing and reads every row back afterwards; a second
 * format would have needed a second importer, untested on the day it mattered. The digest rule
 * is the one written out in Export.gs — cells as text, joined with \u001f, SHA-256, base64 — and
 * the importer recomputes it with its own code, so a file that changed on the way is refused.
 *
 * ONE MOMENT IN TIME. Every table is read inside one REPEATABLE READ transaction, so the file
 * is the database as it stood at a single instant: a quotation saved while the export runs is
 * either in it with all its lines or not in it at all. The Sheet could not offer that, which is
 * why its export has a tripwire instead; here the list of tabs that moved is honestly empty.
 *
 * WHAT IS IN IT. Every table Schema.gs declares, Users and Sessions among them. A session is
 * held as a fingerprint of its token, never the token, so the file is not a set of keys — and
 * because the fingerprints come across, people stay signed in through a switch.
 *
 * WHAT IS NOT. The server's settings table (the Tally address and the Google sign-in, re-entered
 * in Settings after a switch, and kept out because it holds a client secret), and the
 * attachments themselves, which live on the server's disk rather than in the database. The
 * Documents table — what is attached to what — is in it.
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { mapFor, SCHEMA } = require('./db.js');

const ROWS_PER_FILE = 5000;
const SEP = '\u001f';

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

/**
 * One value as the text the export carries: what the portal itself would show.
 *
 * Dates stay yyyy-MM-dd and timestamps become ISO instants ending in Z, which the importer
 * takes as they are rather than reading them in PIE's timezone. Blank is the empty string, as
 * a blank cell always was.
 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function partName(tab, part) {
  return tab + '.' + (part < 10 ? '0' + part : String(part)) + '.json';
}

/**
 * Reads every declared table for this tenant, at one instant, into export files.
 *
 * @return { files: [{ name, text }], manifest }
 */
async function buildExport(db, tenant, opts) {
  const o = opts || {};
  const tabs = Object.keys(o.schema || SCHEMA).sort();
  const files = [];
  const entries = [];
  let total = 0;
  const startedAt = new Date().toISOString();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const tab of tabs) {
      const m = mapFor(tab);
      let rows;
      try {
        ({ rows } = await client.query(
          'SELECT * FROM ' + m.table + ' WHERE tenant_id = $1', [tenant]));
      } catch (err) {
        throw new Error('Could not read ' + tab + ' (' + m.table + '): ' + err.message);
      }

      const partDigests = [];
      let part = 0;
      for (let start = 0; start < rows.length; start += ROWS_PER_FILE) {
        const block = rows.slice(start, start + ROWS_PER_FILE);
        const cells = block.map((r) => m.columns.map((c) => cellText(r[m.toDb[c]])));
        const rowDigests = cells.map((c) => sha(c.join(SEP)));
        const digest = sha(rowDigests.join('\n'));
        part++;
        partDigests.push(digest);
        files.push({
          name: partName(tab, part),
          text: JSON.stringify({ tab, part, columns: m.columns, rowCount: cells.length,
            digest, rowDigests, rows: cells })
        });
      }

      total += rows.length;
      entries.push({ tab, rowCount: rows.length, parts: part, columns: m.columns.slice(),
        digest: sha(partDigests.join('\n')), blankRowsSkipped: 0 });
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is going anyway */ }
    throw err;
  } finally {
    client.release();
  }

  const manifest = {
    build: o.build || 'unknown',
    source: 'database',
    tenant,
    exportedAt: new Date().toISOString(),
    startedAt,
    // Only read for timestamps without an offset, and every one here carries Z. Recorded so
    // the importer's report reads the same as it does for a Sheet export.
    timezone: o.timezone || 'Asia/Kolkata',
    tabCount: entries.length,
    totalRows: total,
    tabs: entries,
    columnsNotInSchema: [],
    columnsNotInSheet: [],
    // One snapshot, so nothing can have moved between one table and the next.
    tabsThatMovedDuringExport: []
  };
  files.unshift({ name: '_manifest.json', text: JSON.stringify(manifest, null, 2) });
  return { files, manifest };
}

// ------------------------------------------------------------------ the zip

/** The DOS date and time a zip header carries. */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/**
 * A plain .zip of the given files, deflated, inside one folder.
 *
 * Written here rather than pulled in as a dependency: it is sixty lines of a format that has not
 * changed since 1993, and Windows' own Extract All opens it. No zip64, so it refuses past
 * 4 GB or 65,535 files — PIE's whole database is a few tens of megabytes before compression.
 */
function zip(folder, files, when) {
  const stamp = dosTime(when || new Date());
  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(folder + '/' + f.name, 'utf8');
    const data = Buffer.isBuffer(f.text) ? f.text : Buffer.from(f.text, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 6 });
    const crc = zlib.crc32(data) >>> 0;
    if (offset + packed.length > 0xffffffff || data.length > 0xffffffff) {
      throw new Error('The export is too large for a plain zip.');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // names are UTF-8
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);            // made by
    head.writeUInt16LE(20, 6);            // needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(stamp.time, 12);
    head.writeUInt16LE(stamp.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30);            // extra
    head.writeUInt16LE(0, 32);            // comment
    head.writeUInt16LE(0, 34);            // disk
    head.writeUInt16LE(0, 36);            // internal attributes
    head.writeUInt32LE(0, 38);            // external attributes
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += local.length + name.length + packed.length;
  }

  if (files.length > 0xffff) throw new Error('Too many files for a plain zip.');
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(locals.concat([cd, end]));
}

/** The folder name inside the zip, and the file's own name: when, to the minute. */
function exportName(appName, when) {
  const d = when || new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  const label = String(appName || 'ERP').replace(/[^A-Za-z0-9 ]+/g, '').trim() || 'ERP';
  return label + ' data export ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' +
    p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes());
}

module.exports = { buildExport, zip, exportName, cellText };
