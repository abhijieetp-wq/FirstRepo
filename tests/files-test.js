/**
 * The attachment store, and the DriveApp the portal still thinks it is talking to.
 *
 * Every assertion here is about a promise this shim makes to code it cannot change:
 * Documents.gs calls four Drive methods with no `await` and expects a file back, and the
 * row it writes afterwards points at the id this returned. If any of that is a promise, or
 * an id that cannot be found again, attachments break in a way no unit test of the portal
 * would catch — the portal is correct and its floor has gone.
 *
 *   node tests/files-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileStore, slug } = require(path.join(__dirname, '..', 'server', 'files.js'));
const { platformFor } = require(path.join(__dirname, '..', 'server', 'platform.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-files-test-'));
const store = fileStore({ dir: DIR, tenant: 'pie', actor: 'boss@pie.in' });
const P = platformFor({});
const blob = (text, type, name) => P.Utilities.newBlob(text, type, name);

console.log('A FILE GOES IN AND COMES BACK');
// The exact four calls Documents.gs makes, in the order it makes them, with no await.
const folders = store.DriveApp.getFoldersByName('ERP Documents');
ok('a folder that was never made is not there', !folders.hasNext());
const folder = folders.hasNext() ? folders.next() : store.DriveApp.createFolder('ERP Documents');
const file = folder.createFile(blob('a purchase order', 'application/pdf', 'PO 2210.pdf'));
ok('createFile returns a file, not a promise', file && typeof file.getId === 'function' &&
  typeof file.then !== 'function');
const id = file.getId();
ok('with an opaque id', /^[0-9a-f]{32}$/.test(id), id);
ok('and a url the server can serve', file.getUrl() === '/files/' + id, file.getUrl());
ok('and a download url', file.getDownloadUrl() === '/files/' + id + '?download=1');
ok('the name survives', file.getName() === 'PO 2210.pdf', file.getName());
ok('and the type', file.getMimeType() === 'application/pdf', file.getMimeType());

const back = store.read(id);
ok('the bytes come back exactly', back && back.bytes.toString('utf8') === 'a purchase order');
ok('with the name and type', back.name === 'PO 2210.pdf' && back.mimeType === 'application/pdf');
ok('getFileById finds it again', store.DriveApp.getFileById(id).getId() === id);
ok('and the folder is now there',
  store.DriveApp.getFoldersByName('ERP Documents').hasNext());

console.log('\nAND THE BIN IS A BIN, NOT A SHREDDER');
// Documents.gs says so in as many words: a purchase order removed by the wrong click is
// worth keeping for a while.
store.DriveApp.getFileById(id).setTrashed(true);
ok('a trashed file stops being served', store.read(id) === null);
ok('but its bytes are still on disk', fs.existsSync(path.join(DIR, 'pie', id + '.bin')));
ok('and it says it is trashed', store.DriveApp.getFileById(id).isTrashed());
ok('nothing is purged before its time', store.purgeTrashed(30) === 0);
// Backdate it and sweep.
const metaPath = path.join(DIR, 'pie', id + '.json');
const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
m.trashed = new Date(Date.now() - 40 * 86400000).toISOString();
fs.writeFileSync(metaPath, JSON.stringify(m));
ok('and one past it is', store.purgeTrashed(30) === 1);
ok('bytes gone', !fs.existsSync(path.join(DIR, 'pie', id + '.bin')));

console.log('\nIT WILL NOT BE TALKED OUT OF ITS DIRECTORY');
for (const bad of ['../../etc/passwd', 'a/b', '', null, 'ZZZZ', '../' + 'a'.repeat(32),
  id.toUpperCase()]) {
  ok('refuses ' + JSON.stringify(bad), (() => {
    try { store.DriveApp.getFileById(bad); return false; } catch (e) { return true; }
  })());
}
ok('and read() of a bad id is null, not a throw', store.read('../../etc/passwd') === null);
ok('tenants cannot collide through their names',
  slug('PIE/../other') === 'pie-other', slug('PIE/../other'));

console.log('\nONE TENANT CANNOT SEE ANOTHER');
const other = fileStore({ dir: DIR, tenant: 'other-client' });
const mine = fileStore({ dir: DIR, tenant: 'pie' }).DriveApp
  .createFolder('ERP Documents').createFile(blob('ours', 'text/plain', 'x.txt'));
ok('a file of one tenant is invisible to the next', other.read(mine.getId()) === null);
ok('and it is in its own directory',
  fs.existsSync(path.join(DIR, 'pie', mine.getId() + '.bin')) &&
  !fs.existsSync(path.join(DIR, 'other-client', mine.getId() + '.bin')));

console.log('\nAND IT KNOWS HOW BIG IT HAS GOT');
const s = store.stat();
ok('counting what is held', s.files >= 1 && s.bytes > 0, s);
ok('a file past the limit is refused', (() => {
  const small = fileStore({ dir: DIR, tenant: 'pie', maxBytes: 10 });
  try {
    small.DriveApp.createFolder('f').createFile(blob('much too long for ten bytes', 'text/plain', 'b'));
    return false;
  } catch (e) { return /more than this server stores/.test(e.message); }
})());

console.log('\nTHE BLOB IS A BLOB');
// setName was an arrow function returning `this`, which in an object literal is not the
// object — so it returned undefined, and the one line that makes a quotation PDF
// (newBlob(...).getAs('application/pdf').setName(name)) would have thrown on the next call.
const b = blob('hello', 'text/plain', 'a.txt');
ok('setName hands the blob back', b.setName('b.txt') === b);
ok('and renames it', b.getName() === 'b.txt');
ok('setContentType too', b.setContentType('text/csv') === b && b.getContentType() === 'text/csv');
ok('copyBlob is a copy', (() => {
  const c = b.copyBlob(); c.setName('c.txt');
  return c.getDataAsString() === 'hello' && b.getName() === 'b.txt';
})());
ok('getAs to its own type is itself', (() => { const h = blob('<p>x</p>', 'text/html', 'h.html');
  return h.getAs('text/html') === h; })());
ok('and anything other than PDF is refused in words', (() => {
  try { blob('x', 'text/html', 'h').getAs('image/png'); return false; }
  catch (e) { return /Only HTML to PDF/.test(e.message); }
})());
ok('as is a PDF from something that is not HTML', (() => {
  try { blob('x', 'text/plain', 'h').getAs('application/pdf'); return false; }
  catch (e) { return /Only HTML can be converted/.test(e.message); }
})());

console.log('\nAND IT MAKES A REAL PDF');
const pdf = blob('<!doctype html><h1>Quotation</h1><p>₹1,86,420.00</p>', 'text/html', 'q.html')
  .getAs('application/pdf').setName('PIE-418.pdf');
const bytes = Buffer.from(pdf.getBytes());
ok('the chain returns a blob, not undefined', !!pdf && typeof pdf.getBytes === 'function');
ok('named as asked', pdf.getName() === 'PIE-418.pdf', pdf.getName());
ok('typed as a PDF', pdf.getContentType() === 'application/pdf');
// The four bytes that say so. A renderer that fails late still writes a file.
ok('and really is one', bytes.subarray(0, 4).toString('latin1') === '%PDF', bytes.subarray(0, 8).toString('latin1'));
ok('of a plausible size', bytes.length > 1000, bytes.length);
// Straight into the store, which is what generateQuotationPdf does next.
const saved = store.DriveApp.createFolder('ERP Quotations').createFile(pdf);
ok('and it stores as a PDF', store.read(saved.getId()).bytes.equals(bytes));

console.log('\nAND IT USES THE BROWSER IT WAS TOLD TO');
// Found by staging the container's contents and running them: ERP_CHROMIUM used to be the
// first of several candidates, so a deployment that named the wrong path fell through to
// whatever else was installed, rendered with it, and reported itself healthy. An operator
// who names a path has said which browser to use.
{
  const pdfPath = require.resolve(path.join(__dirname, '..', 'server', 'pdf.js'));
  const fresh = (env) => {
    const had = process.env.ERP_CHROMIUM;
    if (env === null) delete process.env.ERP_CHROMIUM; else process.env.ERP_CHROMIUM = env;
    delete require.cache[pdfPath];
    const mod = require(pdfPath);
    const out = { found: mod.chromium(), problem: mod.chromiumProblem() };
    if (had === undefined) delete process.env.ERP_CHROMIUM; else process.env.ERP_CHROMIUM = had;
    delete require.cache[pdfPath];
    return out;
  };
  const bad = fresh('/nowhere/chromium');
  ok('a path that is not there is not quietly replaced', bad.found === null, bad.found);
  ok('and the complaint names the path that was set',
    /ERP_CHROMIUM is set to \/nowhere\/chromium/.test(bad.problem || ''), bad.problem);
  const auto = fresh(null);
  ok('unset, it looks in the usual places', typeof auto.found === 'string', auto);
  const told = fresh(auto.found);
  ok('and an ERP_CHROMIUM that does exist is used', told.found === auto.found, told);
  ok('with nothing to complain about', told.problem === null);
}

console.log('\nAND IT STOPS BEING ROOT ONCE THE VOLUME IS ITS OWN');
// The first real deployment reported NOT WRITABLE: EACCES on its attachments directory.
// A host mounts a volume as root over whatever the image prepared, so a container running
// as an ordinary user cannot write to the one place it must. The server now starts as
// root, hands that directory over, and drops — before it opens a socket, so nothing
// reachable from outside is ever running as root.
{
  const { dropPrivileges } = require(path.join(__dirname, '..', 'server', 'index.js'));
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  const had = process.env.ERP_RUN_AS;
  process.env.ERP_RUN_AS = 'root';
  ok('asked to stay root, it says so rather than doing it silently',
    asRoot ? /staying root/.test(dropPrivileges(DIR) || '') : dropPrivileges(DIR) === null);
  process.env.ERP_RUN_AS = 'nobody-such-user-exists';
  ok('a user that is not in the image is refused, not guessed at',
    dropPrivileges(DIR) === null);
  if (had === undefined) delete process.env.ERP_RUN_AS; else process.env.ERP_RUN_AS = had;

  if (!asRoot) {
    console.log('  (not root here, so the drop itself is not exercised)');
    ok('and started unprivileged it does nothing at all', dropPrivileges(DIR) === null);
  } else {
    // A child, because dropping privileges is one-way and this process has tests left.
    const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-vol-'));
    fs.mkdirSync(path.join(vol, 'files'));
    fs.chownSync(path.join(vol, 'files'), 0, 0);
    const out = execFileSync(process.execPath, ['-e',
      'const {dropPrivileges}=require(' + JSON.stringify(
        path.join(__dirname, '..', 'server', 'index.js')) + ');' +
      'const said=dropPrivileges(process.env.D);' +
      'console.log(JSON.stringify({said,uid:process.getuid(),gid:process.getgid()}));'
    ], { env: Object.assign({}, process.env, { ERP_RUN_AS: 'nobody', D: path.join(vol, 'files') }),
         encoding: 'utf8' });
    const got = JSON.parse(out);
    ok('it really becomes the other user', got.uid === 65534 && got.gid === 65534, got);
    ok('and says which, and how much it handed over', /running as nobody/.test(got.said || ''),
      got.said);
    const owner = fs.statSync(path.join(vol, 'files'));
    ok('the mount is handed over too', owner.uid === 65534, owner.uid);
    fs.rmSync(vol, { recursive: true, force: true });
  }
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);
