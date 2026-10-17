/**
 * Outbound HTTP, which Tally and the Google sign-in need.
 *
 * Against a real server on a real socket, because the thing being tested is a curl process
 * — mocking it would test nothing. The echo server runs as a separate process on purpose:
 * this fetch blocks the event loop while curl runs, so a server inside this process could
 * never answer, and discovering that here is better than discovering it in production.
 *
 *   node tests/fetch-test.js
 */
const path = require('path');
const { spawn } = require('child_process');
const { urlFetchApp, formEncode } = require(path.join(__dirname, '..', 'server', 'fetch.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const SERVER = `
const http = require('http');
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url === '/fail') { res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('<LINEERROR>no such ledger</LINEERROR>'); }
    if (req.url === '/slow') { return setTimeout(() => { res.writeHead(200); res.end('late'); }, 9000); }
    res.writeHead(200, { 'Content-Type': 'text/xml', 'X-Probe': 'yes' });
    res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'] || '',
      auth: req.headers['x-token'] || '', body }));
  });
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;

(async () => {
  const child = spawn(process.execPath, ['-e', SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(String(d).trim()));
  });
  const base = 'http://127.0.0.1:' + port;
  const u = urlFetchApp({ timeoutSeconds: 3 });

  console.log('IT POSTS WHAT IT IS GIVEN');
  const xml = u.fetch(base + '/tally', { method: 'post', contentType: 'text/xml',
    payload: '<ENVELOPE><HEADER/></ENVELOPE>', muteHttpExceptions: true });
  const echoed = JSON.parse(xml.getContentText());
  ok('the code comes back', xml.getResponseCode() === 200, xml.getResponseCode());
  ok('the method', echoed.method === 'POST', echoed.method);
  ok('the content type', echoed.type === 'text/xml', echoed.type);
  ok('the body, exactly', echoed.body === '<ENVELOPE><HEADER/></ENVELOPE>', echoed.body);
  ok('and response headers are readable', xml.getHeaders()['x-probe'] === 'yes');
  ok('a header can be sent', JSON.parse(u.fetch(base + '/h',
    { headers: { 'X-Token': 'abc' }, muteHttpExceptions: true }).getContentText()).auth === 'abc');

  console.log('\nAN OBJECT PAYLOAD IS A FORM, THE WAY APPS SCRIPT SENDS ONE');
  // The Google token exchange depends on this, and its client secret is in the payload.
  ok('encoded as pairs', formEncode({ a: 1, b: 'x y' }) === 'a=1&b=x%20y', formEncode({ a: 1, b: 'x y' }));
  const form = JSON.parse(u.fetch(base + '/token', { method: 'post',
    payload: { code: 'abc', client_secret: 's3cret', redirect_uri: 'https://erp.pie.in' },
    muteHttpExceptions: true }).getContentText());
  ok('with the right content type', form.type === 'application/x-www-form-urlencoded', form.type);
  ok('and the values escaped',
    form.body === 'code=abc&client_secret=s3cret&redirect_uri=https%3A%2F%2Ferp.pie.in', form.body);

  console.log('\nA REFUSAL IS HANDED BACK, NOT HIDDEN');
  // Billing reads <LINEERROR> out of the body of a rejection, so muting must return it.
  const muted = u.fetch(base + '/fail', { method: 'post', payload: 'x', muteHttpExceptions: true });
  ok('a muted 500 returns its code', muted.getResponseCode() === 500);
  ok('and its body, which is where Tally puts the reason',
    /<LINEERROR>/.test(muted.getContentText()), muted.getContentText());
  let threw = '';
  try { u.fetch(base + '/fail', { method: 'post', payload: 'x' }); } catch (e) { threw = e.message; }
  ok('unmuted, it throws like Apps Script does', /returned code 500/.test(threw), threw);
  ok('with the body in the message', /LINEERROR/.test(threw), threw);

  console.log('\nAND A TALLY BOX THAT IS OFF DOES NOT HOLD THE PORTAL');
  const t0 = Date.now();
  let slow = '';
  try { u.fetch(base + '/slow', { muteHttpExceptions: true }); } catch (e) { slow = e.message; }
  const waited = Date.now() - t0;
  ok('it gives up', /Could not reach/.test(slow), slow);
  ok('at the timeout, not later', waited < 8000, waited + 'ms');
  let refused = '';
  try { u.fetch('http://127.0.0.1:1/nothing', { muteHttpExceptions: true }); }
  catch (e) { refused = e.message; }
  ok('a closed port says so plainly', /Could not reach/.test(refused), refused);
  ok('naming the address, so it can be corrected', /127\.0\.0\.1:1/.test(refused), refused);

  child.kill();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); process.exit(1); });
