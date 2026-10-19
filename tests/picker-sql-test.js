/**
 * The compressor picker, against Postgres, through the portal's own code.
 *
 * The rule is PIE's, from their specification workbook — a model qualifies when its FAD is at
 * least the flow asked for and its working pressure at least the pressure asked for — and the
 * real ELGi catalogue was checked against that workbook on 150 questions with no difference.
 * This pins the rule and what the portal adds to it, on invented models, so the ELGi figures
 * stay out of the repository:
 *
 *   - closest fit is pressure first, then flow: never a 13 bar machine for a 7 bar job just
 *     because its flow is nearer
 *   - lowest specific power is named too, because the workbook's pick on its own is usually
 *     a machine far bigger than needed
 *   - flow and pressure are read from the words the catalogue prints, and a model whose
 *     figures cannot be read is named rather than guessed at
 *
 *   DATABASE_URL=postgres://... node tests/picker-sql-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { syncSchema } = require(path.join(__dirname, '..', 'server', 'schema-sync.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const TENANT = 'picker-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin' };
const TABLES = ['users', 'products', 'price_list', 'technical_requirements', 'audit_log'];

// Two invented series. TX has a 7.5, 10 and 13 bar build of one frame — the case where flow
// alone picks the wrong machine. TY is a bigger frame with better specific power.
const MODELS = [
  ['TX20-7.5', 'TX', '100 cfm (2.83 m³/min)', '7 bar.g', 19.5],
  ['TX30-7.5', 'TX', '160 cfm (4.53 m³/min)', '7 bar.g', 18.9],
  ['TX30-10', 'TX', '135 cfm (3.82 m³/min)', '9.5 bar.g', 22.4],
  ['TX30-13', 'TX', '112 cfm (3.17 m³/min)', '12.5 bar.g', 27.8],
  ['TY45-7.5', 'TY', '300 cfm (8.50 m³/min)', '7 bar.g', 18.1],
  // Flow written only in m³/min, which has to be converted.
  ['TY45-10', 'TY', '7.1 m³/min', '9.5 bar', 21.0],
  // Pressure in psi.
  ['TZ15-PSI', '', '80 cfm', '145 psi', null]
];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE' });
  let n = 0;
  for (const [code, series, cap, wp, spc] of MODELS) {
    await db.appendRow('Products', { id: 'PR-' + (++n), productCode: code, model: code.replace('-', ' ') + ' DM',
      series, capacityCfm: cap, workingPressure: wp, spcKw100Cfm: spc === null ? '' : spc,
      motorKw: '30 kW, 40 hp', active: 'TRUE' });
  }
  // Not considered: one with no figures at all, and one switched off.
  await db.appendRow('Products', { id: 'PR-90', productCode: 'OLD-1', model: 'Old unit', active: 'TRUE' });
  await db.appendRow('Products', { id: 'PR-91', productCode: 'TX99-7.5', model: 'Gone', capacityCfm: '999 cfm',
    workingPressure: '7 bar', active: 'FALSE' });
  await db.appendRow('PriceList', { id: 'PRC-1', itemType: 'Product', itemId: 'PR-2', itemCode: 'TX30-7.5',
    priceLevel: 'ELGI', price: 1250000, effectiveFrom: '2026-01-01', active: 'TRUE', currency: 'INR' });

  const p = loadPortal(db, BOSS.email, { quiet: true });
  p.CURRENT_USER_ = BOSS;
  const codes = (r) => r.matches.map((m) => m.productCode);

  console.log('A MODEL QUALIFIES ON FLOW AND PRESSURE, AS IN PIE\'S WORKBOOK');
  let r = await p.findCompressors({ fad: 110, fadUnit: 'cfm', pressure: 7 });
  ok('every model with enough air at enough pressure, and only those',
    codes(r).slice().sort().join() === 'TX30-10,TX30-13,TX30-7.5,TY45-10,TY45-7.5', codes(r));
  ok('a model one cfm short does not qualify', codes(r).indexOf('TX20-7.5') === -1);
  ok('a switched-off model is never offered', codes(r).indexOf('TX99-7.5') === -1);
  ok('a model whose figures cannot be read is named, not guessed at',
    r.unreadable.indexOf('OLD-1') !== -1 && codes(r).indexOf('OLD-1') === -1, r.unreadable);
  ok('and the count says how many were looked at', r.considered === 7, r.considered);

  console.log('\nTHE CLOSEST FIT IS BUILT FOR THE NEAREST PRESSURE');
  ok('the 7.5 bar build comes first, not the 13 bar one with nearer flow',
    r.matches[0].productCode === 'TX30-7.5' && r.matches[0].closest === true, codes(r));
  ok('then the smallest flow at that pressure', codes(r).indexOf('TX30-7.5') < codes(r).indexOf('TY45-7.5'));
  ok('higher-pressure builds after', codes(r).indexOf('TX30-13') > codes(r).indexOf('TY45-7.5'));
  ok('spare flow is worked out', r.matches[0].sparePct === 45.5, r.matches[0].sparePct);
  ok('only one model is the closest fit', r.matches.filter((m) => m.closest).length === 1);

  console.log('\nTHE LOWEST ENERGY USE IS NAMED TOO');
  const best = r.matches.filter((m) => m.bestSpc);
  ok('exactly one, the lowest specific power', best.length === 1 && best[0].productCode === 'TY45-7.5', best);
  ok('with its input power worked out', best[0].inputKw === 54.3, best[0].inputKw);
  ok('and its price where there is one', r.matches[0].price === 1250000 && best[0].price === null,
    [r.matches[0].price, best[0].price]);

  console.log('\nUNITS ARE CONVERTED, AND THE CATALOGUE\'S WORDS ARE READ');
  r = await p.findCompressors({ fad: 3.9, fadUnit: 'm3min', pressure: 7 });
  ok('m³/min asked for is converted to cfm', r.requirement.fadCfm === 137.7, r.requirement.fadCfm);
  ok('a model listed only in m³/min is read', (await p.findCompressors({ fad: 200, fadUnit: 'cfm', pressure: 9 }))
    .matches.some((m) => m.productCode === 'TY45-10' && Math.round(m.fadCfm) === 251));
  r = await p.findCompressors({ fad: 70, fadUnit: 'cfm', pressure: 10 });
  ok('pressure written in psi is read as bar', r.matches.some((m) => m.productCode === 'TZ15-PSI' &&
    m.workingBar === 10), r.matches.map((m) => [m.productCode, m.workingBar]));
  ok('and a model without a specific power is never the lowest', !r.matches.some((m) =>
    m.productCode === 'TZ15-PSI' && m.bestSpc));

  console.log('\nA SERIES CAN BE CHOSEN, AND ALL OF THEM ARE STILL OFFERED');
  r = await p.findCompressors({ fad: 110, fadUnit: 'cfm', pressure: 7, series: 'ty' });
  ok('only that series', r.matches.length > 0 && r.matches.every((m) => m.series === 'TY'), codes(r));
  ok('a blank series is taken from the code', r.seriesAvailable.indexOf('TZ') !== -1, r.seriesAvailable);
  ok('and the filter still lists every series', r.seriesAvailable.join() === 'TX,TY,TZ', r.seriesAvailable);

  console.log('\nWHEN NOTHING IS BIG ENOUGH, IT SAYS WHAT THE BIGGEST IS');
  r = await p.findCompressors({ fad: 500, fadUnit: 'cfm', pressure: 7 });
  ok('no matches', r.matches.length === 0);
  ok('and the largest at that pressure is named',
    r.largestAtPressure && r.largestAtPressure.productCode === 'TY45-7.5', r.largestAtPressure);
  r = await p.findCompressors({ fad: '', pressure: 7 });
  ok('without a flow it asks rather than lists everything', r.matches.length === 0 &&
    r.requirement.fadCfm === null);

  console.log('\nFROM AN OPPORTUNITY, IT READS THE REQUIREMENT AS TYPED');
  await db.appendRow('TechnicalRequirements', { id: 'TR-1', opportunityId: 'OP-1',
    requiredFad: 'about 3.9 m3/min', workingPressure: '100 psi' });
  r = await p.findCompressors({ opportunityId: 'OP-1' });
  ok('the flow, from words', r.requirement.fadCfm === 137.7 && r.requirement.from === 'requirement',
    r.requirement);
  ok('the pressure, from psi', r.requirement.pressureBar === 6.9, r.requirement.pressureBar);
  ok('and the matches follow', r.matches.length > 0 && r.matches[0].productCode === 'TX30-7.5', codes(r));
  ok('what was typed is handed back, to show what it was taken to mean',
    r.requirement.requirementText.fad === 'about 3.9 m3/min');

  console.log('\nEDITING A MODEL BY HAND KEEPS WHAT THE FORM HAS NO BOX FOR');
  const before = await db.findRowById('Products', 'PR-2');
  await p.saveProduct({ id: 'PR-2', productCode: 'TX30-7.5', model: 'TX 30-7.5 DM (edited)',
    capacityCfm: before.capacityCfm, workingPressure: before.workingPressure, motorKw: '30 kW, 40 hp' });
  const after = await db.findRowById('Products', 'PR-2');
  ok('the series survives an edit from the form', after.series === 'TX', after.series);
  ok('so does the specific power', Number(after.spcKw100Cfm) === 18.9, after.spcKw100Cfm);
  ok('and the edit itself landed', after.model === 'TX 30-7.5 DM (edited)');
  let refused = null;
  try { await p.saveProduct({ id: 'PR-2', productCode: 'TX30-7.5', model: 'x', spcKw100Cfm: -3 }); }
  catch (e) { refused = e.message; }
  ok('a nonsense specific power is refused', /Specific power/.test(String(refused)), refused);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
