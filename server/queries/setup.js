/**
 * What "Run Setup" means when the storage is a database.
 *
 * Setup.gs builds the spreadsheet: it creates the 52 tabs, writes their header rows, adds a
 * column a new build needs, seeds the reference lists. None of that applies here — the tables
 * come from migration/schema.js, generated from the same Schema.gs, before the first row is
 * written. migration/missing.js has said so from the start: "Setup — not a rewrite,
 * migration/schema.js generates the DDL instead".
 *
 * But three of its functions are reached at RUNTIME from modules that do convert, so leaving
 * them to meet the spreadsheet refusal is not an option:
 *
 *   addMissingColumnsEverywhere_   CompanyProfile.gs, on the first load after a deployment
 *   schemaDrift_                   Settings.gs, for the System panel
 *   setupSheet                     Settings.gs, behind the "Run Setup" button
 *
 * The first was logging "a module reaching for a spreadsheet has not been migrated" on every
 * restart, which is not true of it — it had been thought about and is simply not applicable.
 * A warning that is wrong is worse than no warning, because the next real one looks like it.
 *
 * THE OTHER TWO BECOME MORE USEFUL HERE, NOT LESS. On a sheet, drift meant "a column the code
 * expects that the tab has not got", and Setup fixed it by appending one. A database answers
 * the same question exactly, out of information_schema, and the answer is worth more: a
 * column missing from Postgres is a migration that was not run, which is a real thing to know
 * and not something a button should quietly paper over. So drift is REPORTED and not
 * repaired, and "Run Setup" says what it found rather than pretending to have done something.
 */
'use strict';

/**
 * Every column Schema.gs declares that the database has not got, and every table missing.
 *
 * Same shape as the sheet version — { tab, missingTab, columns } — because Settings renders
 * it and the screen should not have to know which storage answered.
 */
async function schemaDrift_() {
  var wanted = Object.keys(SCHEMA);
  var tables = {};
  for (var i = 0; i < wanted.length; i++) {
    tables[mapFor_(wanted[i]).table] = wanted[i];
  }

  var found = await db.q(
    'SELECT table_name, column_name FROM information_schema.columns' +
    " WHERE table_schema = 'public' AND table_name = ANY($1)", [Object.keys(tables)]);

  var have = {};
  for (var r = 0; r < found.rows.length; r++) {
    var row = found.rows[r];
    (have[row.table_name] = have[row.table_name] || {})[row.column_name] = true;
  }

  var drift = [];
  for (var t = 0; t < wanted.length; t++) {
    var tab = wanted[t];
    var m = mapFor_(tab);
    var cols = have[m.table];
    if (!cols) { drift.push({ tab: tab, missingTab: true, columns: [] }); continue; }
    var missing = m.columns.filter(function (c) { return !cols[m.toDb[c]]; });
    if (missing.length) drift.push({ tab: tab, missingTab: false, columns: missing });
  }
  return drift;
}

/**
 * Nothing to add. The columns arrived with the table.
 *
 * Returns 0 rather than throwing, because its caller — applyBuildUpdates_ — also installs
 * standard quotation text and backfills usernames on the first load after a deployment, and
 * both of those still matter here.
 */
async function addMissingColumnsEverywhere_() {
  return 0;
}

/**
 * What "Run Setup" does now: look, and say.
 *
 * It does not create anything. On a spreadsheet it had to, because the sheet was the storage
 * and a missing tab meant a screen that threw. Here a missing table means the schema was
 * generated and not applied, or applied and then changed — a migration somebody needs to run
 * deliberately, with the DDL in front of them, not a button press that silently alters the
 * shape of a live database while PIE are quoting on it.
 */
async function setupSheet() {
  var drift = await schemaDrift_();

  var report = { created: [], columnsAdded: [], seeded: [], migrated: [], skipped: [] };
  for (var i = 0; i < drift.length; i++) {
    var d = drift[i];
    report.skipped.push(d.missingTab
      ? d.tab + ' — the whole table is missing from the database'
      : d.tab + ' — missing ' + d.columns.join(', '));
  }

  if (!drift.length) {
    report.skipped.push('Nothing to do: every table and column Schema.gs declares is in the ' +
      'database.');
    return report;
  }

  report.skipped.push('');
  report.skipped.push('These are not created from here. Run `node migration/schema.js` to ' +
    'see the DDL and apply it deliberately — a button that reshapes a live database while ' +
    'people are quoting on it is not a button this should have.');
  return report;
}

/**
 * Where the data lives, when it does not live in a spreadsheet.
 *
 * getSettings showed the sheet's name and a link to open it, which is the right thing to show
 * when the sheet IS the storage — the two most useful facts on that panel were "which
 * spreadsheet" and "click here to see it". Neither exists now, and reaching for them was
 * breaking the whole Settings screen rather than one line of it.
 *
 * What replaces them is the same question answered honestly: which database, which tenant,
 * and whether the schema matches what the code expects. The connection string is NOT shown —
 * it carries the password, and a settings panel is exactly the kind of screen somebody
 * screenshots.
 */
var SYSTEM_INFO_KEY_ = 'sys:info';
var SYSTEM_INFO_SECONDS_ = 600;

async function systemInfo_() {
  // Kept for ten minutes. Which database this is, and whether its shape matches the code,
  // only changes when the server starts — and the server brings the schema up to date as it
  // does. Asking afresh cost two round trips on every visit to Settings, one of them a read
  // of the catalogue of every column in the database.
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }
  if (cache) {
    var hit = cache.get(SYSTEM_INFO_KEY_);
    if (hit) {
      try { return JSON.parse(hit); } catch (err) { /* rebuilt below */ }
    }
  }

  var where = { host: '', database: '' };
  // Side by side rather than one after the other: neither needs the other's answer.
  var both = await Promise.all([
    db.q('SELECT current_database() AS d, inet_server_addr() AS a').then(function (res) {
      return res.rows[0];
    }, function () { return null; /* a panel must not be what stops the screen opening */ }),
    schemaDrift_()
  ]);
  if (both[0]) {
    where.database = both[0].d;
    where.host = both[0].a || 'local';
  }

  var info = {
    build: typeof APP_BUILD === 'string' ? APP_BUILD : 'unknown',
    drift: both[1],
    storage: 'PostgreSQL',
    databaseName: where.database,
    databaseHost: where.host,
    tenant: db.tenant,
    declaredTabs: Object.keys(SCHEMA).length,
    timeZone: Session.getScriptTimeZone()
  };
  if (cache) {
    try { cache.put(SYSTEM_INFO_KEY_, JSON.stringify(info), SYSTEM_INFO_SECONDS_); } catch (err) {
      /* too large to keep: still correct, just asked again next time */
    }
  }
  return info;
}
