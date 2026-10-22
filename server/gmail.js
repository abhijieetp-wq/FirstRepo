/**
 * Sending the quotation through PIE's own Gmail, over Google's web API rather than SMTP.
 *
 * WHY THIS EXISTS. Railway blocks outgoing SMTP — ports 25, 465 and 587 — on its Trial and Hobby
 * plans, to stop spam leaving its network, and PIE are going to run on Hobby. An app password and
 * smtp.gmail.com would simply time out. The Gmail API is ordinary HTTPS on port 443, which no
 * plan blocks, and it sends as the Gmail account itself: the customer sees
 * admin.premierindia@gmail.com, and the offer lands in that account's Sent folder, exactly as
 * it did when Apps Script sent it.
 *
 * HOW IT IS CONNECTED. Once, by somebody who can sign in to that Gmail account: Settings → Email
 * → Connect Gmail sends them to Google, Google asks whether this portal may send email as them,
 * and comes back to /oauth/gmail with a one-time code. The server swaps the code for a refresh
 * token — a long-lived permission to send, and nothing else: the scope is gmail.send, which
 * cannot read, delete or search the mailbox — and keeps it in the settings table. The Gmail
 * password is never seen. Disconnecting revokes the permission at Google and forgets it here.
 *
 * The OAuth client is the one the Google sign-in already uses (Settings → System → Sign-in
 * Restriction holds its id and secret), so there is nothing new to create — only the Gmail API
 * to enable and a second redirect address to register.
 *
 * SYNCHRONOUS, like the SMTP path and for the same reason: QuotationEmail.gs calls
 * MailApp.sendEmail without `await`, and a send that has not finished must not let the quotation
 * be marked Submitted. So every request goes through curl and execFileSync, with credentials on
 * stdin or in a file, never on the command line where `ps` would show them.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'];
const KEYS = {
  TOKEN: 'GMAIL_REFRESH_TOKEN',
  SENDER: 'GMAIL_SENDER',
  AT: 'GMAIL_CONNECTED_AT',
  BY: 'GMAIL_CONNECTED_BY',
  CLIENT_ID: 'GOOGLE_GATE_CLIENT_ID',
  CLIENT_SECRET: 'GOOGLE_GATE_CLIENT_SECRET'
};
const STATE_MINUTES = 15;

/** Google's addresses. Overridable so a test can stand a fake Google up on localhost. */
function endpoints(env) {
  const e = env || process.env;
  return {
    auth: e.GMAIL_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: e.GMAIL_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    send: e.GMAIL_SEND_URL ||
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    revoke: e.GMAIL_REVOKE_URL || 'https://oauth2.googleapis.com/revoke'
  };
}

/**
 * One HTTPS request through curl, synchronously.
 *
 * `headers` and the body go through files and stdin rather than arguments: the body of a token
 * request carries the client secret and the refresh token, and a header carries the access
 * token. Returns { code, body } and never throws on an HTTP status — the callers read Google's
 * own error out of the body, which is where the useful words are.
 */
function request(url, opts) {
  const o = opts || {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-gmail-'));
  const out = path.join(work, 'out');
  const send = path.join(work, 'send');
  try {
    const config = ['silent', 'show-error', 'max-time = "60"', 'request = "POST"',
      'output = "' + out + '"', 'write-out = "%{http_code}"'];
    for (const [k, v] of Object.entries(o.headers || {})) {
      config.push('header = "' + (k + ': ' + v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
    }
    if (o.body !== undefined) {
      fs.writeFileSync(send, o.body);
      config.push('data-binary = "@' + send + '"');
    }
    config.push('url = "' + String(url).replace(/"/g, '%22') + '"');
    const printed = execFileSync('curl', ['--config', '-'], {
      input: config.join('\n') + '\n', encoding: 'utf8', timeout: 70000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const code = Number(String(printed).trim().slice(-3)) || 0;
    const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    return { code, body };
  } catch (err) {
    const said = (err && err.stderr ? String(err.stderr).trim() : '') ||
      (err && err.message ? err.message : String(err));
    throw new Error('Could not reach Google: ' + said.slice(0, 200));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* tmp will go */ }
  }
}

function form(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

function json(text) {
  try { return JSON.parse(text); } catch (err) { return {}; }
}

/** The email address inside an id_token. Read, not verified: it came straight from Google over TLS. */
function emailFromIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) return '';
  const claims = json(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return claims.email && claims.email_verified !== false ? String(claims.email).toLowerCase() : '';
}

/**
 * @param o.props   the live settings object (server/settings.js), read synchronously
 * @param o.writer  (who) => a store with setProperty/deleteProperty that persists
 * @param o.env     process.env by default; where the Google addresses come from
 */
function gmailConnection(o) {
  const props = o.props;
  const writer = o.writer;
  const states = new Map();
  let access = null;      // { token, until, for } — the refresh token it was minted from

  const get = (k) => String(props[k] || '').trim();
  const clientId = () => get(KEYS.CLIENT_ID);
  const clientSecret = () => get(KEYS.CLIENT_SECRET);
  const urls = () => endpoints(o.env);

  function status() {
    const sender = get(KEYS.SENDER);
    return {
      connected: !!(get(KEYS.TOKEN) && sender),
      sender,
      connectedAt: get(KEYS.AT),
      connectedBy: get(KEYS.BY),
      clientConfigured: !!(clientId() && clientSecret())
    };
  }

  /** Where to send the browser, with a one-time value that proves it came back from there. */
  function connectUrl(redirectUri, by) {
    if (!clientId() || !clientSecret()) {
      throw new Error('Enter the Google client id and secret first, in Settings → System ' +
        '→ Sign-in Restriction. The Gmail connection uses the same Google project.');
    }
    const now = Date.now();
    for (const [k, v] of states) if (v.until < now) states.delete(k);
    const state = crypto.randomBytes(24).toString('hex');
    states.set(state, { by: String(by || ''), redirectUri, until: now + STATE_MINUTES * 60000 });
    return urls().auth + '?' + form({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Asked every time, so Google always hands back a refresh token — without it a second
      // connection after a disconnect would come back with none and nothing to send with.
      prompt: 'consent',
      state
    });
  }

  /**
   * Google came back. Swaps the code for a refresh token and keeps it.
   *
   * @return { sender, by }
   */
  function finish(query) {
    const q = query || {};
    const state = String(q.state || '');
    const pending = states.get(state);
    states.delete(state);                  // single use, whatever happens next
    if (!pending || pending.until < Date.now()) {
      throw new Error('This link has expired or was already used. Go back to Settings → ' +
        'Email and press Connect Gmail again.');
    }
    if (q.error) {
      throw new Error(q.error === 'access_denied'
        ? 'Google was told not to allow it, so nothing was connected.'
        : 'Google said: ' + String(q.error).slice(0, 100));
    }
    if (!q.code) throw new Error('Google did not send a code back. Try Connect Gmail again.');

    const r = request(urls().token, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ code: String(q.code), client_id: clientId(), client_secret: clientSecret(),
        redirect_uri: pending.redirectUri, grant_type: 'authorization_code' })
    });
    const t = json(r.body);
    if (r.code !== 200 || !t.access_token) {
      throw new Error('Google refused the connection: ' +
        String(t.error_description || t.error || ('status ' + r.code)).slice(0, 200));
    }
    if (!t.refresh_token) {
      throw new Error('Google connected but gave no lasting permission. Remove this app from ' +
        'the Google account (myaccount.google.com → Security → Third-party access) ' +
        'and connect again.');
    }
    if (String(t.scope || '').indexOf('gmail.send') === -1) {
      throw new Error('The permission to send email was not ticked on Google’s screen. ' +
        'Press Connect Gmail again and allow "Send email on your behalf".');
    }
    const sender = emailFromIdToken(t.id_token);
    if (!sender) throw new Error('Google did not say which account this is. Try again.');

    const store = writer(pending.by || 'gmail');
    store.setProperty(KEYS.TOKEN, t.refresh_token);
    store.setProperty(KEYS.SENDER, sender);
    store.setProperty(KEYS.AT, new Date().toISOString());
    store.setProperty(KEYS.BY, pending.by || '');
    access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000,
      for: t.refresh_token };
    return { sender, by: pending.by };
  }

  /** A current access token, minted from the refresh token when the last one is near expiry. */
  function accessToken() {
    const refresh = get(KEYS.TOKEN);
    if (!refresh) throw new Error('Gmail is not connected.');
    if (access && access.for === refresh && access.until > Date.now()) return access.token;
    const r = request(urls().token, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refresh,
        grant_type: 'refresh_token' })
    });
    const t = json(r.body);
    if (r.code !== 200 || !t.access_token) {
      access = null;
      if (t.error === 'invalid_grant') {
        throw new Error('Gmail has stopped allowing this portal to send — the connection ' +
          'was removed in the Google account, or its password changed. Go to Settings → ' +
          'Email and press Connect Gmail again. The quotation itself is saved.');
      }
      throw new Error('Google would not renew the Gmail connection: ' +
        String(t.error_description || t.error || ('status ' + r.code)).slice(0, 200));
    }
    access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000,
      for: refresh };
    return access.token;
  }

  /** Sends one finished RFC 5322 message. Throws, in words, if Google does not accept it. */
  function send(message) {
    const token = accessToken();
    const r = request(urls().send, {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'message/rfc822' },
      body: Buffer.from(message, 'utf8')
    });
    if (r.code === 401) access = null;     // a token Google no longer accepts is not kept
    if (r.code < 200 || r.code >= 300) {
      const e = json(r.body).error || {};
      throw new Error('Gmail did not send it: ' +
        String(e.message || ('status ' + r.code)).slice(0, 200));
    }
    return json(r.body).id || true;
  }

  /** Forgets the permission here, and asks Google to revoke it. The second is best effort. */
  function disconnect(by) {
    const refresh = get(KEYS.TOKEN);
    let revoked = false;
    if (refresh) {
      try {
        const r = request(urls().revoke, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ token: refresh })
        });
        revoked = r.code === 200;
      } catch (err) { /* forgotten here regardless; the Google account can remove it too */ }
    }
    const store = writer(by || 'gmail');
    [KEYS.TOKEN, KEYS.SENDER, KEYS.AT, KEYS.BY].forEach((k) => store.deleteProperty(k));
    access = null;
    return { revoked };
  }

  return { status, connectUrl, finish, send, disconnect, accessToken };
}

module.exports = { gmailConnection, emailFromIdToken, endpoints, SCOPES, KEYS };
