/**
 * ERP 2.0's enquiry drawer, in a browser against the real client: a card's flag, town and
 * value in lakhs; the drawer from the right with the stages, the actions and three tabs; the
 * next follow-up, flag and owner dropdowns, each saved as it changes; a follow-up added and the
 * log read back; marking lost with a reason; and dialogs opened from the drawer appearing above
 * it. The other faces keep ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/board-drawer-ui-test.js /tmp/base-v2.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(600); };
  const lastCall = (fn) => page.evaluate((f) => { const a = window.__calls.filter((c) => c.fn === f); return a.length ? a[a.length - 1].args : null; }, fn);
  const drawerOpen = () => page.evaluate(() => { const b = document.getElementById('eb-modal-backdrop'); return !!b && b.classList.contains('show'); });

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('enquiries');
    ok('no board, no drawer', !(await page.$('#eb-spare')) && !(await page.$('#eb-modal-backdrop')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      const board = D.getEnquiryBoard;
      window.__log = [{ at: '2026-10-27', mode: 'Call', text: 'Customer checking the separator size', next: '2026-10-30', by: 'Priya' }];
      D.getEnquiryBoard = (o) => {
        const b = board(o);
        b.cards.forEach((c) => {
          if (c.ref === 'SE:E1') Object.assign(c, { flag: 'Hot', place: 'Butibori MIDC', contactName: 'R. Joshi', contactPhone: '98220 41187', logCount: 1, detail: 'Separator and filters' });
          if (c.ref === 'SE:E3') Object.assign(c, { value: 1250000 });
        });
        b.escalateTo = [{ email: 'boss@pie.in', name: 'Anil', role: 'Management' }];
        return b;
      };
      const card = (ref) => { const b = D.getEnquiryBoard({}); return b.cards.find((c) => c.ref === ref); };
      D.setBoardCardDetail = (i) => Object.assign(card(i.ref), i.field === 'followUp' ? { followUp: i.value, followUpLabel: 'Next follow-up' }
        : i.field === 'flag' ? { flag: i.value } : { ownerEmail: i.value, ownerName: i.value === 'd@pie.in' ? 'Dhriti' : 'Priya' });
      D.getBoardCardLog = () => window.__log.slice();
      D.addBoardFollowUp = (i) => {
        window.__log.unshift({ at: '2026-10-29', mode: i.mode, text: i.text, next: i.nextDate, by: 'Priya' });
        return { card: Object.assign(card(i.ref), { logCount: window.__log.length, followUp: i.nextDate, followUpLabel: 'Next follow-up' }), log: window.__log.slice() };
      };
      D.markBoardCardLost = (i) => Object.assign(card(i.ref), { stage: 'lost', closedWhy: 'Lost: Price too high', moves: [] });
    });

    console.log('THE CARDS');
    await go('enquiries');
    const e1 = await page.$eval('[data-eb-card="SE:E1"]', (e) => e.innerText.replace(/\s+/g, ' '));
    ok('the flag, the town and the machine on the card', /Hot/.test(e1) && /Butibori MIDC · EG 99 · FAB-1/.test(e1) && !!(await page.$('[data-eb-card="SE:E1"] .eb-chip.bad')), e1);
    ok('values from a lakh in lakhs', /₹12\.50 L/.test(await page.textContent('[data-eb-card="SE:E3"]')));

    console.log('\nTHE DRAWER');
    await page.click('[data-eb-card="SE:E1"]');
    await page.waitForTimeout(300);
    ok('opens from the right', await drawerOpen() && !!(await page.$('#eb-modal-backdrop .eb2-drawer')));
    ok('what it is, and where it stands', /Spare enquiry · SE2610-0001/.test(await page.textContent('#eb-m-kind')) &&
      /Enquiry received/.test(await page.textContent('#eb-m-chips')) && /Hot/.test(await page.textContent('#eb-m-chips')));
    const acts = await page.$$eval('#eb-m-acts button', (b) => b.map((x) => x.textContent));
    ok('ERP 2’s actions', acts.join('|') === 'Add follow-up|Prepare quotation|Escalate to owner|+ Task|Mark lost', acts);
    ok('three tabs', (await page.$$eval('#eb-m-tabs button', (b) => b.map((x) => x.textContent))).join('|') === 'Overview|Follow-ups (1)|Quotations and orders');
    ok('a hand-set stage says so, with its button', /This stage is set by hand/.test(await page.textContent('#eb-m-body')) && !!(await page.$('#eb-m-body [data-eb-move="requirement"]')));
    const facts = await page.$eval('.eb-facts', (e) => e.innerText.replace(/\s+/g, ' '));
    ok('who to ring and what they need', /Contact R\. Joshi · 98220 41187/.test(facts) && /Needs Separator and filters/.test(facts) && /Received 20 Oct 2026/.test(facts), facts);

    console.log('\nTHE DROPDOWNS');
    await page.evaluate(() => { window.__calls = []; });
    await page.fill('#eb-d-fu', '2026-11-03');
    await page.dispatchEvent('#eb-d-fu', 'change');
    await page.waitForTimeout(300);
    ok('the next follow-up, saved as it changes', JSON.stringify(await lastCall('setBoardCardDetail')) === JSON.stringify([{ ref: 'SE:E1', field: 'followUp', value: '2026-11-03' }]) &&
      /FU 3 Nov/.test(await page.textContent('[data-eb-card="SE:E1"]')));
    await page.selectOption('#eb-d-flag', 'Price issue');
    await page.waitForTimeout(300);
    ok('the flag', JSON.stringify(await lastCall('setBoardCardDetail')) === JSON.stringify([{ ref: 'SE:E1', field: 'flag', value: 'Price issue' }]) &&
      /Price issue/.test(await page.textContent('[data-eb-card="SE:E1"]')) && /Price issue/.test(await page.textContent('#eb-m-chips')));
    ok('the flags to pick from', (await page.$$eval('#eb-d-flag option', (o) => o.map((x) => x.value))).join() === ',Hot,Warm,Cold,Price issue,Competitor in play,Budget pending');
    await page.selectOption('#eb-d-owner', 'd@pie.in');
    await page.waitForTimeout(300);
    ok('the owner', JSON.stringify(await lastCall('setBoardCardDetail')) === JSON.stringify([{ ref: 'SE:E1', field: 'owner', value: 'd@pie.in' }]) &&
      await page.$eval('[data-eb-card="SE:E1"] .eb-av', (e) => e.textContent) === 'D');

    console.log('\nFOLLOW-UPS');
    await page.click('#eb-m-acts [data-eb-act="note"]');
    await page.waitForTimeout(300);
    ok('Add follow-up opens the tab, ready to type', await page.evaluate(() => document.activeElement.id === 'eb-n-text') &&
      /Customer checking the separator size/.test(await page.textContent('#eb-log')));
    await page.click('#btn-eb-note');
    await page.waitForTimeout(200);
    ok('words needed', !(await lastCall('addBoardFollowUp')));
    await page.fill('#eb-n-text', 'Sent the photo of the separator on WhatsApp');
    await page.selectOption('#eb-n-mode', 'WhatsApp');
    await page.fill('#eb-n-next', '2026-11-05');
    await page.click('#btn-eb-note');
    await page.waitForTimeout(400);
    ok('saved with how and when next', JSON.stringify(await lastCall('addBoardFollowUp')) ===
      JSON.stringify([{ ref: 'SE:E1', mode: 'WhatsApp', text: 'Sent the photo of the separator on WhatsApp', nextDate: '2026-11-05' }]));
    ok('and in the log, newest first, with the count', (await page.$eval('#eb-log .eb2-tl .eb2-meta b', (e) => e.textContent)) === 'Priya' &&
      /Sent the photo/.test(await page.$eval('#eb-log .eb2-tl', (e) => e.textContent)) && /Follow-ups \(2\)/.test(await page.textContent('#eb-m-tabs')));

    console.log('\nDIALOGS ABOVE THE DRAWER');
    await page.click('#eb-m-acts [data-eb-escalate]');
    await page.waitForTimeout(300);
    ok('Escalate opens above it', await page.evaluate(() => {
      const r = document.getElementById('esc-raise-backdrop');
      const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
      return r.classList.contains('show') && z(r) > z(document.getElementById('eb-modal-backdrop'));
    }));
    await page.click('#btn-esc-r-close');
    await page.waitForTimeout(200);

    console.log('\nMARKING LOST');
    await page.click('#eb-m-acts [data-eb-act="lost"]');
    await page.waitForTimeout(300);
    ok('asks why, from the list', await page.evaluate(() => document.getElementById('eb-lost-backdrop').classList.contains('show')) &&
      (await page.$$eval('#eb-l-reason option', (o) => o.map((x) => x.textContent))).join('|') === '— pick —|Price too high|Competitor selected');
    await page.click('#btn-eb-l-save');
    await page.waitForTimeout(200);
    ok('a reason needed', !(await lastCall('markBoardCardLost')));
    await page.selectOption('#eb-l-reason', 'LR-1');
    await page.fill('#eb-l-note', 'Went with a local supplier');
    await page.click('#btn-eb-l-save');
    await page.waitForTimeout(400);
    ok('saved with the reason and the note', JSON.stringify(await lastCall('markBoardCardLost')) === JSON.stringify([{ ref: 'SE:E1', reasonId: 'LR-1', note: 'Went with a local supplier' }]));
    ok('the card in the lost column, which now shows', await page.evaluate(() => {
      const c = document.querySelector('[data-eb-card="SE:E1"]');
      return !!c && c.closest('[data-eb-stage]').dataset.ebStage === 'lost';
    }) && /Price too high/.test(await page.textContent('#eb-m-steps')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('Escape closes the drawer', !(await drawerOpen()));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
