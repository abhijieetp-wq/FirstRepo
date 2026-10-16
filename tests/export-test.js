/**
 * The migration export and import, as one round trip, plus the refusals.
 *
 * This is the code that runs once, for real, on the day PIE's data leaves the spreadsheet. By
 * then there is no second first attempt: the portal points at Postgres, the sheet stops being
 * written to, and anything the export missed is a quotation that no longer exists. So what is
 * tested here is not only that the happy path works — it is that every check in front of the
 * write actually fires when given something broken. A check that has never been seen to fail
 * is not a check.
 *
 * The data is chosen to be the awkward shapes rather than the ordinary ones: a date, a number
 * the column cannot hold exactly, a boolean as text, a blank cell, a blank row, a unicode
 * rupee sign, and a cell containing the character the digest uses as a separator.
 *
 *   DATABASE_URL=postgres://... node tests/export-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { load, reset, table } = require(path.join(__dirname, 'harness.js'));
const imp = require(path.join(__dirname, '..', 'migration', 'import.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const BOSS = { email: 'boss@pie.in', name: 'Boss', role: 'ERP Admin' };

/** Writes what the fake Drive captured into a real folder, as the person's download would. */
function drainDrive(sb, into) {
  fs.mkdirSync(into, { recursive: true });
  const folders = sb.DriveApp._folders;
  const ids = Object.keys(folders);
  const folder = folders[ids[ids.length - 1]];
  let written = 0;
  for (const file of folder._files) {
    if (file.trashed) continue;
    fs.writeFileSync(path.join(into, file.getName()), file.getBlob().getDataAsString());
    written++;
  }
  return { folder, written };
}

(async () => {
  const sb = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Code.gs', 'Export.gs']);
  sb.CURRENT_USER_ = BOSS;
  reset(sb);

  // A spare whose price has more precision than NUMERIC(14,2) can hold, a blank cell, a
  // unicode description, and — the nasty one — a value containing \u001f, the character the
  // digest joins cells with. If the digest did not account for that, two different rows could
  // hash the same and a verifier would pass on rows it had never actually compared.
  const spares = table('Spares');
  const col = (name) => spares.headers.indexOf(name);
  const row = (vals) => {
    const r = new Array(spares.headers.length).fill('');
    Object.keys(vals).forEach((k) => {
      const at = col(k);
      if (at !== -1) r[at] = vals[k];
    });
    return r;
  };
  spares.rows.push(row({ id: 'SP-1', partNo: 'P1', description: 'Airend kit',
    productGroup: 'Airend, Filters', gstPct: 18, reorderLevel: 5, active: 'TRUE', uom: 'Nos' }));
  spares.rows.push(row({ id: 'SP-2', partNo: 'P2', description: '₹ separator — 90μm',
    gstPct: 18, active: 'TRUE', uom: 'Nos' }));
  spares.rows.push(row({ id: 'SP-3', partNo: 'P3', description: 'has a\u001fseparator in it',
    gstPct: 12, active: 'FALSE', uom: 'Set' }));
  spares.rows.push(row({ id: 'SP-4', partNo: 'P4', description: '', active: 'TRUE' }));
  // A blank row, which readTable_ has always skipped and which must not be carried over or
  // every row count disagrees with what PIE sees today.
  spares.rows.push(new Array(spares.headers.length).fill(''));
  spares.rows.push(row({ id: 'SP-5', partNo: 'P5', description: 'last one', active: 'TRUE' }));

  // Timestamps, in the two forms the sheet actually holds them in. This is the bug the
  // full-size rehearsal found and the most serious one in the migration, so it is pinned here
  // where it runs in two seconds rather than only in a rehearsal nobody runs twice.
  const audit = table('AuditLog');
  const acol = (name) => audit.headers.indexOf(name);
  const arow = (vals) => {
    const r = new Array(audit.headers.length).fill('');
    Object.keys(vals).forEach((k) => { if (acol(k) !== -1) r[acol(k)] = vals[k]; });
    return r;
  };
  // What audit_ wrote on the sheet: PIE's wall clock, no offset, because
  // Utilities.formatDate(..., scriptTimeZone, 'yyyy-MM-dd HH:mm:ss') has nowhere to put one.
  audit.rows.push(arow({ id: 'AUD-1', timestamp: '2026-09-01 10:00:00',
    userEmail: 'coord@pie.in', action: 'Update', tableName: 'Quotations', recordId: 'QT-1',
    fieldName: 'status', oldValue: 'Draft', newValue: 'Sent', reason: 'Sent to customer' }));
  // What toISOString() wrote: an instant, unambiguous, and it must NOT be shifted again.
  audit.rows.push(arow({ id: 'AUD-2', timestamp: '2026-09-01T10:00:00.000Z',
    userEmail: 'coord@pie.in', action: 'Create', tableName: 'Spares', recordId: 'SP-1',
    fieldName: '', oldValue: '', newValue: '', reason: 'Imported' }));

  // A price with more decimals than the column holds, and a real Date object rather than a
  // string — which is what a cell formatted as a date actually gives back.
  const prices = table('PriceList');
  const pcol = (name) => prices.headers.indexOf(name);
  const prow = (vals) => {
    const r = new Array(prices.headers.length).fill('');
    Object.keys(vals).forEach((k) => {
      const at = pcol(k);
      if (at !== -1) r[at] = vals[k];
    });
    return r;
  };
  prices.rows.push(prow({ id: 'PRC-1', itemType: 'Spare', itemId: 'SP-1', itemCode: 'P1',
    priceLevel: 'ELGI', price: 1234.5, currency: 'INR',
    effectiveFrom: new Date(2026, 0, 15), active: 'TRUE' }));
  prices.rows.push(prow({ id: 'PRC-2', itemType: 'Spare', itemId: 'SP-2', itemCode: 'P2',
    priceLevel: 'ELGI', price: 100.456, currency: 'INR',
    effectiveFrom: '2026-02-01', active: 'TRUE' }));

  console.log('THE EXPORT WRITES EVERY TAB, AND SAYS WHAT IT WROTE');
  const text = sb.exportForMigration();
  ok('it reports completion rather than asking to be re-run', /Export complete/.test(text), text.slice(0, 90));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-export-'));
  const { written } = drainDrive(sb, dir);
  // Three tabs have rows (Spares, PriceList, AuditLog), so three part files, plus the
  // manifest. Tabs with nothing in them write no file at all.
  ok('a part file per non-empty tab, plus a manifest', written === 4, written);
  ok('the manifest is one of them', fs.existsSync(path.join(dir, '_manifest.json')));

  const { manifest, files } = imp.loadExport(dir);
  ok('the manifest counts all 52 tabs', manifest.tabCount === 52, manifest.tabCount);
  ok('and nine rows in all', manifest.totalRows === 9, manifest.totalRows);
  ok('it records which build the data came from', manifest.build === sb.APP_BUILD,
    [manifest.build, sb.APP_BUILD]);
  // Without this nobody can tell later whether a date in the file was IST or UTC, and every
  // date is a day ambiguous.
  ok('and the timezone the dates were written in', manifest.timezone === 'Asia/Kolkata',
    manifest.timezone);

  console.log('\nTHE BLANK ROW IS LEFT BEHIND, AS THE PORTAL ALWAYS LEFT IT');
  ok('five spares exported, not six', files.Spares.rowCount === 5, files.Spares.rowCount);
  ok('and it says it skipped one', files.Spares.blankRowsSkipped === 1,
    files.Spares.blankRowsSkipped);

  console.log('\nAND THE DIGESTS AGREE ACROSS TWO IMPLEMENTATIONS');
  // The point of this check: the hashing rule is written as prose in Export.gs and implemented
  // independently in import.js. Agreement is evidence about the data; one implementation
  // checking itself would be evidence of nothing.
  const problems = imp.checkDigests(manifest, files);
  ok('no disagreement anywhere', problems.length === 0, problems);
  ok('the row digest computed here matches the one Apps Script computed',
    imp.rowDigest(files.Spares.rows[0]) === files.Spares.rowDigests[0]);
  ok('including the row with a separator character in it',
    imp.rowDigest(files.Spares.rows[2]) === files.Spares.rowDigests[2]);
  // The tab digest is over its PARTS' digests, so that an export never holds every row's
  // digest at once. Two levels, and both have to agree.
  ok('and the tab digest over its parts',
    imp.tabDigest(files.Spares.partDigests) === files.Spares.digest);

  console.log('\nA DATE BECAME A DATE STRING, IN PIE’S TIMEZONE');
  const effFrom = files.PriceList.columns.indexOf('effectiveFrom');
  ok('the Date object became yyyy-MM-dd',
    files.PriceList.rows[0][effFrom] === '2026-01-15', files.PriceList.rows[0][effFrom]);
  ok('and a cell that was already text is unchanged',
    files.PriceList.rows[1][effFrom] === '2026-02-01', files.PriceList.rows[1][effFrom]);

  console.log('\nA WALL-CLOCK TIME BECOMES THE INSTANT IT ACTUALLY WAS');
  // 35 of the schema's columns are TIMESTAMPTZ and the sheet writes most of them with no
  // offset at all. Handed '2026-09-01 10:00:00', Postgres reads it in the SESSION's timezone,
  // which is UTC on any server anybody would run this on — so ten in the morning in Pune was
  // being stored and read back as ten in the morning UTC. Five and a half hours early, on
  // every audit entry, every session expiry and the createdAt of every record PIE has.
  ok('PIE\u2019s wall clock becomes the right instant',
    imp.timestampIn('2026-09-01 10:00:00', 'Asia/Kolkata') === '2026-09-01T04:30:00.000Z',
    imp.timestampIn('2026-09-01 10:00:00', 'Asia/Kolkata'));
  ok('and a value that already carries Z is left exactly alone',
    imp.timestampIn('2026-09-01T10:00:00.000Z', 'Asia/Kolkata') === '2026-09-01T10:00:00.000Z');
  ok('and so is one carrying an explicit offset',
    imp.timestampIn('2026-09-01T10:00:00+05:30', 'Asia/Kolkata') === '2026-09-01T04:30:00.000Z');
  ok('a bare date in a timestamp column is midnight in Pune, not midnight in UTC',
    imp.timestampIn('2026-09-01', 'Asia/Kolkata') === '2026-08-31T18:30:00.000Z',
    imp.timestampIn('2026-09-01', 'Asia/Kolkata'));
  ok('a blank is null, not the epoch', imp.timestampIn('', 'Asia/Kolkata') === null);
  // The rule is about timezones, not about India. A zone with daylight saving has to come out
  // right on both sides of it, or the rule is a hard-coded +05:30 wearing a disguise.
  ok('London in summer is +01:00',
    imp.timestampIn('2026-07-01 12:00:00', 'Europe/London') === '2026-07-01T11:00:00.000Z',
    imp.timestampIn('2026-07-01 12:00:00', 'Europe/London'));
  ok('and in winter is +00:00',
    imp.timestampIn('2026-01-01 12:00:00', 'Europe/London') === '2026-01-01T12:00:00.000Z',
    imp.timestampIn('2026-01-01 12:00:00', 'Europe/London'));

  console.log('\nAND A NOTE TYPED INTO A DATE COLUMN IS CAUGHT BEFORE THE WRITE');
  // Not hypothetical in this spreadsheet: 4,470 catalogue rows say "Will update shortly" where
  // an HSN code belongs. Without this check the first such cell fails inside the load, as a
  // Postgres cast error naming a column and no row, and takes the whole transaction with it.
  const noted = JSON.parse(JSON.stringify(files));
  noted.AuditLog.rows[0][noted.AuditLog.columns.indexOf('timestamp')] = 'will fill in later';
  const notedPlan = imp.checkColumns(manifest, noted).plan;
  const badStamps = imp.checkTimestamps(notedPlan, manifest.timezone);
  ok('it is found', badStamps.length === 1, badStamps);
  ok('and named with its row and column', badStamps.length &&
    badStamps[0].tab === 'AuditLog' && badStamps[0].field === 'timestamp' &&
    badStamps[0].id === 'AUD-1', badStamps[0]);
  ok('while the real timestamps are not flagged',
    imp.checkTimestamps(imp.checkColumns(manifest, files).plan, manifest.timezone).length === 0);

  console.log('\nAND SO DOES THE PORTAL\u2019S OWN CELL READER');
  // Not the exporter's code, but the same trap and worth pinning: readTable_ normalises a
  // Date to yyyy-MM-dd through normalizeCell_, and it used `instanceof Date`, which is false
  // for a Date made in another realm. No test had ever seeded a Date, so nothing was wrong —
  // but the next test to do it would have been checking behaviour the portal does not have.
  ok('readTable_ normalises a Date the same way the export does',
    sb.normalizeCell_(new Date(2026, 0, 15)) === '2026-01-15',
    sb.normalizeCell_(new Date(2026, 0, 15)));
  ok('and leaves everything else alone', sb.normalizeCell_('2026-01-15') === '2026-01-15' &&
    sb.normalizeCell_(18) === 18 && sb.normalizeCell_('') === '');

  console.log('\nAND A DRIVE FAULT IS RETRIED, THEN NAMED WITH ITS TAB');
  // The first real run against PIE's sheet died two minutes in with nothing but
  // "Exception: Service error: Drive" and two line numbers — no tab, no size, no clue
  // whether running it again was worth doing. Drive's service errors are overwhelmingly
  // transient, so they are now retried; and when they are not transient the message says
  // which of the 52 tabs it was.
  // Deliberately no reset() here. The harness keeps ONE set of tabs at module level, so
  // resetting a second sandbox empties the sheet the checks above and below are still using —
  // which is exactly what happened, and showed up as the tripwire reporting nothing moved.
  // Nothing in this section needs a sheet.
  const flaky = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Code.gs', 'Export.gs']);
  let refusals = 2;
  const realFolder = flaky.DriveApp.createFolder('retry-probe');
  const failTwice = Object.assign({}, realFolder, {
    createFile: (blob) => {
      if (refusals-- > 0) throw new Error('Service error: Drive');
      return realFolder.createFile(blob);
    }
  });
  let attempts = null;
  // Utilities.sleep is a no-op in the harness, so this does not actually wait 6 seconds.
  attempts = flaky.exportWriteFile_(failTwice, 'Spares.json', '{"x":1}', 'Spares', 5);
  ok('it keeps trying through a transient fault', attempts === 3, attempts);
  ok('and the file really did land',
    realFolder._files.filter((f) => !f.trashed && f.getName() === 'Spares.json').length === 1);

  refusals = 99;
  let gaveUp = null;
  try { flaky.exportWriteFile_(failTwice, 'PriceList.json', '{"x":1}', 'PriceList', 27363); }
  catch (e) { gaveUp = e.message; }
  ok('it gives up after three', /after 3 attempts/.test(String(gaveUp)), gaveUp);
  ok('and names the tab', /PriceList/.test(String(gaveUp)));
  ok('and how big it was, so a size problem is visible', /27363 row/.test(String(gaveUp)));
  ok('and repeats what Google actually said',
    /Service error: Drive/.test(String(gaveUp)));
  ok('and says running it again carries on from there',
    /again and it starts at this tab/.test(String(gaveUp)));

  console.log('\nAND THE STATUS IS ASKABLE WITHOUT DIGGING THROUGH DRIVE');
  const status = sb.migrationExportStatus();
  ok('it reports every tab done', /52 of 52 tabs done/.test(status), status.split('\n')[0]);
  ok('and the row count', /9 rows/.test(status), status.split('\n')[0]);
  // Same again: a sandbox of its own gives it empty Script Properties, which is all this
  // needs. reset() would take the sheet with it.
  const fresh = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Code.gs', 'Export.gs']);
  ok('and says so plainly when nothing has been exported',
    /Nothing exported yet/.test(fresh.migrationExportStatus()), fresh.migrationExportStatus());

  console.log('\nAND IT NOTICES IF SOMEBODY USED THE PORTAL MID-EXPORT');
  // The 52 tabs are read one after another, and name order puts a document's lines before its
  // header — QuotationItems before Quotations. A quotation saved between those two reads
  // arrives as a header with no lines, which loads without complaint and is wrong. The only
  // real answer is that nobody uses the portal during the export; this is the tripwire for
  // when somebody does.
  ok('a quiet spreadsheet reports nothing moved',
    Array.isArray(manifest.tabsThatMovedDuringExport) &&
    manifest.tabsThatMovedDuringExport.length === 0, manifest.tabsThatMovedDuringExport);

  // Somebody saves a quotation line while the export is between tabs.
  const qi = table('QuotationItems');
  qi.rows.push(new Array(qi.headers.length).fill('x'));
  const movedNow = sb.exportTabsThatMoved_(sb.exportDone_());
  ok('an appended row is caught', movedNow.length === 1, movedNow);
  ok('and named with the tab and how many',
    movedNow.length && movedNow[0].tab === 'QuotationItems' && movedNow[0].by === 1,
    movedNow[0]);
  qi.rows.pop();
  ok('and once it is undone, nothing moved again',
    sb.exportTabsThatMoved_(sb.exportDone_()).length === 0);

  console.log('\nAND A CORRUPTED ROW IS CAUGHT, NOT LOADED');
  // The failure this check exists for: a partial download, an editor that re-encoded the file,
  // a zip opened and resaved. One character changed in one cell of one row.
  const tampered = JSON.parse(JSON.stringify(files));
  tampered.Spares.rows[1][tampered.Spares.columns.indexOf('description')] = 'quietly different';
  const caught = imp.checkDigests(manifest, tampered);
  ok('it notices', caught.length > 0, caught);
  ok('and names the tab and the row', /Spares: 1 row\(s\) do not match/.test(caught[0]), caught);
  ok('and the part number, so somebody can look at it', /SP-2/.test(caught[0]), caught[0]);

  console.log('\nAND A ROW REMOVED FROM THE FILE IS CAUGHT TOO');
  // Every remaining row still matches its own digest, so only the counts and the tab digest
  // can see this.
  const short = JSON.parse(JSON.stringify(files));
  short.Spares.rows.splice(2, 1);
  short.Spares.rowDigests.splice(2, 1);
  const missed = imp.checkDigests(manifest, short);
  ok('the row count disagreement is reported',
    missed.some((p) => /holds 4 rows and says it holds 5/.test(p)), missed);

  console.log('\nAND A WHOLE PART FILE GOING MISSING IS CAUGHT');
  // The failure a per-row check cannot see: every row present is intact, but a file is stale
  // or absent. This is why the tab digest covers the parts.
  const lostPart = JSON.parse(JSON.stringify(files));
  lostPart.Spares.partDigests[0] = 'a digest from some other export';
  const partGone = imp.checkDigests(manifest, lostPart);
  ok('the tab digest notices', partGone.some((p) => /does not match its 1 part/.test(p)),
    partGone);

  console.log('\nAND A COLUMN WITH NOWHERE TO GO STOPS THE IMPORT');
  // Somebody adds a column to a tab by hand, because that is what a spreadsheet is for. It
  // holds data they entered and expect to find. Dropping it silently is the easiest way for
  // this migration to lose something nobody notices for a year.
  const extra = JSON.parse(JSON.stringify(files));
  extra.Spares.columns.push('scribbledNote');
  extra.Spares.rows.forEach((r) => r.push('remember to check this'));
  const cols = imp.checkColumns(manifest, extra);
  ok('it is refused rather than dropped',
    cols.unmapped.indexOf('Spares.scribbledNote') !== -1, cols.unmapped);
  ok('and nothing else is swept up with it', cols.unmapped.length === 1, cols.unmapped);

  console.log('\nWHILE A COLUMN THE SHEET HAS NOT GOT IS FINE, AND COUNTED');
  const lacking = JSON.parse(JSON.stringify(files));
  const dropped = lacking.Spares.columns.indexOf('safetyStock');
  lacking.Spares.columns.splice(dropped, 1);
  lacking.Spares.rows.forEach((r) => r.splice(dropped, 1));
  const lackPlan = imp.checkColumns(manifest, lacking);
  ok('it is not refused', lackPlan.unmapped.length === 0, lackPlan.unmapped);
  ok('but it is noticed', lackPlan.plan.Spares.absent.indexOf('safetyStock') !== -1,
    lackPlan.plan.Spares.absent);

  // LAST, deliberately. The harness holds ONE set of tabs at module level, so the
  // reset() below empties the sheet every check above is still using.
  console.log('\nA TAB BIGGER THAN ONE FILE IS SPLIT, AND STILL ADDS UP');
  // PIE's AuditLog and PriceList are far bigger than anything Drive took happily in one go,
  // and two real export attempts died on the Drive write. Nothing now goes to Drive bigger
  // than a few megabytes, and nothing is held in memory whole.
  const big = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Code.gs', 'Export.gs']);
  big.CURRENT_USER_ = BOSS;
  reset(big);
  const tel = table('Telemetry');
  const tAt = (n) => tel.headers.indexOf(n);
  for (let i = 0; i < 12000; i++) {
    const r = new Array(tel.headers.length).fill('');
    r[tAt('id')] = 'TLM-' + i;
    r[tAt('fn')] = 'suggestSpares';
    r[tAt('ms')] = 200 + (i % 700);
    tel.rows.push(r);
  }
  big.exportForMigration();
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-big-'));
  drainDrive(big, bigDir);
  const bigRead = imp.loadExport(bigDir);
  ok('12,000 rows were written in three files',
    bigRead.manifest.tabs.filter((t) => t.tab === 'Telemetry')[0].parts === 3,
    bigRead.manifest.tabs.filter((t) => t.tab === 'Telemetry')[0].parts);
  ok('and read back as one tab of 12,000',
    bigRead.files.Telemetry.rows.length === 12000, bigRead.files.Telemetry.rows.length);
  ok('in the right order', bigRead.files.Telemetry.rows[0][tAt('id')] === 'TLM-0' &&
    bigRead.files.Telemetry.rows[11999][tAt('id')] === 'TLM-11999',
    [bigRead.files.Telemetry.rows[0][tAt('id')], bigRead.files.Telemetry.rows[11999][tAt('id')]]);
  ok('and every digest still agrees', imp.checkDigests(bigRead.manifest, bigRead.files).length === 0,
    imp.checkDigests(bigRead.manifest, bigRead.files).slice(0, 3));
  // The point of splitting: no single file big enough for Drive to refuse.
  const sizes = fs.readdirSync(bigDir).map((f) => fs.statSync(path.join(bigDir, f)).size);
  ok('and no single file is large', Math.max.apply(null, sizes) < 2 * 1024 * 1024,
    Math.round(Math.max.apply(null, sizes) / 1024) + ' KB');
  fs.rmSync(bigDir, { recursive: true, force: true });

  console.log('\nAND THE PROGRESS RECORD STAYS INSIDE APPS SCRIPT\u2019S 9 KB');
  // The bug that made finishing impossible regardless of Drive: the progress property held
  // every tab's full column list, 9,478 bytes of column names alone, and crossed the limit
  // at around the 28th of 52 tabs. setProperty throws there and the run can never complete.
  const record = big.exportDone_();
  ok('all 52 tabs are recorded', Object.keys(record).length === 52, Object.keys(record).length);
  ok('and the record is well inside the limit', JSON.stringify(record).length < 9000,
    JSON.stringify(record).length + ' bytes');
  ok('because it holds no column names',
    !/\bpartNo\b|\bquoteNo\b/.test(JSON.stringify(record)));

  // ---------------------------------------------------------------- against a real database
  if (!process.env.DATABASE_URL) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\nno DATABASE_URL — the loading half is skipped');
    console.log('\n' + (failures.length
      ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
      : 'all ' + pass + ' passed'));
    process.exit(failures.length ? 1 : 0);
  }

  const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
  const TENANT = 'export-test';
  const db = connect({ connectionString: process.env.DATABASE_URL, tenant: TENANT });
  const tables = Object.keys(manifest.tabs.reduce((a, t) => {
    try { a[imp.checkColumns(manifest, files).plan[t.tab].map.table] = 1; } catch (e) { /* */ }
    return a;
  }, {}));
  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);

  console.log('\nIT LOADS, AND EVERY FIELD SURVIVES');
  const { plan } = imp.checkColumns(manifest, files);
  let loaded = 0;
  await db.withTransaction(async (tx) => {
    for (const tab of Object.keys(plan).sort()) {
      loaded += await imp.loadTab(tx, TENANT, tab, plan[tab], 500, manifest.timezone);
    }
  });
  ok('every exported row was written', loaded === manifest.totalRows,
    [loaded, manifest.totalRows]);

  const report = await imp.verify(db, TENANT, plan, manifest.timezone);
  ok('nothing was lost', report.lost.length === 0, report.lost.slice(0, 5));
  ok('and the counts agree tab for tab',
    Object.keys(report.counts).every((t) =>
      report.counts[t].exported === report.counts[t].inDatabase),
    Object.keys(report.counts).filter((t) =>
      report.counts[t].exported !== report.counts[t].inDatabase));

  console.log('\nAND THE ROUNDING IS REPORTED RATHER THAN HIDDEN');
  // 100.456 into NUMERIC(14,2) is 100.46. A real change to PIE's data, almost certainly what
  // everybody wants for money, and not something to learn about from a customer.
  const rounded = report.rounded.filter((d) => d.field === 'price');
  ok('the over-precise price is listed', rounded.length === 1, report.rounded);
  ok('with what it was and what it became',
    rounded.length && rounded[0].was === '100.456' && rounded[0].now === '100.46', rounded[0]);
  ok('and by how much', rounded.length && Math.abs(rounded[0].by - 0.004) < 1e-9, rounded[0]);
  ok('while the price that fitted is not listed',
    !report.rounded.some((d) => d.was === '1234.5'), report.rounded);

  console.log('\nAND A VALUE STORED IN A DIFFERENT FORM IS NOT CALLED A LOSS');
  // 'TRUE' becomes a boolean and 18 becomes a NUMERIC. The portal reads both exactly as
  // before; calling them differences would bury the two kinds that matter.
  ok('the boolean is counted as retyped, not lost',
    report.retyped.some((d) => d.field === 'active'), report.retyped.slice(0, 4));
  ok('and nothing about active is in the losses',
    !report.lost.some((d) => d.field === 'active'), report.lost.slice(0, 4));

  console.log('\nAND THE AWKWARD VALUES CAME THROUGH INTACT');
  const stored = {};
  (await db.readTable('Spares')).forEach((r) => { stored[r.id] = r; });
  ok('the rupee sign and the micron symbol',
    stored['SP-2'].description === '₹ separator — 90μm',
    stored['SP-2'].description);
  ok('the separator character inside a cell',
    stored['SP-3'].description === 'has a\u001fseparator in it', stored['SP-3'].description);
  ok('a blank description is blank, not null and not the word null',
    stored['SP-4'].description === '', JSON.stringify(stored['SP-4'].description));
  ok('and the blank row did not become a row', Object.keys(stored).length === 5,
    Object.keys(stored));

  console.log('\nAND THE TIMESTAMPS LANDED AS THE RIGHT MOMENTS');
  const log = {};
  (await db.q('SELECT id, "timestamp" FROM audit_log WHERE tenant_id = $1', [TENANT]))
    .rows.forEach((r) => { log[r.id] = r.timestamp; });
  ok('the wall-clock one is 04:30Z, which is 10am in Pune',
    log['AUD-1'].toISOString() === '2026-09-01T04:30:00.000Z',
    log['AUD-1'] && log['AUD-1'].toISOString());
  ok('and the one that was already an instant did not move again',
    log['AUD-2'].toISOString() === '2026-09-01T10:00:00.000Z',
    log['AUD-2'] && log['AUD-2'].toISOString());
  ok('and neither is reported as a loss, though neither matches as text',
    !report.lost.some((d) => d.field === 'timestamp'),
    report.lost.filter((d) => d.field === 'timestamp'));

  console.log('\nAND THERE IS A WAY BACK IN IF THE GOOGLE GATE BREAKS');
  // Not about the export, but it is about the same cutover and it is the gap that locks
  // everybody out. Switching the Google requirement off goes through setGoogleGate, which
  // starts with getCurrentUser() — and that needs a portal session, which needs the gate to
  // let you past it. So when the gate itself stops working, its only control is behind it.
  //
  // It stops working for one ordinary reason: the client secret stored in the project is sent
  // to Google's token endpoint on every sign-in, and rotating that secret in the Cloud console
  // — which one should do, and which was done — kills the stored copy.
  const gate = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Session.gs', 'GoogleGate.gs', 'Code.gs'], {
    GOOGLE_GATE: 'on', GOOGLE_GATE_CLIENT_ID: 'x.apps.googleusercontent.com',
    GOOGLE_GATE_CLIENT_SECRET: 'the-rotated-away-one',
    GOOGLE_GATE_ACCOUNTS: 'boss@imcglobal.in'
  });
  reset(gate);
  ok('the requirement starts on, as PIE has it', gate.googleGateEnforced_() === true);
  const said = gate.disableGoogleGate();
  ok('it switches off', gate.googleGateEnforced_() === false);
  ok('and says so in words somebody can act on', /requirement is OFF/.test(said),
    said.slice(0, 60));
  // Off, not unconfigured. Switching it back on once the new secret is in must not mean
  // setting the whole thing up again.
  ok('the accounts list is kept',
    gate.googleGateAccounts_().indexOf('boss@imcglobal.in') !== -1, gate.googleGateAccounts_());
  ok('and the client id', gate.googleGateClientId_() === 'x.apps.googleusercontent.com');
  const twice = gate.disableGoogleGate();
  ok('running it again is not an error', /already off/.test(twice), twice.slice(0, 50));
  // The one that matters: its authority is that Google checked who opened the editor, so
  // anybody holding the /exec URL must not be able to switch an access control off.
  ok('it is on the web app\u2019s deny list',
    gate.CALL_DENY_.indexOf('disableGoogleGate') !== -1, gate.CALL_DENY_);
  let reached = null;
  try { gate.call('not-a-token', 'disableGoogleGate', []); } catch (e) { reached = e.message; }
  ok('and the web app door refuses it', reached !== null, reached);

  console.log('\nAND LOADING TWICE IS REFUSED, NOT DOUBLED');
  // The mistake anybody would make: run it again because the first run looked wrong. Without
  // this, PIE's catalogue silently becomes two of everything.
  let again = null;
  try {
    await db.withTransaction(async (tx) => {
      const n = await tx.q('SELECT count(*)::int AS n FROM spares WHERE tenant_id = $1',
        [TENANT]);
      if (n.rows[0].n) throw new Error('spares already holds ' + n.rows[0].n + ' row(s)');
      await imp.loadTab(tx, TENANT, 'Spares', plan.Spares, 500, manifest.timezone);
    });
  } catch (e) { again = e.message; }
  ok('it refuses', /already holds 5/.test(String(again)), again);
  ok('and the catalogue is still five rows',
    (await db.readTable('Spares')).length === 5);

  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  await db.pool.end();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
