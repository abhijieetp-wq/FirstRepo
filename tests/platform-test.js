/**
 * The Google services, answered by Node, checked against the code that depended on them.
 *
 * The one that matters is the digest. Apps Script returns bytes as SIGNED values, -128..127,
 * and every password and session token PIE has was derived through code written against that.
 * A digest handed back as 0..255 encodes to a different base64 string, which means every
 * stored password stops matching on the day of the cutover with nothing in the log to say
 * why. So the check is not "it produces a hash" — it is "it produces the same hash as
 * Sha256.gs", which the portal has been using in production and which has its own equivalence
 * test against a reference implementation.
 *
 *   node tests/platform-test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { platformFor, formatDate, Cache } = require(path.join(__dirname, '..', 'server', 'platform.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
const sameBytes = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

// Sha256.gs, loaded as the portal loads it. This is the reference: it is what the live sheet
// hashes passwords with today.
const ref = {};
vm.createContext(ref);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Sha256.gs'), 'utf8'), ref);

const P = platformFor({});
const U = P.Utilities;

console.log('A DIGEST IS STILL THE SAME DIGEST');
[
  ['nothing at all', ''],
  ['one character', 'a'],
  ['a sentence', 'hello world'],
  ['longer than a block', 'x'.repeat(200)],
  ['rupees and an em dash', '₹1,23,456 — ELGi'],
  ['exactly one block', 'y'.repeat(64)],
  ['one byte past a block', 'z'.repeat(65)]
].forEach(([what, input]) => {
  // computeDigest gives signed bytes; sha256Bytes_ gives unsigned. Same bytes, two
  // conventions, and the portal converts between them with toUnsignedBytes_.
  const mine = ref.toUnsignedBytes_(U.computeDigest(U.DigestAlgorithm.SHA_256, input));
  const theirs = ref.sha256Bytes_(ref.utf8Bytes_(input));
  ok('SHA-256 of ' + what, sameBytes(mine, theirs), [mine.slice(0, 4), theirs.slice(0, 4)]);
});

ok('and it comes back signed, as Apps Script gave it',
  U.computeDigest(U.DigestAlgorithm.SHA_256, 'a').some((b) => b < 0));
ok('and only SHA-256 is offered', (() => {
  try { U.computeDigest('MD5', 'a'); return false; } catch (e) { return /SHA-256/.test(e.message); }
})());

console.log('\nAND SO IS AN HMAC, WITH A KEY LONGER THAN THE BLOCK');
// The password derivation is four thousand of these chained. If the first one differs, every
// password in the Users tab is unreachable.
[['a short key', 'secret'], ['a key past the block size', 'k'.repeat(100)]].forEach(([what, k]) => {
  const key = ref.utf8Bytes_(k);
  const mine = ref.toUnsignedBytes_(U.computeHmacSha256Signature(ref.utf8Bytes_('message'), key));
  const theirs = ref.hmacSha256Bytes_(ref.utf8Bytes_('message'), key);
  ok('HMAC with ' + what, sameBytes(mine, theirs));
});

console.log('\nAND A DIGEST FED BACK IN STILL WORKS');
// randomToken_ and hashToken_ both hand a digest to another Utilities call, so the signed
// array has to survive the round trip rather than being read as 2^31-sized numbers.
const once = U.computeDigest(U.DigestAlgorithm.SHA_256, 'seed');
ok('base64 of a signed digest matches the portal’s own encoder',
  U.base64Encode(once) === ref.base64FromBytes_(ref.toUnsignedBytes_(once)),
  [U.base64Encode(once), ref.base64FromBytes_(ref.toUnsignedBytes_(once))]);
ok('and decoding it gives the bytes back',
  sameBytes(U.base64Decode(U.base64Encode(once)), once));
ok('web-safe too',
  sameBytes(U.base64DecodeWebSafe(U.base64EncodeWebSafe(once)), once));

console.log('\nDATES ARE IN PIE’S TIMEZONE, NOT THE SERVER’S');
// The sheet's dates were written in IST. A server in UTC that formats 20:30 UTC as the 15th
// would date an invoice a day early for anyone working an evening in India.
ok('an evening in India is already tomorrow in UTC',
  formatDate(new Date('2026-10-15T20:30:00Z'), null, 'yyyy-MM-dd') === '2026-10-16',
  formatDate(new Date('2026-10-15T20:30:00Z'), null, 'yyyy-MM-dd'));
ok('a morning is the same day',
  formatDate(new Date('2026-10-15T06:00:00Z'), null, 'yyyy-MM-dd') === '2026-10-15');
ok('with the time, when asked for it',
  formatDate(new Date('2026-10-15T06:00:00Z'), null, 'yyyy-MM-dd HH:mm:ss') === '2026-10-15 11:30:00',
  formatDate(new Date('2026-10-15T06:00:00Z'), null, 'yyyy-MM-dd HH:mm:ss'));
ok('midnight is 00, not 24',
  /00:00:00$/.test(formatDate(new Date('2026-10-15T18:30:00Z'), null, 'yyyy-MM-dd HH:mm:ss')),
  formatDate(new Date('2026-10-15T18:30:00Z'), null, 'yyyy-MM-dd HH:mm:ss'));
// The enquiry-number stamp: SE2610-001. Two digits of year, two of month, no separator.
ok('the financial-year stamp used by every enquiry number',
  formatDate(new Date('2026-10-15T06:00:00Z'), null, 'yyMM') === '2610',
  formatDate(new Date('2026-10-15T06:00:00Z'), null, 'yyMM'));
ok('and it follows the timezone too \u2014 an evening in India rolls the month on the 31st',
  formatDate(new Date('2026-10-31T20:30:00Z'), null, 'yyMM') === '2611',
  formatDate(new Date('2026-10-31T20:30:00Z'), null, 'yyMM'));
ok('a pattern nobody implemented says so by name', (() => {
  try { formatDate(new Date(), null, 'dd/MM/yyyy'); return false; }
  catch (e) { return /dd\/MM\/yyyy/.test(e.message); }
})());

console.log('\nTHE CACHE EXPIRES, AND REFUSES WHAT APPS SCRIPT REFUSED');
const c = new Cache();
c.put('k', 'v', 60);
ok('what went in comes out', c.get('k') === 'v');
ok('a miss is null, not undefined', c.get('absent') === null);
c.put('gone', 'v', 60);
c.store.get('gone').until = Date.now() - 1;
ok('an expired entry is a miss', c.get('gone') === null);
ok('and is dropped rather than kept', !c.store.has('gone'));
c.remove('k');
ok('remove removes', c.get('k') === null);
ok('a value over 100 KB is refused, as it was', (() => {
  try { c.put('big', 'x'.repeat(200 * 1024), 60); return false; }
  catch (e) { return /too large/i.test(e.message); }
})());
// Several callers do `try { cache.put(...) } catch (e) {}` precisely because of that limit.
// Keeping the limit keeps those branches real.
c.put('capped', 'v', 99999);
ok('a lifetime over six hours is capped at six, as it was',
  c.store.get('capped').until - Date.now() <= 6 * 3600 * 1000 + 50);
ok('getAll skips misses rather than reporting them as empty',
  JSON.stringify(c.getAll(['capped', 'absent'])) === '{"capped":"v"}');

console.log('\nAND THE USER CACHE IS NOT SHARED BETWEEN USERS');
// The dashboard caches per user for two minutes. One shared map would serve a coordinator the
// Management dashboard, which is a permissions failure wearing a performance hat.
const asBoss = platformFor({ actor: 'boss@pie.in' });
const asCoord = platformFor({ actor: 'coord@pie.in' });
asBoss.CacheService.getUserCache().put('dash', 'management', 60);
ok('one user’s entry is invisible to another',
  asCoord.CacheService.getUserCache().get('dash') === null);
// Within one process the same actor must see their own, or the cache does nothing at all.
const same = platformFor({ actor: 'boss@pie.in' });
same.CacheService.getUserCache().put('dash', 'management', 60);
ok('and visible to themselves', same.CacheService.getUserCache().get('dash') === 'management');

console.log('\nWHAT WAS NOT MIGRATED FAILS LOUDLY');
// A no-op would be worse than an error. A quotation that reports itself emailed and was not
// is a lost order that nobody can explain afterwards.
[
  ['DriveApp', () => P.DriveApp.createFolder('x')],
  ['MailApp', () => P.MailApp.sendEmail({})],
  // createHtmlOutput is no longer among these: the Google gate builds its two pages as
  // strings and wraps them with it, so it works now. Assembling the portal's own page from
  // a file is still the web framework's job and still refuses, which is what is checked
  // here instead.
  ['HtmlService', () => P.HtmlService.createTemplateFromFile('Index')],
  ['SpreadsheetApp', () => P.SpreadsheetApp.getActiveSpreadsheet()],
  ['UrlFetchApp', () => P.UrlFetchApp.fetch('https://x')]
].forEach(([name, call]) => {
  let msg = null;
  try { call(); } catch (e) { msg = e.message; }
  ok(name + ' throws and names itself', msg !== null && msg.indexOf(name) === 0, msg);
  ok('  and says what is needed instead', msg !== null && msg.length > name.length + 40);
});

// And the one piece of HtmlService that does work, because the Google gate needs it: a
// string wrapped in something with getContent(). The gate builds its own HTML and only
// uses HtmlService to hand it back, so this is the whole of what it asks for.
{
  const out = P.HtmlService.createHtmlOutput('<p>gate</p>');
  ok('HtmlService can still wrap a string the gate built',
    out.getContent() === '<p>gate</p>');
  ok('and its setters chain, as the gate expects',
    out.setTitle('x').setXFrameOptionsMode('ALLOWALL').getContent() === '<p>gate</p>');
}
ok('SpreadsheetApp points at the list of what is left',
  (() => { try { P.SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return /missing\.js/.test(e.message); } })());
ok('sleep is refused rather than blocking the process', (() => {
  try { U.sleep(1000); return false; } catch (e) { return /block the server/.test(e.message); }
})());

console.log('\nAND THE THINGS THAT ARE JUST SETTINGS');
ok('the timezone is PIE’s', P.Session.getScriptTimeZone() === 'Asia/Kolkata');
ok('a uuid looks like one', /^[0-9a-f-]{36}$/.test(U.getUuid()));
ok('and two are different', U.getUuid() !== U.getUuid());
const props = {};
const S = platformFor({ properties: props });
S.PropertiesService.getScriptProperties().setProperty('GOOGLE_GATE', 'on');
ok('a property set is a property stored', props.GOOGLE_GATE === 'on');
ok('and read back as a string', S.PropertiesService.getScriptProperties().getProperty('GOOGLE_GATE') === 'on');
ok('an absent property is null, not undefined',
  S.PropertiesService.getScriptProperties().getProperty('NOPE') === null);
S.PropertiesService.getScriptProperties().deleteProperty('GOOGLE_GATE');
ok('and deleting it removes it', !props.hasOwnProperty('GOOGLE_GATE'));
// A transaction is the lock now, so the old shape has to keep working without doing anything.
const lock = P.LockService.getScriptLock();
ok('a lock can still be taken and released', lock.waitLock(1000) === true &&
  lock.releaseLock() === undefined);

console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);
