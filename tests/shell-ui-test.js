/**
 * The new design's shell, in a browser: the sidebar, the bar across the top, the command
 * palette, the drawer on a phone, the sign-in screen.
 *
 * portal-ui-test.js checks that the portal's behaviour survives the new design; it runs
 * against both faces. This checks the things the new face adds, which the old one does not
 * have and so nothing else would notice breaking. It runs against the showcase fixture,
 * because a sidebar's labels and a dashboard's icons only exist once there is a menu and a
 * dashboard to put them on.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show.html --ui=web \
 *        --title="ELGi Sales ERP"
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-classic.html
 *   node tests/shell-ui-test.js /tmp/show.html /tmp/show-classic.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const WEB = process.argv[2];
const CLASSIC = process.argv[3];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });

  async function open(file, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'warning' && /\[shell\]/.test(m.text())) errors.push(m.text()); });
    await page.goto('file://' + file);
    await page.waitForTimeout(900);
    return { ctx, page, errors };
  }
  const go = (page, view) => page.evaluate((v) =>
    document.querySelector('#tabs [data-view="' + v + '"]').click(), view);
  const box = (page, sel) => page.$eval(sel, (e) => {
    const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // ------------------------------------------------------------------ desktop
  let { ctx, page, errors } = await open(WEB);

  console.log('THE NEW FACE OPENS');
  ok('with no script errors, and no complaint from the shell', errors.length === 0, errors);
  ok('the shell ran', await page.evaluate(() =>
    document.documentElement.classList.contains('shell-ready')));

  console.log('\nTHE MENU IS A SIDEBAR');
  const side = await box(page, '.topbar');
  ok('down the left edge, full height', side.x === 0 && side.y === 0 && side.h === 900, side);
  ok('and wide enough to read', side.w >= 240 && side.w <= 280, side.w);
  const content = await box(page, '.container');
  ok('with the workspace beside it, not under it', content.x >= side.w, { content, side });
  const items = await page.$$eval('#tabs [data-view]', (bs) => bs.map((b) => ({
    view: b.dataset.view, icon: !!b.querySelector('svg.nav-ico'),
    h: Math.round(b.getBoundingClientRect().height), title: b.title })));
  ok('every screen a manager may open is in it', items.length === 14, items.map((i) => i.view));
  ok('each with its icon', items.every((i) => i.icon), items.filter((i) => !i.icon));
  ok('each named on hover, for when only the icon shows', items.every((i) => i.title), items);
  // A flex column shrinks its children when it runs out of room; the first version did, and
  // half the menu came out shorter than the rest.
  ok('and every one the same height', new Set(items.map((i) => i.h)).size === 1,
    [...new Set(items.map((i) => i.h))]);
  const labels = await page.$$eval('#tabs .nav-label, #tabs [data-group]', (ls) =>
    // A group heading's text ends in the dropdown caret, hidden here but still in the DOM.
    ls.map((l) => l.textContent.replace(/[^A-Za-z &]/g, '').trim()));
  ok('sections are named, where a group does not name them',
    ['Sales', 'Quotations', 'Orders', 'Stock', 'Masters'].every((w) => labels.indexOf(w) !== -1), labels);
  ok('and a group heading is not a stop on the tab key', await page.$$eval('#tabs [data-group]',
    (gs) => gs.every((g) => g.tabIndex === -1)));

  console.log('\nTHE BAR SAYS WHERE YOU ARE');
  const crumbs = () => page.evaluate(() => ({
    section: document.getElementById('ws-crumb-section').textContent,
    page: document.getElementById('ws-crumb-page').textContent,
    top: document.querySelector('.ws-crumbs').classList.contains('is-top') }));
  let c = await crumbs();
  ok('it opens on the dashboard, for a manager', c.page === 'Dashboard', c);
  await go(page, 'quotations');
  await page.waitForTimeout(300);
  c = await crumbs();
  ok('and follows the menu', c.section === 'Quotations' && c.page === 'All Quotations', c);
  ok('with the live screen marked in the menu', await page.$eval('#tabs [data-view="quotations"]',
    (b) => b.classList.contains('active')));
  ok('and its section heading lit', await page.$eval('#tabs [data-group]',
    (g) => g.classList.contains('active')));
  // Programmatic navigation, the way the dashboard's Open buttons and the quote flows move.
  await go(page, 'dashboard');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#dash-body [data-goto="orders"]').click());
  await page.waitForTimeout(300);
  c = await crumbs();
  ok('including when a screen is opened from a button, not the menu', c.page === 'Sales Orders', c);
  await page.evaluate(() => window.scrollTo(0, 600));
  await go(page, 'customers');
  await page.waitForTimeout(300);
  ok('and a new screen starts at its top', await page.evaluate(() => window.scrollY) === 0);

  console.log('\nEVERY SCREEN HAS ITS ICON, AND THE DASHBOARD SAYS HELLO');
  const heads = await page.$$eval('.view > .page-head', (hs) => hs.map((h) => !!h.querySelector('.page-ico svg')));
  ok('every screen heading carries its icon', heads.length === 14 && heads.every(Boolean), heads);
  await go(page, 'dashboard');
  await page.waitForTimeout(500);
  const hello = await page.$eval('#view-dashboard .page-eyebrow', (e) => e.textContent);
  ok('the dashboard greets the person by name', /^Good (morning|afternoon|evening), Anil$/.test(hello), hello);
  ok('and the title the portal sets is still its own', await page.$eval('#dash-title',
    (e) => /Control Tower/.test(e.textContent)));
  ok('the four headline figures each have an icon',
    await page.$$eval('#dash-body .hero-card .kpi-ico svg', (s) => s.length) === 4);
  ok('and the cards are titled with theirs',
    await page.$$eval('#dash-body .card-title .card-ico', (s) => s.length) >= 5);
  // The dashboard redraws itself on every stream switch; the icons must come back with it.
  await page.click('#dash-stream button[data-stream="Spare Sales"]');
  await page.waitForTimeout(500);
  ok('and come back when the dashboard redraws',
    await page.$$eval('#dash-body .hero-card .kpi-ico svg', (s) => s.length) === 4);

  console.log('\nA PLUS SIGN IS AN ICON, AND SIGNING OUT STILL SAYS SO');
  const cta = await page.$eval('#btn-new-enquiry', (b) => ({ svg: !!b.querySelector('svg'),
    text: b.textContent.trim() }));
  ok('"+ Log Enquiry" is an icon and two words', cta.svg && cta.text === 'Log Enquiry', cta);
  const out = await page.$eval('#btn-signout', (b) => ({ svg: !!b.querySelector('svg'),
    text: b.textContent.trim() }));
  ok('the sign-out button is an icon that a screen reader still reads',
    out.svg && out.text === 'Sign out', out);

  console.log('\nTHE COMMAND PALETTE');
  ok('is not in the way until asked for', !(await page.isVisible('#cmdk')));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(200);
  ok('Ctrl K opens it', await page.isVisible('#cmdk'));
  ok('with the cursor in it', await page.evaluate(() => document.activeElement.id === 'cmdk-q'));
  const all = await page.$$eval('#cmdk .cmdk-item', (xs) => xs.length);
  ok('offering every screen and the common jobs', all >= 14 + 4, all);
  await page.keyboard.type('cust');
  await page.waitForTimeout(150);
  const first = await page.$eval('#cmdk .cmdk-item[aria-selected="true"] .cmdk-label', (e) => e.textContent);
  ok('typing narrows it, best match first', first === 'Customers', first);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('Enter goes there', await page.$eval('#view-customers', (v) => v.classList.contains('active')));
  ok('and the palette gets out of the way', !(await page.isVisible('#cmdk')));
  await page.keyboard.press('Control+k');
  await page.keyboard.type('quo');
  await page.waitForTimeout(150);
  const quo = await page.$$eval('#cmdk .cmdk-label', (xs) => xs.map((x) => x.textContent));
  ok('a short query does not drag in things it plainly is not',
    quo.indexOf('Log a spare enquiry') === -1, quo);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok('Escape closes it', !(await page.isVisible('#cmdk')));
  await page.keyboard.press('Control+k');
  await page.keyboard.type('log a spare');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  ok('an action opens its screen and starts the job',
    await page.$eval('#view-enquiries', (v) => v.classList.contains('active')) &&
    await page.isVisible('#enquiry-modal-backdrop'));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  ok('and it will not open over a half-filled form', !(await page.isVisible('#cmdk')));

  console.log('\nA FORM OPENS AS A SHEET FROM THE RIGHT');
  // Index.html is shared with Apps Script and is left exactly as it is there, so most of these
  // rows carry their layout inline and no class; the shell tags them. Every form, not one.
  const rows = await page.evaluate(() => ({
    forms: document.querySelectorAll('.modal').length,
    tagged: document.querySelectorAll('.modal > .modal-actions:last-child').length }));
  ok('every form has its button row found and pinned', rows.forms >= 30 && rows.tagged === rows.forms, rows);
  const sheet = await box(page, '#enquiry-modal-backdrop .modal');
  ok('anchored to the right edge', Math.abs(sheet.x + sheet.w - (1440 - 10)) <= 2, sheet);
  ok('and the full height of the screen', sheet.h >= 900 - 22, sheet);
  const foot = await box(page, '#enquiry-modal-backdrop .modal-actions');
  ok('with its buttons kept at the foot', Math.abs(foot.y + foot.h - (sheet.y + sheet.h)) <= 2, { foot, sheet });
  await page.click('#btn-cancel-enquiry');
  await page.waitForTimeout(300);

  console.log('\nTHE SIDEBAR FOLDS AWAY, AND STAYS FOLDED');
  await page.click('#nav-collapse');
  await page.waitForTimeout(450);
  let w = (await box(page, '.topbar')).w;
  ok('one click folds it to its icons', w <= 80, w);
  ok('and the workspace takes the room', (await box(page, '.container')).x < 200);
  await ctx.close();
  // A fresh page in the same browser profile would remember; a new context is a new
  // browser, so this re-opens with the stored value carried in by hand.
  ({ ctx, page, errors } = await open(WEB));
  await page.evaluate(() => localStorage.setItem('pie.erp.sidebar', '1'));
  await page.reload();
  await page.waitForTimeout(900);
  w = (await box(page, '.topbar')).w;
  ok('the browser remembers it folded', w <= 80, w);
  await page.click('#nav-collapse');
  await page.waitForTimeout(450);
  ok('and unfolds again', (await box(page, '.topbar')).w >= 240);
  await ctx.close();

  // ------------------------------------------------------------------ a phone
  console.log('\nON A PHONE THE SIDEBAR IS A DRAWER');
  ({ ctx, page, errors } = await open(WEB, { width: 390, height: 844 }));
  let s = await box(page, '.topbar');
  ok('tucked away to begin with', s.x + s.w <= 0, s);
  ok('with the workspace using the whole width', (await box(page, '.container')).x === 0);
  await page.click('.ws-menu');
  await page.waitForTimeout(450);
  s = await box(page, '.topbar');
  ok('the menu button brings it out', s.x === 0, s);
  await page.evaluate(() => document.querySelector('#tabs [data-view="catalog"]').click());
  await page.waitForTimeout(450);
  s = await box(page, '.topbar');
  ok('and choosing a screen puts it away again', s.x + s.w <= 0, s);
  ok('having gone to that screen', await page.$eval('#view-catalog', (v) => v.classList.contains('active')));
  ok('with no errors on the way', errors.length === 0, errors);
  await ctx.close();

  // ------------------------------------------------------------------ signing in
  console.log('\nSIGNING IN SAYS WHOSE SYSTEM THIS IS');
  ({ ctx, page, errors } = await open(WEB));
  const signin = await page.evaluate(() => {
    const aside = document.querySelector('#signin-screen .signin-aside');
    return {
      split: document.getElementById('signin-screen').classList.contains('signin-split'),
      name: aside ? aside.querySelector('.signin-brand').textContent : null,
      fieldsMoved: !!document.querySelector('.signin-main #signin-email') &&
        !!document.querySelector('.signin-main #btn-signin')
    };
  });
  ok('a panel beside the form, named from the page title', signin.split &&
    /ELGi Sales ERP/.test(signin.name || ''), signin);
  ok('with the form itself still there, ids and all', signin.fieldsMoved, signin);
  await ctx.close();

  // ------------------------------------------------------------------ the classic face
  if (CLASSIC) {
    console.log('\nAND THE CLASSIC FACE HAS NONE OF IT');
    ({ ctx, page, errors } = await open(CLASSIC));
    const classic = await page.evaluate(() => ({
      bar: !!document.getElementById('ws-bar'),
      icons: document.querySelectorAll('.page-ico, .nav-ico').length,
      palette: !!document.getElementById('cmdk'),
      ready: document.documentElement.classList.contains('shell-ready')
    }));
    ok('no shell, no icons, no palette — exactly what Apps Script serves',
      !classic.bar && classic.icons === 0 && !classic.palette && !classic.ready, classic);
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(150);
    ok('and Ctrl K does nothing there', !(await page.$('#cmdk')));
    ok('with no errors either', errors.length === 0, errors);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
