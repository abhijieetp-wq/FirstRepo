/**
 * The export and load at PIE's real size, timed, before the day it matters.
 *
 * Two numbers decide whether the cutover is an afternoon or a problem, and neither can be
 * guessed:
 *
 *   Does the export finish inside Apps Script's six minutes? It hashes every row in pure
 *   JavaScript — 27,000 of them for the PriceList alone — because a host call per row would
 *   be minutes of pure overhead. Pure JavaScript in V8 should be fast. "Should be" is not a
 *   number, and the limit is a hard kill with no warning and no way to catch it.
 *
 *   How long does the load take against Neon, which is a database at the other end of the
 *   internet rather than a socket on the same machine? Every batch is a round trip.
 *
 * So this builds a dataset the size of PIE's — from the actual ELGi files where they are to
 * hand, synthesised at the same scale where they are not — runs the real export through the
 * test harness, and loads it. The export code is the real one. What is faked is the
 * spreadsheet underneath it, which is the only part that cannot be.
 *
 * Apps Script's V8 is not Node's: it is slower, and it is sharing a machine. Treat a number
 * from here as a lower bound and leave room — if the export takes two minutes here, it may
 * take four there, and four is inside the limit only just.
 *
 *   node migration/rehearse.js                  export only, timed
 *   DATABASE_URL=... node migration/rehearse.js --load    and load it
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { load, reset, table } = require('../tests/harness.js');
const imp = require('./import.js');

const SCALE = {
  // What PIE actually has, from the import count the portal reports and the files in imports/.
  Spares: 13587,
  PriceList: 27363,
  // The rest of the business, which the telemetry put at 79 rows across fourteen tabs. Scaled
  // up generously: a year of trading rather than the three months they have.
  Customers: 400,
  Quotations: 1200,
  QuotationItems: 6000,
  SalesOrders: 600,
  SalesOrderItems: 3000,
  Invoices: 550,
  InvoiceItems: 2800,
  StockMovements: 9000,
  AuditLog: 40000,
  Telemetry: 20000
};

/** Realistic part numbers and descriptions, from the real files when they are present. */
function realParts(want) {
  const dir = path.join(__dirname, '..', 'imports');
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.csv'))) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
      const header = (lines[0] || '').split(',').map((h) => h.trim());
      const at = { partNo: header.indexOf('partNo'), description: header.indexOf('description'),
        hsnCode: header.indexOf('hsnCode'), productGroup: header.indexOf('productGroup') };
      if (at.partNo === -1) continue;
      for (let i = 1; i < lines.length && out.length < want; i++) {
        const c = lines[i].split(',');
        if (!c[at.partNo]) continue;
        out.push({
          partNo: String(c[at.partNo]).trim(),
          description: at.description === -1 ? '' : String(c[at.description] || '').trim(),
          hsnCode: at.hsnCode === -1 ? '' : String(c[at.hsnCode] || '').trim(),
          productGroup: at.productGroup === -1 ? '' : String(c[at.productGroup] || '').trim()
        });
      }
      if (out.length >= want) break;
    }
  }
  // Topped up rather than refused when the files are not in this checkout: imports/ is
  // gitignored as commercially sensitive, so a clone has none of it, and the timing question
  // is about volume rather than about whose part numbers they are.
  while (out.length < want) {
    const n = out.length;
    out.push({
      partNo: 'SYN-' + String(n).padStart(6, '0'),
      description: 'Synthesised part ' + n + ' — separator element, 90μm',
      hsnCode: '84143000',
      productGroup: ['Airend', 'Filters', 'Separators', 'Hoses'][n % 4]
    });
  }
  return out.slice(0, want);
}

function fill(sb, tab, count, make) {
  const t = table(tab);
  const at = {};
  t.headers.forEach((h, i) => { at[h] = i; });
  for (let i = 0; i < count; i++) {
    const row = new Array(t.headers.length).fill('');
    const vals = make(i);
    for (const k of Object.keys(vals)) {
      if (at[k] !== undefined) row[at[k]] = vals[k];
    }
    t.rows.push(row);
  }
  void sb;
}

function human(ms) {
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main() {
  const wantLoad = process.argv.indexOf('--load') !== -1;

  console.log('Building a spreadsheet the size of PIE’s...');
  const sb = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Sha256.gs',
    'Code.gs', 'Export.gs']);
  sb.CURRENT_USER_ = { email: 'boss@pie.in', role: 'ERP Admin' };
  reset(sb);

  const parts = realParts(SCALE.Spares);
  const realCount = parts.filter((p) => !p.partNo.startsWith('SYN-')).length;

  fill(sb, 'Spares', SCALE.Spares, (i) => Object.assign({
    id: 'SP-' + String(i).padStart(6, '0'), active: 'TRUE', uom: 'Nos', gstPct: 18,
    brand: 'ELGI', createdAt: '2026-10-01', createdBy: 'import@pie.in'
  }, parts[i]));

  fill(sb, 'PriceList', SCALE.PriceList, (i) => ({
    id: 'PRC-' + String(i).padStart(6, '0'),
    itemType: 'Spare', itemId: 'SP-' + String(i % SCALE.Spares).padStart(6, '0'),
    itemCode: parts[i % SCALE.Spares].partNo,
    priceLevel: i % 2 === 0 ? 'ELGI' : 'PIE',
    // A spread of magnitudes and some genuinely over-precise values, because what the load
    // does to those is the thing the verifier has to report.
    price: Math.round((100 + (i % 90000)) * 100) / 100 + (i % 7 === 0 ? 0.004 : 0),
    currency: 'INR', effectiveFrom: new Date(2026, 0, 1 + (i % 28)),
    active: 'TRUE', createdAt: '2026-10-01', createdBy: 'import@pie.in'
  }));

  fill(sb, 'Customers', SCALE.Customers, (i) => ({
    id: 'CUS-' + i, customerCode: 'C' + String(i).padStart(4, '0'),
    name: 'Customer ' + i + ' Pvt Ltd', gstin: '27AAAAA' + String(1000 + i) + 'A1Z5',
    territory: ['Pune', 'Mumbai', 'Nashik'][i % 3], creditLimit: 500000, creditDays: 30,
    active: 'TRUE', createdAt: '2026-08-01', createdBy: 'boss@pie.in'
  }));
  fill(sb, 'Quotations', SCALE.Quotations, (i) => ({
    id: 'QT-' + i, quoteNo: 'PIE/ELGI/QUOT/26-27/' + (400 + i), revision: 'R0',
    date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0'),
    customerId: 'CUS-' + (i % SCALE.Customers), businessStream: 'Spares',
    status: ['Draft', 'Sent', 'Won', 'Lost'][i % 4], grand: 10000 + i,
    subtotal: 8475 + i, taxAmt: 1525, locked: i % 4 >= 2 ? 'TRUE' : 'FALSE',
    preparedBy: 'coord@pie.in', createdAt: '2026-09-01', createdBy: 'coord@pie.in'
  }));
  fill(sb, 'QuotationItems', SCALE.QuotationItems, (i) => ({
    id: 'QI-' + i, quotationId: 'QT-' + (i % SCALE.Quotations), lineNo: (i % 5) + 1,
    itemType: 'Spare', itemId: 'SP-' + String(i % SCALE.Spares).padStart(6, '0'),
    itemCode: parts[i % SCALE.Spares].partNo, description: parts[i % SCALE.Spares].description,
    qty: (i % 9) + 1, uom: 'Nos', unitPrice: 1200.5, discountPct: 0, taxPct: 18,
    lineTotal: 1200.5 * ((i % 9) + 1)
  }));
  fill(sb, 'SalesOrders', SCALE.SalesOrders, (i) => ({
    id: 'SO-' + i, orderNo: 'PIE/SO/26-27/' + (100 + i), date: '2026-09-15',
    customerId: 'CUS-' + (i % SCALE.Customers), orderStatus: 'Invoiced', grand: 20000 + i,
    createdAt: '2026-09-15', createdBy: 'coord@pie.in'
  }));
  fill(sb, 'SalesOrderItems', SCALE.SalesOrderItems, (i) => ({
    id: 'SOI-' + i, salesOrderId: 'SO-' + (i % SCALE.SalesOrders), lineNo: (i % 5) + 1,
    itemType: 'Spare', itemId: 'SP-' + String(i % SCALE.Spares).padStart(6, '0'),
    qty: 2, qtyReserved: 2, qtyDispatched: 2, qtyInvoiced: 2, unitPrice: 999.99
  }));
  fill(sb, 'Invoices', SCALE.Invoices, (i) => ({
    id: 'INV-' + i, invoiceNo: 'PIE/INV/26-27/' + (200 + i), invoiceDate: '2026-09-20',
    customerId: 'CUS-' + (i % SCALE.Customers), grand: 20000 + i, amountReceived: i % 2 ? 0 : 20000 + i,
    status: 'Issued', tallySyncStatus: 'Synced', createdAt: '2026-09-20', createdBy: 'coord@pie.in'
  }));
  fill(sb, 'InvoiceItems', SCALE.InvoiceItems, (i) => ({
    id: 'INI-' + i, invoiceId: 'INV-' + (i % SCALE.Invoices), lineNo: (i % 5) + 1,
    itemType: 'Spare', itemId: 'SP-' + String(i % SCALE.Spares).padStart(6, '0'),
    qty: 2, unitPrice: 999.99, taxPct: 18, lineTotal: 1999.98
  }));
  fill(sb, 'StockMovements', SCALE.StockMovements, (i) => ({
    id: 'MOV-' + i, timestamp: '2026-09-01 10:00:00', movementDate: '2026-09-01',
    itemType: 'Spare', itemId: 'SP-' + String(i % SCALE.Spares).padStart(6, '0'),
    movementType: i % 3 === 0 ? 'Inward' : 'Dispatch', qty: i % 3 === 0 ? 10 : -2,
    warehouseId: 'WH-MAIN', enteredBy: 'store@pie.in'
  }));
  fill(sb, 'AuditLog', SCALE.AuditLog, (i) => ({
    id: 'AUD-' + i, timestamp: '2026-09-01 10:00:00', userEmail: 'coord@pie.in',
    action: 'Update', tableName: 'Quotations', recordId: 'QT-' + (i % SCALE.Quotations),
    fieldName: 'status', oldValue: 'Draft', newValue: 'Sent', reason: 'Sent to customer'
  }));
  fill(sb, 'Telemetry', SCALE.Telemetry, (i) => ({
    id: 'TLM-' + i, at: '2026-09-01T10:00:00Z', fn: 'suggestSpares', ms: 200 + (i % 800),
    err: '', userEmail: 'coord@pie.in'
  }));

  const rows = Object.keys(SCALE).reduce((s, t) => s + SCALE[t], 0);
  console.log('  ' + rows.toLocaleString() + ' rows across ' + Object.keys(SCALE).length +
    ' populated tabs (of 52)' +
    (realCount ? ', ' + realCount.toLocaleString() + ' of them real ELGi part numbers' : ''));
  console.log('');

  console.log('Running the real exportForMigration()...');
  const t0 = Date.now();
  const text = sb.exportForMigration();
  const exportMs = Date.now() - t0;
  const finished = /Export complete/.test(text);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-rehearse-'));
  const folders = sb.DriveApp._folders;
  const folder = folders[Object.keys(folders).pop()];
  let total = 0;
  const sizes = [];
  for (const file of folder._files) {
    if (file.trashed) continue;
    const content = file.getBlob().getDataAsString();
    fs.writeFileSync(path.join(dir, file.getName()), content);
    total += content.length;
    sizes.push([file.getName(), content.length]);
  }

  console.log('  ' + human(exportMs) + ' in Node' +
    (finished ? '' : '  — AND IT DID NOT FINISH IN ONE PASS'));
  console.log('  Apps Script stops an execution at 6 minutes (360s) and its V8 is slower than');
  console.log('  this one. The export stops itself at 4m30s and resumes, so a long run is');
  console.log('  safe — but a single tab that cannot finish inside the budget would not be.');
  const worst = sizes.slice().sort((a, b) => b[1] - a[1])[0];
  console.log('  biggest single tab: ' + worst[0] + ' at ' + bytes(worst[1]));
  console.log('  ' + sizes.length + ' files, ' + bytes(total) + ' in all to download');
  console.log('');

  console.log('Checking the digests from the other side...');
  const t1 = Date.now();
  const { manifest, files } = imp.loadExport(dir);
  const problems = imp.checkDigests(manifest, files);
  console.log('  ' + human(Date.now() - t1) + ', ' +
    (problems.length ? problems.length + ' PROBLEM(S)' : 'every row and every tab intact'));
  if (problems.length) problems.slice(0, 5).forEach((p) => console.log('    ' + p));

  const { unmapped, plan } = imp.checkColumns(manifest, files);
  if (unmapped.length) {
    console.log('  columns with nowhere to go: ' + unmapped.join(', '));
  }
  console.log('');

  if (!wantLoad || !process.env.DATABASE_URL) {
    console.log(wantLoad ? 'No DATABASE_URL, so not loading.'
      : 'Pass --load with DATABASE_URL set to time the load as well.');
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  const { connect } = require('../server/db.js');
  const TENANT = 'rehearsal';
  const db = connect({ connectionString: process.env.DATABASE_URL, tenant: TENANT });
  const tabs = Object.keys(plan).sort();
  for (const tab of tabs) {
    await db.q('DELETE FROM ' + plan[tab].map.table + ' WHERE tenant_id = $1', [TENANT]);
  }

  console.log('Loading, as one transaction...');
  const t2 = Date.now();
  let written = 0;
  await db.withTransaction(async (tx) => {
    for (const tab of tabs) written += await imp.loadTab(tx, TENANT, tab, plan[tab], 500);
  });
  const loadMs = Date.now() - t2;
  console.log('  ' + human(loadMs) + ' for ' + written.toLocaleString() + ' rows (' +
    Math.round(written / (loadMs / 1000)).toLocaleString() + ' rows/second)');
  console.log('  This is a unix socket on the same machine. Neon is an internet round trip per');
  console.log('  batch — expect several times this, and run it from somewhere with a good');
  console.log('  connection rather than over office wifi.');
  console.log('');

  console.log('Reading every row back and comparing it...');
  const t3 = Date.now();
  const report = await imp.verify(db, TENANT, plan);
  console.log('  ' + human(Date.now() - t3));
  console.log('');
  console.log(imp.summarise(report, manifest));

  for (const tab of tabs) {
    await db.q('DELETE FROM ' + plan[tab].map.table + ' WHERE tenant_id = $1', [TENANT]);
  }
  await db.pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.log('FAILED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
