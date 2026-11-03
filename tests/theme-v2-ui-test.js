/**
 * ERP 2.0's light and dark, in a browser against the real client: the switch in the top bar,
 * light until somebody picks dark, the whole page following (the tokens are redefined, so the
 * page, the panels and the words all turn), the choice kept on the browser and back on the next
 * visit before anything is drawn, and none of it on the other faces.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show.html --ui=web
 *   node tests/theme-v2-ui-test.js /tmp/show-v2.html /tmp/show.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const OTHER = process.argv[3];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

/** How light a colour is, 0 to 255, from getComputedStyle's rgb(). */
const lightness = (rgb) => {
  const m = String(rgb).match(/\d+(\.\d+)?/g) || [0, 0, 0];
  return (Number(m[0]) * 299 + Number(m[1]) * 587 + Number(m[2]) * 114) / 1000;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  // Whether the theme is on before the page's own script runs: the attribute the head sets.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { window.__themeAtLoad = document.documentElement.getAttribute('data-theme'); });
  });
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const looks = () => page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    panel: getComputedStyle(document.querySelector('.dv-panel')).backgroundColor,
    words: getComputedStyle(document.querySelector('.dv-panel h2')).color,
    stored: localStorage.getItem('erp.theme')
  }));

  console.log('LIGHT UNTIL SOMEBODY PICKS DARK');
  ok('the switch is in the top bar, beside the date', !!(await page.$('#ws-bar .ws-tools #v2-theme')) &&
    await page.evaluate(() => document.getElementById('v2-theme').nextElementSibling.classList.contains('ws-date')));
  ok('light by default, and the switch says where it goes', (await theme()) === null && (await page.getAttribute('#v2-theme', 'aria-label')) === 'Switch to dark mode' &&
    (await page.getAttribute('#v2-theme', 'aria-pressed')) === 'false');
  let l = await looks();
  ok('a light page, white panels, dark words', lightness(l.page) > 200 && lightness(l.panel) > 240 && lightness(l.words) < 80, l);

  console.log('\nDARK');
  await page.click('#v2-theme');
  await page.waitForTimeout(200);
  l = await looks();
  ok('one press turns the page dark', (await theme()) === 'dark' && (await page.getAttribute('#v2-theme', 'aria-label')) === 'Switch to light mode' &&
    (await page.getAttribute('#v2-theme', 'aria-pressed')) === 'true');
  ok('the page, the panels and the words all follow', lightness(l.page) < 40 && lightness(l.panel) < 50 && lightness(l.words) > 200, l);
  ok('and it is kept on this browser', l.stored === 'dark');
  const others = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector('#ws-bar')).backgroundColor,
    kpi: getComputedStyle(document.querySelector('.dv-kpi')).borderTopColor,
    hero: getComputedStyle(document.querySelector('.dv-hero')).backgroundImage
  }));
  ok('the top bar dark too, the tiles keep their colours, the hero its green', lightness(others.bar) < 60 && lightness(others.kpi) > 80 &&
    /gradient/.test(others.hero), others);
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(900);
  const table = await page.evaluate(() => getComputedStyle(document.querySelector('.qv-table')).backgroundColor);
  ok('every screen, not only the dashboard', lightness(table) < 50, table);

  console.log('\nTHE NEXT VISIT');
  await page.reload();
  await page.waitForTimeout(1200);
  ok('opens dark, set in the head before the page is drawn', (await page.evaluate(() => window.__themeAtLoad)) === 'dark' && (await theme()) === 'dark');
  await page.click('#v2-theme');
  await page.waitForTimeout(200);
  ok('and back to light', (await theme()) === null && (await looks()).stored === 'light' && lightness((await looks()).panel) > 240);
  await page.reload();
  await page.waitForTimeout(1200);
  ok('which is kept too', (await theme()) === null && (await page.getAttribute('#v2-theme', 'aria-label')) === 'Switch to dark mode');

  if (OTHER) {
    console.log('\nNOT ON THE OTHER FACES');
    const web = await ctx.newPage();
    web.on('pageerror', (e) => errors.push(String(e)));
    await web.addInitScript(() => { try { localStorage.setItem('erp.theme', 'dark'); } catch (e) { /* none */ } });
    await web.goto('file://' + OTHER);
    await web.waitForTimeout(1200);
    ok('no switch, and a dark choice does not reach them', !(await web.$('#v2-theme')) &&
      (await web.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null &&
      lightness(await web.evaluate(() => getComputedStyle(document.body).backgroundColor)) > 200);
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
