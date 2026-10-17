/**
 * The portal, served over HTTP.
 *
 * This is the last piece: everything else existed and nothing could reach it. It replaces
 * exactly what Apps Script's web app did and nothing more — serve the page, and answer the
 * one call the browser makes.
 *
 * NO FRAMEWORK, for the same reason the rest of this project has one dependency. What is
 * needed is a page, a POST, and a health check; Express would be forty more packages to
 * answer for and about the same amount of code to write. `node:http` is not fashionable and
 * it is completely adequate.
 *
 * ONE ENDPOINT, because the browser already works that way. Every one of the 177 calls in
 * JavaScript.html goes through a single `call(token, name, args)` — a decision made when the
 * portal stopped running as the person using it, and the one that makes this file short.
 * Nothing in the browser changes except where `srv` sends its request.
 *
 * A CONTEXT PER REQUEST. loadPortal builds a fresh vm context each time, about 3ms once the
 * scripts are compiled. It has to: the shim holds which connection is current and who is
 * calling, and two requests sharing that would put one person's statements inside another's
 * transaction. 3ms against a 60ms round trip to Singapore is not where the time goes.
 *
 *   DATABASE_URL=postgres://... node server/index.js
 *   PORT=3000 TENANT_ID=pie node server/index.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('./db.js');
const { loadPortal } = require('./load.js');
const { render, escapeHtml } = require('./page.js');
const { fileStore } = require('./files.js');
const { mailer, settings: mailSettings } = require('./mail.js');
const { urlFetchApp } = require('./fetch.js');
const { settingsStore } = require('./settings.js');
const { chromium, chromiumProblem } = require('./pdf.js');

/**
 * Which build this is, taken from src/Code.gs — the same line the portal's own footer
 * shows. Read once at start-up rather than restated here, because a version number kept
 * in two places is a version number that disagrees with itself.
 */
const BUILD = (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
    return (/APP_BUILD\s*=\s*'([^']+)'/.exec(src) || [])[1] || 'unknown';
  } catch (err) { return 'unknown'; }
})();

/**
 * Built rather than started on require, so a test can run one on a port of its own and stop
 * it again. Starting a listener as a side effect of loading a file is how a test suite ends
 * up with four servers fighting over port 3000 — which is exactly what happened while this
 * was being written, and it cost twenty minutes of testing the previous version of the code
 * without realising it.
 */
function build(options) {
  const o = options || {};
  const tenant = o.tenant || process.env.TENANT_ID || 'pie';
  const url = o.connectionString || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. The portal has nowhere to read from.');

  // One pool for the process. Every request borrows a connection and gives it back; opening
  // one per request against Neon would spend more time on handshakes than on queries.
  const db = o.db || connect({ connectionString: url, tenant, max: o.max || 10 });

  /**
   * Script Properties, which Apps Script had and a Node process does not.
   *
   * Held in memory for now, which is honest about what it is: the Google gate settings and
   * the telemetry switch live here, and they will not survive a restart. That is a decision
   * still to make with PIE — a settings table is the obvious answer — and pretending
   * otherwise by writing them to a file nobody backs up would be worse than the plain truth.
   */
  /**
   * Settings, read from the database once and kept in memory because the portal reads them
   * synchronously. ERP_PROPERTIES seeds anything the database does not have; what PIE sets
   * in Settings wins from then on. A test passes `properties` to skip the table entirely.
   */
  const seeded = Object.assign({}, process.env.ERP_PROPERTIES
    ? JSON.parse(process.env.ERP_PROPERTIES) : {}, o.properties || {});
  const durable = o.properties ? null : settingsStore(db, seeded);
  const properties = durable ? durable.props : seeded;
  // Awaited by every request before the portal is loaded, so nothing is ever answered from
  // an empty settings table — which for the Google gate would mean answering "off".
  const ready = durable ? durable.load().catch((err) => {
    console.error('[settings] could not be read: ' + err.message +
      ' — the portal will run on defaults until this is fixed.');
  }) : Promise.resolve();

  /**
   * Which face of the portal to serve. The new design by default; ERP_UI=classic serves
   * exactly what Apps Script serves, from the same files. Same behaviour either way — only
   * the stylesheet and the shell differ — so this is a way to switch the new look off in a
   * minute if it ever has to be, without a deployment and without losing anything.
   */
  const ui = (o.ui || process.env.ERP_UI) === 'classic' ? 'classic' : 'web';

  /**
   * Attachments and e-mail.
   *
   * Both are made once and handed to every request. The file store is a directory; the
   * mailer is a set of environment variables. Either one unconfigured is not an error here —
   * the portal refuses at the call, naming what is missing, so a server started for a look
   * around still works for everything that does not need them.
   */
  const files = fileStore({ dir: o.filesDir, tenant });
  const mail = mailer({ settings: o.smtp });
  const http_ = urlFetchApp({});
  const smtpReady = (() => { const c = o.smtp || mailSettings();
    return !!(c.url && c.user && c.password); })();

  /**
   * What makes /files/<id> openable in a new tab.
   *
   * The portal stores a plain /files/<id> in its own rows, because a link it stored with a
   * signature in it would be a stored thing that expires. The signature is added to every
   * such URL on its way out of /api/call instead, so a link is good for a day from the
   * moment the screen that shows it was drawn.
   *
   * The key is ERP_FILE_SECRET, or derived from the database URL when that is not set —
   * stable across restarts, so a page left open over lunch still works, and never sent
   * anywhere. A link is as good as a password for that one file until it expires, which is
   * the same bargain as a Drive "anyone with the link" share and is why it is short.
   */
  const fileKey = crypto.createHash('sha256')
    .update(process.env.ERP_FILE_SECRET || ('erp-files:' + url + ':' + tenant)).digest();
  const FILE_URL = /"\/files\/([0-9a-f]{32})(\?download=1)?"/g;
  const LINK_SECONDS = 24 * 60 * 60;

  function signFile(id, expiry) {
    return crypto.createHmac('sha256', fileKey).update(id + '.' + expiry)
      .digest('base64url').slice(0, 32);
  }
  /** Adds the signature to every /files/<id> in a reply, leaving everything else alone. */
  function signFileUrls(text) {
    if (text.indexOf('/files/') === -1) return text;
    const expiry = Math.floor(Date.now() / 1000) + LINK_SECONDS;
    return text.replace(FILE_URL, (_, id, download) =>
      '"/files/' + id + '?t=' + expiry + '.' + signFile(id, expiry) +
      (download ? '&download=1' : '') + '"');
  }
  /**
   * What this server calls itself, which Google has to be told and has to match exactly.
   *
   * ERP_BASE_URL when set, because behind a proxy the Host header can be anything and the
   * redirect URI registered with Google is one specific string. Derived from the request
   * otherwise, honouring x-forwarded-proto so a TLS-terminating proxy does not produce an
   * http:// redirect that Google rejects.
   */
  function baseUrlFor(req) {
    if (process.env.ERP_BASE_URL) return String(process.env.ERP_BASE_URL).replace(/\/+$/, '');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.encrypted ? 'https' : 'http');
    return proto + '://' + host;
  }

  function fileAllowed(id, token) {
    const [expiry, sig] = String(token || '').split('.');
    if (!/^[0-9]+$/.test(expiry || '') || !sig) return false;
    if (Number(expiry) * 1000 < Date.now()) return false;
    const want = Buffer.from(signFile(id, expiry));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

function body(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A request body is a few hundred bytes of arguments. Anything past a megabyte is
      // either a mistake or somebody trying to exhaust the process. Rejected rather than
      // buffered, and the caller gets a 413 rather than a dropped connection — a dropped
      // connection is indistinguishable from the server having fallen over, which is the
      // wrong thing to tell somebody whose only mistake was a runaway argument.
      if (size > (limit || 1024 * 1024)) {
        tooBig = true;
        reject(Object.assign(new Error('Request too large.'), { tooBig: true }));
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, type, text, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    // The portal is the only thing on this origin and nothing embeds it.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  }, headers || {}));
  res.end(text);
}

const json = (res, status, obj) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

/**
 * What a failure tells the browser.
 *
 * The message goes through, because the portal's errors are written for the person reading
 * them — "This order is on credit hold" is the whole point of that throw. The stack does not:
 * it names table and column layouts, and it belongs in the server log where PIE's staff are
 * not looking at it.
 */
function failed(res, err, where) {
  const message = (err && err.message) ? String(err.message) : String(err);
  const status = statusFor(message);

  // 500 means something here is broken and somebody should look. A wrong password and a
  // function name that does not exist are neither — they are the portal working. Logging
  // them all at the same level makes a log in which a real fault is invisible, and that is
  // the log PIE will be running on.
  if (status >= 500) {
    console.error('[' + new Date().toISOString() + '] ' + where + ': ' + message);
    if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  } else {
    console.log('[' + new Date().toISOString() + '] ' + where + ' refused (' + status + '): ' +
      message);
  }
  json(res, status, { error: message });
}

/**
 * Which of these is a fault and which is an answer.
 *
 * By message, because a message is what the portal throws — it has no error codes, and
 * inventing a hierarchy of error classes across 42 modules to serve this one mapping would
 * be a large change for a small gain. The browser does not read the status at all: `srv`
 * matches on the text, exactly as it did against Apps Script. These codes are for whoever
 * is reading the log at three in the afternoon wondering what broke.
 */
function statusFor(message) {
  if (/SESSION_ENDED|GOOGLE_ACCOUNT_BLOCKED/.test(message)) return 401;
  if (/do not match|must change your password/i.test(message)) return 401;
  if (/don't have permission|do not have permission|Requires:/i.test(message)) return 403;
  if (/^Unknown action/.test(message)) return 400;
  return 500;
}

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    try {
      await ready;
      // ---- the page
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        /**
         * The Google gate, which doGet used to run before serving anything.
         *
         * It was missing here, and with its setting unable to survive a restart the effect
         * was invisible: the gate read as off, and a portal that demands a Google account
         * on Apps Script did not on the server. Now the setting persists, so this has to
         * run or switching it on would lock everybody out.
         *
         * Three answers: carry on; carry on with a pass Google just issued; or serve the
         * gate's own page instead of the portal.
         */
        let googlePass = '';
        let title = 'ERP';
        try {
          const portal = loadPortal(db, 'anonymous', {
            properties, propertyStore: durable && durable.store(''), quiet: true,
            drive: files.DriveApp, mail, fetch: http_, baseUrl: baseUrlFor(req) });
          const gate = portal.googleGateForRequest_({
            parameter: Object.fromEntries(url.searchParams) });
          if (!gate.serve) {
            return send(res, 200, 'text/html; charset=utf-8', gate.html.getContent());
          }
          googlePass = gate.pass || '';
          // Through the portal's own COMPANY_ROW_ID rather than an id guessed here. The
          // first version looked up 'COMPANY' and the real one is 'CO-1', so the tab was
          // named from the row while bootstrap named the header from the default.
          const row = await db.findRowById('CompanyProfile', portal.COMPANY_ROW_ID);
          if (row && row.appName) title = row.appName;
        } catch (err) {
          // Pre-setup, or no profile row yet. A fault in the gate must not be a blank page:
          // it is logged and the portal is served, which leaves the password in front of it.
          console.error('[page] ' + (err && err.message));
        }
        const page = render({ title, googlePass }, { ui });
        if (page.warnings.length) {
          console.error('Template tags the renderer does not understand: ' +
            page.warnings.join(' '));
        }
        return send(res, 200, 'text/html; charset=utf-8', page.html);
      }

      // ---- the typefaces, from this origin
      //
      // The stylesheet used to @import three families from fonts.googleapis.com, which is
      // four serial round trips to a third party before a heading can be drawn. These are
      // the same faces, latin only, 77 KB for all three, cached for a year — and nothing
      // leaves this origin to fetch them. The stylesheet still names Google's copy as a
      // second source, so the Apps Script portal, which cannot serve a file, is unaffected
      // while both systems are up.
      //
      // The name is matched against a pattern rather than cleaned, because every attempt to
      // clean a path is a chance to get it wrong: no slashes, no dots, no traversal to think
      // about.
      if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
        const name = url.pathname.slice('/fonts/'.length);
        if (!/^[a-z0-9-]+\.woff2$/.test(name)) {
          return json(res, 404, { error: 'No such thing here.' });
        }
        let font;
        try {
          font = fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', name));
        } catch (err) {
          return json(res, 404, { error: 'No such thing here.' });
        }
        res.writeHead(200, {
          'Content-Type': 'font/woff2',
          'Content-Length': font.length,
          // Immutable: the file name changes when the font does, so nothing here ever
          // needs revalidating.
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(font);
      }

      // ---- an attachment, or a generated PDF
      //
      // Opened from a plain link in a new tab, so there is no header to carry a session
      // token and the signature in the query string is what stands in for one. It is
      // checked in constant time and against the clock; anything wrong is the same 404 a
      // missing file gets, because telling a stranger which ids exist is itself an answer.
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const id = url.pathname.slice('/files/'.length);
        if (!fileAllowed(id, url.searchParams.get('t'))) {
          return json(res, 404, { error: 'That link is not valid, or has expired.' });
        }
        const file = files.read(id);
        if (!file) return json(res, 404, { error: 'That file is no longer here.' });
        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': file.bytes.length,
          // Named, so a download is not called by its id; inline where a browser can show
          // it, because most of these are a PDF or a photograph somebody wants to glance at.
          'Content-Disposition': (url.searchParams.get('download') ? 'attachment' : 'inline') +
            '; filename="' + String(file.name).replace(/[^\x20-\x7E]/g, '_')
              .replace(/["\\]/g, '') + '"',
          'X-Content-Type-Options': 'nosniff',
          // Private: a shared cache must not keep somebody's purchase order.
          'Cache-Control': 'private, max-age=300'
        });
        return res.end(file.bytes);
      }

      // ---- the icon every browser asks for without being told to
      //
      // Not a nicety: a browser requests /favicon.ico on its own, and without this every
      // page load logs a 404 that looks exactly like a real missing resource. Inline SVG,
      // so there is no file to deploy and nothing to go missing.
      if (req.method === 'GET' && /^\/favicon\.(ico|svg)$/.test(url.pathname)) {
        const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
          '<rect width="64" height="64" rx="12" fill="#12233D"/>' +
          '<text x="32" y="43" font-family="Inter,Segoe UI,sans-serif" font-size="30" ' +
          'font-weight="700" fill="#E8871E" text-anchor="middle">P</text></svg>';
        return send(res, 200, 'image/svg+xml', icon,
          { 'Cache-Control': 'public, max-age=86400' });
      }

      /**
       * Is it up, and which of its parts are actually working.
       *
       * Not just a pulse. Four of this portal's capabilities depend on something outside
       * the database — a writable directory, a browser, a mailbox, a Tally — and each one
       * fails only at the moment somebody tries to use it. On a host, that moment is a
       * coordinator discovering on a Tuesday that quotations cannot be printed. So this
       * says what is live, and one request after a deployment answers it.
       *
       * `ok` stays true when a capability is missing: the portal genuinely works without
       * any of them, and a health check that fails for an unconfigured mailbox would have
       * the host restart a perfectly good server for ever.
       */
      if (req.method === 'GET' && url.pathname === '/health') {
        const t = Date.now();
        await db.q('SELECT 1');
        const database = Date.now() - t + 'ms';

        // Written to, not just looked at: a mounted volume the process cannot write to
        // looks exactly like one it can until the first attachment.
        let filesState = 'ok';
        try {
          fs.mkdirSync(files.dir, { recursive: true });
          const probe = path.join(files.dir, '.writable');
          fs.writeFileSync(probe, String(Date.now()));
          fs.unlinkSync(probe);
        } catch (err) {
          filesState = 'NOT WRITABLE: ' + (err && err.code ? err.code : err.message);
        }
        const held = filesState === 'ok' ? files.stat() : null;

        const browser = chromium();
        const tally = !!(properties.TALLY_ENDPOINT || '').trim();

        return json(res, 200, {
          ok: true,
          build: BUILD,
          tenant,
          look: ui,
          database,
          settings: durable
            ? (durable.isLoaded() ? Object.keys(properties).length + ' held' : 'NOT READ')
            : 'in memory only — will not survive a restart',
          attachments: filesState === 'ok'
            ? { state: 'ok', dir: files.dir, held: held.files, bytes: held.bytes }
            : { state: filesState, dir: files.dir },
          pdfs: browser ? { state: 'ok', chromium: browser }
            : { state: 'unavailable — ' + chromiumProblem() },
          email: smtpReady ? { state: 'ok' }
            : { state: 'unconfigured — set SMTP_URL, SMTP_USER, SMTP_PASSWORD' },
          tally: tally ? { state: 'ok', endpoint: properties.TALLY_ENDPOINT }
            : { state: 'unconfigured — set it in Settings \u2192 Tally Connection' },
          googleGate: String(properties.GOOGLE_GATE || '').toLowerCase() === 'on'
            ? 'demanded' : 'off'
        });
      }

      // ---- the one door
      if (req.method === 'POST' && url.pathname === '/api/call') {
        let payload;
        try { payload = JSON.parse(await body(req)); }
        catch (err) {
          if (err && err.tooBig) return json(res, 413, { error: 'That request is too large.' });
          return json(res, 400, { error: 'Could not read the request.' });
        }

        const fn = String(payload.fn || '');
        const args = Array.isArray(payload.args) ? payload.args : [];
        const token = payload.token || null;

        const portal = loadPortal(db, 'anonymous', { properties, propertyStore: durable && durable.store(''), quiet: true, drive: files.DriveApp, mail, fetch: http_ });
        try {
          // `call` is the portal's own door: it resolves the token to a user, refuses the
          // names on CALL_DENY_, and sets CURRENT_USER_ for everything downstream. The web
          // app has always gone through it and this changes nothing about that.
          const out = await portal.call(token, fn, args);
          // Signed here rather than where the row is written, so the link is a day old at
          // most when the browser gets it. See signFileUrls.
          return send(res, 200, 'application/json; charset=utf-8',
            signFileUrls(JSON.stringify({ ok: out === undefined ? null : out })));
        } catch (err) {
          return failed(res, err, 'call ' + fn);
        }
      }

      // ---- the two other doors the browser needs, and why they are not /api/call
      //
      // `logout` is on CALL_DENY_ — a token must not be usable to mint or revoke another —
      // and `googleGateSignInLink` is asked for BEFORE anybody has signed in, when `call`
      // has no session to resolve. Both are deliberate holes in that door rather than
      // oversights, so they get their own.
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        let payload = {};
        try { payload = JSON.parse(await body(req)); } catch (err) { /* a logout with no
          readable body still means "forget my session", and refusing it would leave the
          session alive because the browser sent something odd */ }
        const portal = loadPortal(db, 'anonymous', { properties, propertyStore: durable && durable.store(''), quiet: true, drive: files.DriveApp, mail, fetch: http_ });
        try {
          await portal.logout(payload.token || null);
          return json(res, 200, { ok: true });
        } catch (err) {
          // A logout that fails must still look like a logout: the browser has already
          // forgotten the token and sending the person back to a working screen would be
          // worse than letting a dead session expire on its own.
          console.log('logout: ' + (err && err.message));
          return json(res, 200, { ok: true });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/google-link') {
        const portal = loadPortal(db, 'anonymous', { properties,
          propertyStore: durable && durable.store(''), quiet: true, drive: files.DriveApp,
          mail, fetch: http_, baseUrl: baseUrlFor(req) });
        try {
          return json(res, 200, { ok: await portal.googleGateSignInLink() });
        } catch (err) {
          return failed(res, err, 'googleGateSignInLink');
        }
      }

      // ---- signing in, which cannot go through `call` because there is no token yet
      if (req.method === 'POST' && url.pathname === '/api/login') {
        let payload;
        try { payload = JSON.parse(await body(req)); }
        catch (err) {
          if (err && err.tooBig) return json(res, 413, { error: 'That request is too large.' });
          return json(res, 400, { error: 'Could not read the request.' });
        }

        const portal = loadPortal(db, 'anonymous', { properties, propertyStore: durable && durable.store(''), quiet: true, drive: files.DriveApp, mail, fetch: http_ });
        try {
          const out = await portal.login(payload.username, payload.password, payload.googlePass);
          return json(res, 200, { ok: out });
        } catch (err) {
          return failed(res, err, 'login');
        }
      }

      return json(res, 404, { error: 'No such thing here.' });
    } catch (err) {
      return failed(res, err, req.method + ' ' + url.pathname);
    }
  });

  server.db = db;
  server.tenant = tenant;
  server.ui = ui;
  server.files = files;
  server.ready = ready;
  server.settings = durable;
  server.smtpReady = smtpReady;
  return server;
}

module.exports = { build, dropPrivileges };

/**
 * Fixes the attachments directory and then stops being root.
 *
 * A host mounts its volume as root, over the directory the image prepared, so a container
 * that starts as the `node` user cannot write to the one place it needs to. Railway's own
 * answer is a variable that runs everything as root for ever; this does the same job for
 * the two syscalls that need it and then gives the privilege back.
 *
 * Runs only when this process really is root. Started as anybody else — a laptop, a host
 * that already drops privileges — it does nothing and the directory is whatever it is,
 * which /health reports either way.
 *
 * ERP_RUN_AS names the user to become; `node` is what the image provides. Set it to `root`
 * to stay root deliberately, which is at least then a decision somebody made.
 */
function dropPrivileges(dir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;

  const want = process.env.ERP_RUN_AS || 'node';
  if (want === 'root' || want === '0') return 'staying root (ERP_RUN_AS=' + want + ')';

  let uid, gid;
  try {
    // The image's own passwd file is the authority on which id `node` is; guessing 1000
    // is right until the day it is not.
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n')
      .find((l) => l.split(':')[0] === want);
    if (!line) throw new Error('there is no user called ' + want + ' in this image');
    uid = Number(line.split(':')[2]);
    gid = Number(line.split(':')[3]);
  } catch (err) {
    console.error('[startup] cannot drop privileges: ' + err.message +
      ' — continuing as root. Set ERP_RUN_AS to a user that exists, or to `root` to mean it.');
    return null;
  }

  // Everything already in there too, or a file written during an earlier root-only run
  // becomes one this process can no longer replace.
  let fixed = 0;
  const chownTree = (p, depth) => {
    try {
      fs.chownSync(p, uid, gid);
      fixed++;
      if (depth > 0 && fs.statSync(p).isDirectory()) {
        for (const e of fs.readdirSync(p)) chownTree(path.join(p, e), depth - 1);
      }
    } catch (err) { /* reported by the health check, which tries an actual write */ }
  };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { /* chown will report it */ }
  chownTree(dir, 3);

  try {
    // Groups first: after setuid there is no privilege left to change them with.
    if (typeof process.setgroups === 'function') process.setgroups([gid]);
    process.setgid(gid);
    process.setuid(uid);
  } catch (err) {
    console.error('[startup] could not become ' + want + ': ' + err.message +
      ' — continuing as root.');
    return null;
  }
  return 'running as ' + want + ' (' + uid + ':' + gid + '), ' + fixed +
    ' path(s) in ' + dir + ' handed over';
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Before the server is built, because build() opens a connection pool and the point is
  // to be unprivileged by the time anything outside can reach this process.
  const dropped = dropPrivileges(process.env.ERP_FILES_DIR ||
    path.join(__dirname, '..', 'var', 'files'));
  let server;
  try { server = build(); } catch (err) { console.error(err.message); process.exit(1); }

  server.listen(port, () => {
    console.log('The portal is on http://localhost:' + port);
    console.log('  tenant:   ' + server.tenant);
    server.ready.then(() => console.log('  settings: ' +
      (server.settings ? Object.keys(server.settings.props).length + ' held in the database'
        : 'in memory only')));
    if (dropped) console.log('  user:     ' + dropped);
    console.log('  files:    ' + server.files.dir +
      ' (' + server.files.stat().files + ' held)');
    console.log('  e-mail:   ' + (server.smtpReady ? 'configured' :
      'not configured — set SMTP_URL, SMTP_USER, SMTP_PASSWORD to send quotations'));
    console.log('  look:     ' + (server.ui === 'classic'
      ? 'classic (ERP_UI=classic) — the Apps Script design' : 'the new design'));
    console.log('  database: ' +
      String(process.env.DATABASE_URL).replace(/:[^:@/]*@/, ':****@'));
  });

  // A pool that is not drained keeps the process alive after the socket closes, and a
  // process that will not stop is one somebody kills, which is how a transaction gets cut
  // in half.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('\nStopping.');
      server.close(() => server.db.pool.end()
        .then(() => process.exit(0), () => process.exit(0)));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
