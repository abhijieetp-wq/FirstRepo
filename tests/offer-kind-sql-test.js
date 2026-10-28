/**
 * The offer's heading and subject name the kind of machine quoted: screw, reciprocating or
 * dryer. PIE's rule (28 Oct 2026): only the machine changes, the rest of the line stays —
 *
 *   ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR          (heading)
 *   Submission of Budgetary Offer for ELGi Rotary Screw Air Compressor   (subject)
 *
 * becomes "...RECIPROCATING AIR COMPRESSOR" / "...for ELGi Reciprocating Air Compressor", or
 * "...AIR DRYER" / "...for ELGi Air Dryer".
 *
 * What went wrong before: the subject was the screw one on every compressor offer; a
 * reciprocating unit was read as a screw unless its family said "reciprocating", because its
 * description never does ("TS10 LB-12 BM"); and an offer for a dryer alone took the screw
 * heading on the compressor desk and "spare parts" on the spares desk.
 *
 * Model numbers are invented; only the family prefixes (EG, TS, SS, MS, ELRD, HLD) are ELGi's,
 * because they are what the rule reads.
 *
 *   DATABASE_URL=postgres://... node tests/offer-kind-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

const TENANT = 'offer-kind-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin' };
const TABLES = ['users', 'customers', 'customer_addresses', 'customer_contacts', 'products', 'spares',
  'price_list', 'quotations', 'quotation_items', 'quote_templates', 'company_profile', 'audit_log'];

const SCREW_HEAD = 'ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR';
const RECIP_HEAD = 'ELGi ELECTRIC POWERED OIL RECIPROCATING AIR COMPRESSOR';
const DRYER_HEAD = 'ELGi ELECTRIC POWERED OIL AIR DRYER';
const SPARE_HEAD = 'ELGi GENUINE SPARE PARTS';
const SCREW_SUBJ = 'Submission of Budgetary Offer for ELGi Rotary Screw Air Compressor';
const RECIP_SUBJ = 'Submission of Budgetary Offer for ELGi Reciprocating Air Compressor';
const DRYER_SUBJ = 'Submission of Budgetary Offer for ELGi Air Dryer';
const SPARE_SUBJ = 'Offer for spare parts of your ELGi make air compressors';

const pick = (html, re) => { const m = html.match(re); return m ? m[1] : ''; };
const heading = (html) => pick(html, /<div class="doc-title">([^<]*)<\/div>/);
const subLine = (html) => pick(html, /<div class="doc-sub">([^<]*)<\/div>/);
const subject = (html) => pick(html, /<div class="subject"><b>[^<]*<\/b> ([^<]*)<\/div>/);
const firstH1 = (html) => pick(html, /<div class="h1">([^<]*)<\/div>/);
/** The letter's own paragraphs: from the greeting to the next heading (the enclosures list,
 * which rightly differs — a reciprocating unit has no scope of supply written yet). */
const letter = (html) => {
  const at = html.indexOf('<div class="salut">');
  if (at === -1) return '';
  const ends = ['<div class="h2">', '<div class="page-break">'].map((m) => html.indexOf(m, at)).filter((i) => i !== -1);
  return html.slice(at, ends.length ? Math.min.apply(null, ends) : undefined);
};

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Test Customer', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing',
    line1: 'Plot 1', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });

  const machine = (id, code, model, family) => db.appendRow('Products', {
    id, productCode: code, model, series: '', family, gstPct: 18, hsnCode: '84148011',
    capacityCfm: '50 cfm', workingPressure: '7 bar', active: 'TRUE' });
  await machine('PR-EG', 'EG99-7.5', 'EG 99-7.5', 'Lubricated screw');
  // Nothing in the family and nothing in the words: only the model says what it is.
  await machine('PR-TS', 'TS-77', 'TS77 LB-12 BM', '');
  // A family typed wrongly: the model still decides.
  await machine('PR-SS', 'SS-09', 'SS09 LB-9 TM220L', 'Lubricated screw');
  await machine('PR-MS', 'MS-55', 'MS55 LB SP-35 BM', '');
  // A screw with a built-in dryer is a screw.
  await machine('PR-EGD', 'EG99-7.5D', 'EG 99-7.5 D', 'Screw compressor with integrated dryer');

  const part = (id, partNo, description, group) => db.appendRow('Spares', {
    id, partNo, description, productGroup: group === undefined ? 'Dryer /OWS /HRS/Tank' : group,
    uom: 'Nos', gstPct: 18, hsnCode: '84193900', active: 'TRUE' });
  await part('SP-ELRD', 'T-ELRD', 'ELRD 0990 A');
  await part('SP-HLD', 'T-HLD', 'AIR DRYER HLD 77X ASME');
  await part('SP-VAR', 'T-VAR', 'VAR 0990L-12.5');
  await part('SP-KIT', 'T-KIT', 'DRYER KIT V3 990L ELRD99');
  await part('SP-F9', 'T-F9', 'AIR DRIER - F9-99KW', 'EPSAC ROCD Spares');
  await part('SP-FLT', 'T-FLT', 'ELEMENT PRE FILTER - 0099', 'Downstream Filters');

  const p = loadPortal(db, BOSS.email, { quiet: true });
  p.CURRENT_USER_ = BOSS;
  await p.installMissingQuoteTemplates_('test');

  const offer = async (lines, stream) => {
    const q = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
    for (const [itemType, itemId] of lines) await p.saveQuotationItem({ quotationId: q.id, itemType, itemId, qty: 1 });
    if (stream) {
      await db.q('UPDATE quotations SET business_stream = $3 WHERE tenant_id = $1 AND id = $2', [TENANT, q.id, stream]);
    }
    return p.buildQuotationHtml(q.id);
  };

  console.log('THE RULE ITSELF');
  const kind = (model, family) => p.productKind_({ model, family });
  ok('EG, EQ and EN are screws', ['EG 99-7.5', 'EQ 9-8', 'EN 9X-8'].every((m) => kind(m) === 'SCREW'));
  ok('TS, SS and MS are reciprocating, family or not',
    ['TS77 LB-12 BM', 'SS1.5 LB BP-10', 'MS55 LB PET-40 BM'].every((m) => kind(m, 'Lubricated screw') === 'RECIP'));
  ok('a screw with a built-in dryer is a screw', kind('EG 99PM-13 DV', 'with dryer') === 'SCREW');
  ok('an unknown model still goes by its family', kind('XY 10', 'Reciprocating') === 'RECIP' &&
    kind('XY 10', 'Air Dryer') === 'DRYER' && kind('XY 10', '') === 'SCREW');
  const dry = (description, productGroup) => p.spareIsDryerUnit_({ description, productGroup });
  ok('whole dryers are dryers', dry('ELRD 0990 A', 'Dryer /OWS /HRS/Tank') && dry('HLD 77X', 'Dryer /OWS /HRS/Tank') &&
    dry('AR 0990N A2', 'Dryer /OWS /HRS/Tank') && dry('Refrigerator type air dryer - 3GD990W', 'Dryer /OWS /HRS/Tank') &&
    dry('ELRD-099 AIR DRIER', ''));
  ok('dryer kits, assemblies and elements are parts', !dry('DRYER KIT V3 990L ELRD99', 'Dryer /OWS /HRS/Tank') &&
    !dry('DRYER ASSY - EG 990 PREMIUM', '') && !dry('INTEGRATED DRYER EG 99', '') && !dry('DRYER PRE FILTER ELEMENT', ''));
  ok('a dryer part filed with the compressor spares is a part', !dry('AIR DRIER - F9-99KW', 'EPSAC ROCD Spares'));
  ok('receivers, heat recovery and oil-water separators are not dryers',
    !dry('VAR 0990L-12.5', 'Dryer /OWS /HRS/Tank') && !dry('HR 99 HEAT RECOVERY SYS KIT', 'Dryer /OWS /HRS/Tank') &&
    !dry('EG OIL WATER SEPARATOR - 99 C', 'Dryer /OWS /HRS/Tank'));
  ok('the name swaps in the case it was written in',
    p.swapMachineName_('OIL SCREW AIR COMPRESSOR', 'DRYER') === 'OIL AIR DRYER' &&
    p.swapMachineName_('for ELGi Rotary Screw Air Compressor', 'RECIP') === 'for ELGi Reciprocating Air Compressor' &&
    p.swapMachineName_('the ELGi Rotary screw air compressor with', 'DRYER') === 'the ELGi Air dryer with' &&
    p.swapMachineName_('rotary screw air compressor', 'RECIP') === 'reciprocating air compressor');
  ok('and a screw offer is left exactly as written', p.swapMachineName_(SCREW_SUBJ, 'SCREW') === SCREW_SUBJ &&
    p.swapMachineName_(SCREW_SUBJ, '') === SCREW_SUBJ);

  console.log('\nA SCREW OFFER IS AS IT WAS');
  let html = await offer([['Product', 'PR-EG']]);
  ok('screw heading', heading(html) === SCREW_HEAD, heading(html));
  ok('screw subject', subject(html) === SCREW_SUBJ, subject(html));
  ok('the letter names the screw', letter(html).indexOf('ELGi Rotary screw air compressor with its technical specification') !== -1);
  const screwLetter = letter(html);

  console.log('\nA RECIPROCATING OFFER');
  html = await offer([['Product', 'PR-TS']]);
  ok('reciprocating heading, though nothing but the model says so', heading(html) === RECIP_HEAD, heading(html));
  ok('reciprocating subject', subject(html) === RECIP_SUBJ, subject(html));
  ok('only the machine changed in the subject', subject(html).replace('Reciprocating Air Compressor', 'Rotary Screw Air Compressor') === SCREW_SUBJ);
  ok('the same TECHNICAL OFFER line under the heading', subLine(html) === 'TECHNICAL OFFER', subLine(html));
  ok('the specifications headed the same way', firstH1(html) === RECIP_HEAD, firstH1(html));
  ok('the letter names the reciprocating compressor, the rest as written',
    letter(html) === screwLetter.replace('ELGi Rotary screw air compressor', 'ELGi Reciprocating air compressor'));
  ok('a family typed as screw does not make it one', heading(await offer([['Product', 'PR-SS']])) === RECIP_HEAD);
  ok('super pressure and PET units too', heading(await offer([['Product', 'PR-MS']])) === RECIP_HEAD);

  console.log('\nA SCREW WITH A BUILT-IN DRYER IS A SCREW');
  html = await offer([['Product', 'PR-EGD']]);
  ok('screw heading and subject', heading(html) === SCREW_HEAD && subject(html) === SCREW_SUBJ, [heading(html), subject(html)]);

  console.log('\nA DRYER ON THE COMPRESSOR DESK');
  html = await offer([['Spare', 'SP-ELRD']]);
  ok('dryer heading, where it used to say screw', heading(html) === DRYER_HEAD, heading(html));
  ok('dryer subject', subject(html) === DRYER_SUBJ, subject(html));
  ok('the letter names the dryer', letter(html).indexOf('ELGi Air dryer with its technical specification') !== -1);
  html = await offer([['Spare', 'SP-VAR'], ['Spare', 'SP-HLD']]);
  ok('a dryer anywhere on an offer with no unit makes it a dryer offer', heading(html) === DRYER_HEAD, heading(html));
  html = await offer([['Product', 'PR-EG'], ['Spare', 'SP-ELRD']]);
  ok('a screw with a dryer sold beside it stays a screw offer', heading(html) === SCREW_HEAD && subject(html) === SCREW_SUBJ);

  console.log('\nA DRYER ON THE SPARES DESK');
  html = await offer([['Spare', 'SP-ELRD']], 'Spare Sales');
  ok('dryer heading, where it used to say spare parts', heading(html) === DRYER_HEAD, heading(html));
  ok('dryer subject', subject(html) === DRYER_SUBJ, subject(html));
  ok('the spares offer’s own line under the heading', subLine(html) === 'OFFER', subLine(html));
  ok('and its own letter', letter(html).indexOf('We thank you very much for your enquiry.') !== -1);

  console.log('\nPARTS STAY A SPARES OFFER');
  for (const [id, what] of [['SP-KIT', 'a dryer kit'], ['SP-F9', 'a dryer part filed with the compressor spares'],
    ['SP-FLT', 'a filter element'], ['SP-VAR', 'a receiver']]) {
    html = await offer([['Spare', id]], 'Spare Sales');
    ok(what + ': spare parts heading and subject', heading(html) === SPARE_HEAD && subject(html) === SPARE_SUBJ,
      [heading(html), subject(html)]);
  }

  console.log('\nAN EDIT TO THE SCREW WORDING CARRIES TO THE OTHERS');
  await db.q("UPDATE quote_templates SET title = $2 WHERE tenant_id = $1 AND id = 'QTPL-COMP-COVER'",
    [TENANT, 'Our budgetary offer for your ELGi Rotary Screw Air Compressor requirement']);
  ok('reciprocating', subject(await offer([['Product', 'PR-TS']])) ===
    'Our budgetary offer for your ELGi Reciprocating Air Compressor requirement');
  ok('dryer, from the spares desk too', subject(await offer([['Spare', 'SP-ELRD']], 'Spare Sales')) ===
    'Our budgetary offer for your ELGi Air Dryer requirement');
  ok('screw', subject(await offer([['Product', 'PR-EG']])) === 'Our budgetary offer for your ELGi Rotary Screw Air Compressor requirement');

  console.log('\nA ROW WRITTEN FOR THE KIND PRINTS AS IT IS');
  await db.appendRow('QuoteTemplates', { id: 'QTPL-T-RECIP', section: 'CoverLetter', brand: 'ELGI',
    businessStream: 'Compressor Sales', appliesTo: 'RECIP', title: 'Offer for your piston compressor',
    sortOrder: 1, active: 'TRUE', body: 'Text written for the reciprocating Rotary screw air compressor offer.' });
  html = await offer([['Product', 'PR-TS']]);
  ok('its subject', subject(html) === 'Offer for your piston compressor', subject(html));
  ok('and its letter, untouched', letter(html).indexOf('Text written for the reciprocating Rotary screw air compressor offer.') !== -1);
  ok('the screw offer does not take it', subject(await offer([['Product', 'PR-EG']])) !==
    'Offer for your piston compressor');

  await clean();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
