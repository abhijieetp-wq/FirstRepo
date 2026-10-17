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
const { connect } = require('./db.js');
const { loadPortal } = require('./load.js');
const { render, escapeHtml } = require('./page.js');

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
  const properties = Object.assign({}, process.env.ERP_PROPERTIES
    ? JSON.parse(process.env.ERP_PROPERTIES) : {}, o.properties || {});

  /**
   * Which face of the portal to serve. The new design by default; ERP_UI=classic serves
   * exactly what Apps Script serves, from the same files. Same behaviour either way — only
   * the stylesheet and the shell differ — so this is a way to switch the new look off in a
   * minute if it ever has to be, without a deployment and without losing anything.
   */
  const ui = (o.ui || process.env.ERP_UI) === 'classic' ? 'classic' : 'web';

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
      // ---- the page
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // Through the portal's own COMPANY_ROW_ID rather than an id guessed here. The first
        // version of this looked up 'COMPANY' and the real one is 'CO-1', so the tab was named
        // from the row while bootstrap named the header from the default — the same page
        // calling itself two things depending on which half you read.
        let title = 'ERP';
        try {
          const names = loadPortal(db, 'anonymous', { properties, quiet: true });
          const row = await db.findRowById('CompanyProfile', names.COMPANY_ROW_ID);
          if (row && row.appName) title = row.appName;
        } catch (err) { /* pre-setup, or the profile row is not there yet */ }
        const page = render({ title, googlePass: '' }, { ui });
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

      // ---- is it up, and can it reach the database
      if (req.method === 'GET' && url.pathname === '/health') {
        const t = Date.now();
        await db.q('SELECT 1');
        return json(res, 200, { ok: true, database: Date.now() - t + 'ms', tenant });
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

        const portal = loadPortal(db, 'anonymous', { properties, quiet: true });
        try {
          // `call` is the portal's own door: it resolves the token to a user, refuses the
          // names on CALL_DENY_, and sets CURRENT_USER_ for everything downstream. The web
          // app has always gone through it and this changes nothing about that.
          const out = await portal.call(token, fn, args);
          return json(res, 200, { ok: out === undefined ? null : out });
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
        const portal = loadPortal(db, 'anonymous', { properties, quiet: true });
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
        const portal = loadPortal(db, 'anonymous', { properties, quiet: true });
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

        const portal = loadPortal(db, 'anonymous', { properties, quiet: true });
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
  return server;
}

module.exports = { build };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  let server;
  try { server = build(); } catch (err) { console.error(err.message); process.exit(1); }

  server.listen(port, () => {
    console.log('The portal is on http://localhost:' + port);
    console.log('  tenant:   ' + server.tenant);
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
