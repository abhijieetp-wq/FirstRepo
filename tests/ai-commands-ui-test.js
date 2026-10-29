/**
 * ERP 2.0's AI commands, in a browser against the real client: the Ask button, the window,
 * the examples, speech into the box, the proposal with a tick box on each action (one that
 * cannot be done is shown why and cannot be ticked), only the ticked ones sent to be done,
 * the results, a screen opened, and the command bar off — saying why to Management, absent for
 * others. The other faces have none of it.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/ai-commands-ui-test.js /tmp/base-v2.html
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

async function open(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.addInitScript((w) => {
    // The browser's speech recognition, stood in for: it hears one sentence.
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => this.onresult && this.onresult({ results: [[{ transcript: 'Remind Priya to call Topworth' }]] }), 20);
        setTimeout(() => this.onend && this.onend(), 40);
      }
      stop() {}
    };
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) { if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, w); data = v; } });
  }, who);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const { page, errors } = await open(browser, { aiCommands: true, businessStream: 'All' });
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const calls = (fn) => page.evaluate((f) => window.__calls.filter((c) => c.fn === f).map((c) => c.args), fn);

  if (!v2) {
    console.log('THE OTHER FACES');
    ok('no Ask button', !(await page.$('#ai-open')) && !(await page.$('#ai-backdrop')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      D.getAiStatus = { enabled: true, reason: '', kinds: ['task', 'enquiry', 'open'],
        examples: ['Remind Priya to send the revised offer to Topworth by Friday, high priority', 'Show me the SDR list'] };
      D.proposeAiCommand = () => ({ reply: 'Two things, and one I could not do.', actions: [
        { kind: 'task', label: 'Task: Call Topworth', lines: [['For', 'Priya'], ['Due', '30-10-2026']], input: { title: 'Call Topworth', assigneeEmail: 'p@pie.in', dueDate: '2026-10-30', priority: 'Normal' }, problem: '' },
        { kind: 'enquiry', label: 'Spare enquiry: Brightline', lines: [['Asked for', 'Belts']], input: null, problem: 'No customer called Brightline. A spare enquiry needs a customer on the list — add them first.' },
        { kind: 'open', label: 'Open Customers', lines: [], input: { view: 'customers' }, problem: '' }] });
      D.applyAiActions = (list) => list.map((a) => (a.kind === 'open' ? { kind: 'open', ok: true, text: 'Opening Customers.', view: 'customers' }
        : { kind: a.kind, ok: true, text: 'Task given to Priya.' }));
    });

    console.log('THE ASK BUTTON AND ITS WINDOW');
    ok('in the top bar', !!(await page.$('.ws-tools #ai-open')) && /Ask/.test(await page.textContent('#ai-open')));
    await page.click('#ai-open');
    await page.waitForTimeout(300);
    ok('opens, ready to type', await page.evaluate(() => document.getElementById('ai-backdrop').classList.contains('show') && document.activeElement.id === 'ai-text'));
    ok('with examples of what this person may ask', (await page.$$eval('[data-ai-example]', (b) => b.length)) === 2);
    ok('and says where the words go', /your words go to Anthropic, your records do not/.test(await page.textContent('#ai-backdrop')));
    await page.click('[data-ai-example]');
    ok('an example fills the box', (await page.inputValue('#ai-text')).indexOf('Remind Priya') === 0);
    await page.fill('#ai-text', '');
    await page.click('#ai-mic');
    await page.waitForTimeout(150);
    ok('spoken words go in the box', await page.inputValue('#ai-text') === 'Remind Priya to call Topworth' && !(await page.$('#ai-mic.on')));

    console.log('\nTHE PROPOSAL');
    await page.click('#btn-ai-ask');
    await page.waitForTimeout(300);
    ok('the words sent to be read', JSON.stringify((await calls('proposeAiCommand')).pop()) === '["Remind Priya to call Topworth"]');
    ok('its reply', (await page.textContent('#ai-reply')) === 'Two things, and one I could not do.');
    const cards = await page.$$eval('.ai-card', (c) => c.map((x) => ({ text: x.innerText.replace(/\s+/g, ' ').trim(), on: x.querySelector('input').checked, off: x.querySelector('input').disabled })));
    ok('each action with a tick box, ticked', cards.length === 3 && cards[0].on && cards[2].on && /^Task: Call Topworth For Priya Due 30-10-2026$/.test(cards[0].text), cards);
    ok('one that cannot be done says why, and cannot be ticked', !cards[1].on && cards[1].off && /add them first/.test(cards[1].text));
    ok('nothing done yet', (await calls('applyAiActions')).length === 0 && await page.textContent('#btn-ai-do') === 'Do these 2');
    await page.uncheck('.ai-card input[data-ai-i="2"]');
    ok('the count follows the ticks', await page.textContent('#btn-ai-do') === 'Do this');
    await page.click('#btn-ai-do');
    await page.waitForTimeout(300);
    ok('only what was ticked, as proposed', JSON.stringify((await calls('applyAiActions')).pop()) ===
      JSON.stringify([[{ kind: 'task', input: { title: 'Call Topworth', assigneeEmail: 'p@pie.in', dueDate: '2026-10-30', priority: 'Normal' } }]]));
    ok('and what happened', /✓ Task given to Priya\./.test(await page.textContent('#ai-list')) && (await page.inputValue('#ai-text')) === '');

    console.log('\nA SCREEN OPENED');
    await page.fill('#ai-text', 'Show me the customers');
    await page.click('#btn-ai-ask');
    await page.waitForTimeout(300);
    await page.uncheck('.ai-card input[data-ai-i="0"]');
    await page.click('#btn-ai-do');
    await page.waitForTimeout(700);
    ok('goes there and closes', (await page.evaluate(() => document.querySelector('.view.active').id)) === 'view-customers' &&
      !(await page.evaluate(() => document.getElementById('ai-backdrop').classList.contains('show'))));

    console.log('\nOFF');
    const boss = await open(browser, { aiCommands: false, role: 'Management', businessStream: 'All' });
    await boss.page.evaluate(() => { window.__data.getAiStatus = { enabled: false, reason: 'AI commands are off: the server has no ANTHROPIC_API_KEY.', kinds: [], examples: [] }; });
    ok('Management still sees the button', !!(await boss.page.$('#ai-open')));
    await boss.page.click('#ai-open');
    await boss.page.waitForTimeout(300);
    ok('and why it is off', /no ANTHROPIC_API_KEY/.test(await boss.page.textContent('#ai-off')) && await boss.page.$eval('#btn-ai-ask', (b) => b.disabled));
    const staff = await open(browser, { aiCommands: false });
    ok('nobody else sees it', !(await staff.page.$('#ai-open')));
    ok('with no script errors there', boss.errors.length === 0 && staff.errors.length === 0, boss.errors.concat(staff.errors));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
