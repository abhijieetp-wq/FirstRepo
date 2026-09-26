/**
 * Which Google account the person is, proved to Google, before the password box will take
 * anything.
 *
 * This is a second lock in front of the existing one, not a replacement. The username and
 * password still decide *who* is using the portal and what they may do; this decides *which
 * account* may attempt it at all. PIE runs four or five PCs with one company Google account,
 * and the two owners sign in as themselves. Anybody else handed the link reaches a page with
 * one button on it, is turned away by Google, and never sees a password box — so a leaked URL
 * stops being a way in.
 *
 * ---------------------------------------------------------------------------------------
 * Two simpler designs were tried first, and neither works here
 *
 * **Session.getActiveUser().** The obvious way to know who is visiting is to deploy the web
 * app to run *as the user accessing* it and read that. Rejected for what it costs: a script
 * running as the visitor touches the spreadsheet with the visitor's own authority, so every
 * account allowed to use the portal must also hold edit access to the spreadsheet. One of
 * those accounts is shared by the whole office. It would hand every employee the raw sheet in
 * Drive — every price, every cost, every customer — with none of the role rules in Auth.gs
 * applying to any of it. The lock would have opened a bigger door than it closed.
 *
 * **Google Identity Services in the page.** A signed-in button, the browser gets an ID token,
 * the server checks it. Rejected because it cannot work here: an Apps Script page runs inside
 * an iframe on a `*.googleusercontent.com` subdomain whose name is generated per user and per
 * session, and an OAuth client's authorised JavaScript origins have to be exact — no
 * wildcards. There is no origin to register, so the button would be refused on every machine.
 *
 * ---------------------------------------------------------------------------------------
 * What this does instead
 *
 * The ordinary OAuth redirect, which is the one flow Apps Script is built for, because the
 * `/exec` address is a fixed URL that *can* be registered.
 *
 *   1. The gate is on and the browser has no pass, so `doGet` serves one button.
 *   2. The button sends the top window to Google, with this portal's `/exec` as the redirect
 *      and a one-time `state` this server generated.
 *   3. Google signs the person in and comes back to `/exec?code=…&state=…`.
 *   4. `doGet` checks the state, exchanges the code for an ID token — server to server, with
 *      the client secret, so nothing in the browser can forge it — and reads the address.
 *   5. If the address is on the list, a short-lived pass is put in the cache and handed to
 *      the page, which sends it with the username and password. `login` spends the pass and
 *      writes the address onto the session.
 *   6. Every later request re-reads the list against the session's address, so removing an
 *      account ends its access on the next click rather than at the next sign-in.
 *
 * The app still runs as its owner throughout. The spreadsheet stays shared with nobody, and
 * none of these accounts needs any access to any file of ours — only the `openid email`
 * scopes, which are the non-sensitive ones.
 *
 * ---------------------------------------------------------------------------------------
 * The way out, if it is ever needed
 *
 * Apps Script editor → Project Settings → Script properties → set GOOGLE_GATE to `off`.
 * That needs the script owner's Google account and nothing else — no portal password and no
 * access to the spreadsheet. It is deliberately somewhere the gate cannot reach.
 */

var GOOGLE_GATE_PROPS_ = {
  ENFORCED: 'GOOGLE_GATE',            // 'on' | 'off' — anything but 'on' is off
  ACCOUNTS: 'GOOGLE_GATE_ACCOUNTS',
  CLIENT_ID: 'GOOGLE_GATE_CLIENT_ID',
  CLIENT_SECRET: 'GOOGLE_GATE_CLIENT_SECRET'
};

var GOOGLE_AUTH_URL_ = 'https://accounts.google.com/o/oauth2/v2/auth';
var GOOGLE_TOKEN_URL_ = 'https://oauth2.googleapis.com/token';
var GOOGLE_ISSUERS_ = ['accounts.google.com', 'https://accounts.google.com'];

/** Long enough to sign in and type a password; short enough that a stray URL is worthless. */
var GOOGLE_STATE_SECONDS_ = 600;
var GOOGLE_PASS_SECONDS_ = 900;

/**
 * Who is allowed before anybody has configured anything.
 *
 * The two owners of PIE and PMT, and the company account the shop-floor PCs keep signed in.
 * Employees are deliberately absent: they share the company account on the machine and then
 * identify themselves to the portal with their own password.
 */
var GOOGLE_GATE_DEFAULT_ACCOUNTS_ = [
  'admin.premierindia@gmail.com',
  'gaurav@punjabmachine.com',
  'kunal@punjabmachine.com'
];

function googleGateProp_(key) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (err) {
    return '';
  }
}

function googleGateAccounts_() {
  var list = googleGateProp_(GOOGLE_GATE_PROPS_.ACCOUNTS)
    .split(/[\s,;]+/)
    .map(function (a) { return String(a || '').trim().toLowerCase(); })
    .filter(Boolean);
  return list.length ? list : GOOGLE_GATE_DEFAULT_ACCOUNTS_.slice();
}

function googleGateEnforced_() {
  return googleGateProp_(GOOGLE_GATE_PROPS_.ENFORCED).toLowerCase() === 'on';
}

function googleGateClientId_() { return googleGateProp_(GOOGLE_GATE_PROPS_.CLIENT_ID); }
function googleGateClientSecret_() { return googleGateProp_(GOOGLE_GATE_PROPS_.CLIENT_SECRET); }

/** Configured means there is enough here to actually send somebody to Google and back. */
function googleGateConfigured_() {
  return !!googleGateClientId_() && !!googleGateClientSecret_();
}

/** The portal's own address, which is also the redirect Google must be told to come back to. */
function googleGateRedirectUri_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

/** Is this address one the office has named? Case and spacing are not the person's problem. */
function googleAccountAllowed_(email) {
  var want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  return googleGateAccounts_().indexOf(want) !== -1;
}

function googleGateCache_() { return CacheService.getScriptCache(); }

function randomGateToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// ------------------------------------------------------------------ the round trip

/**
 * Where to send the browser, and the one-time value that proves it came back from there.
 *
 * `state` is stored server-side and spent on return. Without it, anybody could hand a person
 * a crafted link that finished somebody else's half-started sign-in.
 */
function googleGateAuthUrl_() {
  var state = randomGateToken_();
  googleGateCache_().put('gstate:' + state, '1', GOOGLE_STATE_SECONDS_);
  var params = {
    client_id: googleGateClientId_(),
    redirect_uri: googleGateRedirectUri_(),
    response_type: 'code',
    scope: 'openid email',
    state: state,
    // Always ask which account, rather than silently using whichever Google remembers. On a
    // shared PC that is the difference between the company account and whoever used it last.
    prompt: 'select_account'
  };
  return GOOGLE_AUTH_URL_ + '?' + Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
}

/** The payload of an ID token. Read without verifying — see the caller for why that is safe. */
function decodeIdTokenPayload_(idToken) {
  var parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  try {
    var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString();
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

/**
 * Trades the code Google sent back for the address of whoever signed in.
 *
 * The exchange is server to server over TLS, carrying the client secret, and the answer comes
 * straight from Google — so the token's payload can be read without re-verifying its
 * signature. The issuer and audience are checked anyway: they cost nothing, and they are what
 * would catch a client id and secret that had been pointed at the wrong project.
 */
function googleGateExchangeCode_(code) {
  var res;
  try {
    res = UrlFetchApp.fetch(GOOGLE_TOKEN_URL_, {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        code: String(code || ''),
        client_id: googleGateClientId_(),
        client_secret: googleGateClientSecret_(),
        redirect_uri: googleGateRedirectUri_(),
        grant_type: 'authorization_code'
      }
    });
  } catch (err) {
    return { ok: false, email: '', reason: 'Could not reach Google to complete the sign-in.' };
  }
  if (res.getResponseCode() !== 200) {
    return { ok: false, email: '', reason: 'Google would not complete that sign-in. Try again.' };
  }

  var body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = null; }
  var claims = body && decodeIdTokenPayload_(body.id_token);
  if (!claims) {
    return { ok: false, email: '', reason: 'Google\'s answer could not be read.' };
  }
  if (GOOGLE_ISSUERS_.indexOf(String(claims.iss || '')) === -1) {
    return { ok: false, email: '', reason: 'That sign-in did not come from Google.' };
  }
  if (String(claims.aud || '') !== googleGateClientId_()) {
    return { ok: false, email: '', reason: 'That sign-in was issued for a different site.' };
  }
  if (String(claims.email_verified) !== 'true' && claims.email_verified !== true) {
    return { ok: false, email: '', reason: 'That Google account has no verified address.' };
  }
  return { ok: true, email: String(claims.email || '').trim().toLowerCase(), reason: '' };
}

/**
 * Handles `/exec?code=…&state=…`. Returns what doGet should do next:
 *   { pass: '…' }   signed in, hand this to the page
 *   { error: '…' }  turned away, show this
 */
function googleGateHandleCallback_(e) {
  var params = (e && e.parameter) || {};
  var state = String(params.state || '');
  var cache = googleGateCache_();

  if (!state || !cache.get('gstate:' + state)) {
    return { error: 'That sign-in link has expired or was not started here. Open the portal ' +
      'again and press the button.' };
  }
  cache.remove('gstate:' + state);

  if (params.error) {
    return { error: 'Google did not complete the sign-in (' + String(params.error) + ').' };
  }

  var got = googleGateExchangeCode_(params.code);
  if (!got.ok) return { error: got.reason };
  if (!googleAccountAllowed_(got.email)) {
    return { error: got.email + ' is not one of the accounts this portal is open to. Sign in ' +
      'with the company account, or ask the office to add yours.' };
  }

  var pass = randomGateToken_();
  cache.put('gpass:' + pass, got.email, GOOGLE_PASS_SECONDS_);
  return { pass: pass, email: got.email };
}

/** Whose pass this is, without spending it. A mistyped password must not cost a Google trip. */
function googleGatePassHolder_(pass) {
  if (!pass) return '';
  var email = googleGateCache_().get('gpass:' + String(pass));
  return email ? String(email).trim().toLowerCase() : '';
}

/**
 * Spends the pass, once the password has been accepted too.
 *
 * Held until then rather than taken at the door, because the two halves fail for different
 * reasons and only one of them is worth sending somebody back to Google over. Guessing is
 * already answered by the account lockout in Session.gs, so a pass that survives a wrong
 * password buys an attacker nothing it does not already have.
 */
function googleGateConsumePass_(pass) {
  if (pass) googleGateCache_().remove('gpass:' + String(pass));
}

// ------------------------------------------------------------------ what doGet asks

/**
 * Whether the page may be served at all, and what to serve instead when it may not.
 *
 * Returns { serve: true, pass } or { serve: false, html }.
 */
function googleGateForRequest_(e) {
  var params = (e && e.parameter) || {};

  // Coming back from Google, whether or not the requirement is switched on: somebody who
  // pressed the button deserves an answer. A bare `state` with nothing to exchange is not a
  // return — it is a stale bookmark, and it must not stand between anybody and the portal.
  if (params.code || params.error) {
    var back = googleGateHandleCallback_(e);
    if (back.error) return { serve: false, html: googleGateNoticePage_(back.error, true) };
    return { serve: true, pass: back.pass };
  }

  if (!googleGateEnforced_()) return { serve: true, pass: '' };

  if (!googleGateConfigured_()) {
    // Switched on with nothing to switch on with. Saying so beats an unexplained blank page.
    return { serve: false, html: googleGateNoticePage_(
      'This portal is set to require a Google sign-in but has not been given a Google client ' +
      'id and secret. Whoever administers it can finish that in the Apps Script editor, or ' +
      'switch the requirement off.', false) };
  }

  return { serve: false, html: googleGateSignInPage_() };
}

function gateEsc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var GATE_PAGE_CSS_ =
  'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f5f6f8;' +
  'color:#1c2430;margin:0;display:flex;min-height:100vh;align-items:center;' +
  'justify-content:center;padding:24px;}' +
  '.card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;max-width:460px;' +
  'padding:30px 32px;box-shadow:0 1px 3px rgba(0,0,0,.06);text-align:center;}' +
  'h1{font-size:17px;margin:0 0 10px;}' +
  'p{font-size:13.5px;line-height:1.55;margin:0 0 18px;color:#3d4753;}' +
  'a.btn{display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;' +
  'padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600;}';

/** One button, and nothing to type. A stranger with the link gets exactly this far. */
function googleGateSignInPage_() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + GATE_PAGE_CSS_ + '</style></head><body><div class="card">' +
    '<h1>Sign in with your company Google account</h1>' +
    '<p>This portal opens only from the Google accounts the office has approved. ' +
    'Your portal username and password come after this step.</p>' +
    // target="_top" because an Apps Script page is served inside an iframe, and Google will
    // not render its sign-in inside one.
    '<a class="btn" target="_top" href="' + gateEsc_(googleGateAuthUrl_()) +
    '">Continue with Google</a>' +
    '</div></body></html>')
    .setTitle('Sign in')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Anything that went wrong on the way back, said plainly, with a way to start again. */
function googleGateNoticePage_(message, offerRetry) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + GATE_PAGE_CSS_ + '</style></head><body><div class="card">' +
    '<h1>This account cannot open the portal</h1>' +
    '<p>' + gateEsc_(message) + '</p>' +
    (offerRetry && googleGateConfigured_()
      ? '<a class="btn" target="_top" href="' + gateEsc_(googleGateAuthUrl_()) +
        '">Try another account</a>'
      : '') +
    '</div></body></html>')
    .setTitle('Access restricted')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------------------------ what login asks

/**
 * The check that runs at sign-in. Returns the Google address to record on the session, or ''
 * when the requirement is off and there is nothing to record.
 */
function googleGateAtLogin_(pass) {
  var enforced = googleGateEnforced_();
  var email = googleGatePassHolder_(pass);

  if (!enforced) return email;   // recorded if offered, never demanded

  if (!email) {
    throw new Error('GOOGLE_ACCOUNT_BLOCKED: This portal opens only after a Google sign-in, ' +
      'and that step has expired. Reload the page and start again.');
  }
  if (!googleAccountAllowed_(email)) {
    throw new Error('GOOGLE_ACCOUNT_BLOCKED: ' + email + ' is not one of the accounts this ' +
      'portal is open to.');
  }
  return email;
}

/**
 * The check that runs on every later request, against what the session recorded.
 *
 * Re-reading the list rather than trusting the session outright is what makes removing an
 * account take effect on the next click. A session opened before the requirement was switched
 * on carries no address and is ended rather than grandfathered: the point of switching it on
 * is that the sessions already open are the ones you are unsure about.
 */
function assertSessionGoogleAccount_(session) {
  if (!googleGateEnforced_()) return;
  var email = String((session && session.googleEmail) || '').trim().toLowerCase();
  if (!email) {
    throw new Error('GOOGLE_ACCOUNT_BLOCKED: This portal now requires a Google sign-in. ' +
      'Reload the page and sign in again.');
  }
  if (!googleAccountAllowed_(email)) {
    throw new Error('GOOGLE_ACCOUNT_BLOCKED: ' + email + ' is no longer one of the accounts ' +
      'this portal is open to.');
  }
}

// ------------------------------------------------------------------ what Settings calls

/** Everything the System panel shows, and nothing a non-admin may ask for. */
function googleGateReport() {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);
  var configured = googleGateConfigured_();
  var enforced = googleGateEnforced_();
  return {
    enforced: enforced,
    clientId: googleGateClientId_(),
    hasSecret: !!googleGateClientSecret_(),
    redirectUri: googleGateRedirectUri_(),
    accounts: googleGateAccounts_(),
    signedInAs: String((user && user.googleEmail) || ''),
    ready: configured,
    advice: configured
      ? (enforced
          ? 'Only the accounts listed below can open this portal.'
          : 'The Google details are set, so the requirement is ready to switch on. Sign out ' +
            'and in again once first, so this session carries a Google account.')
      : 'In Google Cloud Console create an OAuth client of type "Web application", add the ' +
        'redirect address shown above to its authorised redirect URIs, and paste its client ' +
        'id and secret below. The requirement cannot be switched on until both are set.'
  };
}

/**
 * Sets the client details, the list of accounts, and whether the requirement is enforced.
 *
 * It refuses to switch on without the Google details, and refuses to switch on while the
 * person doing it is not themselves signed in through a listed account — both are ways to
 * lock the office out of its own portal in a single click.
 */
function setGoogleGate(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);
  var opts = input || {};
  var props = PropertiesService.getScriptProperties();

  if (opts.clientId !== undefined) {
    var clientId = String(opts.clientId || '').trim();
    if (clientId && clientId.indexOf('.apps.googleusercontent.com') === -1) {
      throw new Error('A Google client id ends in .apps.googleusercontent.com. That does not.');
    }
    props.setProperty(GOOGLE_GATE_PROPS_.CLIENT_ID, clientId);
  }

  // Blank means "leave it alone", so the screen can show that a secret exists without ever
  // sending it back to the browser to be echoed into a field.
  if (opts.clientSecret) {
    props.setProperty(GOOGLE_GATE_PROPS_.CLIENT_SECRET, String(opts.clientSecret).trim());
  }

  if (opts.accounts !== undefined) {
    var accounts = (Array.isArray(opts.accounts)
      ? opts.accounts
      : String(opts.accounts || '').split(/[\s,;]+/))
      .map(function (a) { return String(a || '').trim().toLowerCase(); })
      .filter(Boolean);
    accounts.forEach(function (a) {
      if (a.indexOf('@') === -1) throw new Error('"' + a + '" is not an email address.');
    });
    if (!accounts.length) {
      throw new Error('Name at least one Google account, or the requirement would admit ' +
        'nobody at all.');
    }
    props.setProperty(GOOGLE_GATE_PROPS_.ACCOUNTS, accounts.join(','));
  }

  if (opts.enforced !== undefined) {
    var on = opts.enforced === true || String(opts.enforced).toLowerCase() === 'true';
    if (on) {
      if (!googleGateConfigured_()) {
        throw new Error('Set the Google client id and secret first. Without them the portal ' +
          'cannot send anybody to Google, so nobody — you included — would be able to get in.');
      }
      var mine = String((user && user.googleEmail) || '').trim().toLowerCase();
      if (!mine) {
        throw new Error('Sign out and sign in again first, so this session carries a Google ' +
          'account. Switching the requirement on from a session that has none would end ' +
          'your own access on the next click.');
      }
      if (!googleAccountAllowed_(mine)) {
        throw new Error('The account you signed in with (' + mine + ') is not on the list, ' +
          'so switching the requirement on would shut you out. Add it first.');
      }
    }
    props.setProperty(GOOGLE_GATE_PROPS_.ENFORCED, on ? 'on' : 'off');
    audit_('Update', 'GoogleGate', '', 'enforced', on ? 'off' : 'on', on ? 'on' : 'off',
      on ? 'Google sign-in requirement switched on'
         : 'Google sign-in requirement switched off');
  }

  return googleGateReport();
}
