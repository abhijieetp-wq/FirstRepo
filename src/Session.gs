/**
 * Signing in, without a Google account.
 *
 * PIE's staff have no company Google addresses, and their personal ones are not something the
 * business wants standing between an employee and the company's data. The deeper problem was
 * the deployment itself: running "as the user accessing" meant every person's Google account
 * had to hold access to the spreadsheet, so anyone could open it in Drive and read every
 * price, cost and credit limit with none of the role checks applying. The roles were enforced
 * by the application and the data sat behind it in the open.
 *
 * So the web app now runs as its owner. The spreadsheet is shared with nobody. Google no
 * longer knows who is calling — which is what this file replaces.
 *
 * The consequence to be clear-eyed about: the /exec address is reachable by anyone, and the
 * password is the whole boundary. That is why there is a per-user salt, a deliberately slow
 * derivation, a lockout, and why tokens are stored hashed — a copy of the sheet must not be a
 * set of working logins.
 *
 * That consequence is now optional. GoogleGate.gs can put a Google sign-in in front of this
 * screen — not as the identity, which is still the username and password below, but as a
 * lock on the door: only the office's own Google accounts get as far as being asked for a
 * password. It does that without undoing anything above. The app still runs as its owner and
 * the spreadsheet is still shared with nobody, because the account is proved by an OAuth
 * round trip rather than by handing the visitor the keys to the file.
 */

/** Cost of deriving a password. Stored per user, so it can be raised without locking anybody out. */
var PASSWORD_ITERATIONS = 4000;
/** How long a session lasts without being used again. */
var SESSION_HOURS = 12;
/** How many wrong guesses before the account rests, and for how long. */
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_LOCKOUT_MINUTES = 15;
/** Shortest password we will accept. Length beats cleverness. */
var PASSWORD_MIN_LENGTH = 8;

/**
 * The user this request is for, set by `call` before anything else runs.
 *
 * A script instance serves one request and is then discarded, so this cannot leak from one
 * caller to the next — the same property that makes the read cache in SheetService safe.
 */
var CURRENT_USER_ = null;

// ---------------------------------------------------------------- passwords

/** Random bytes, base64. Two UUIDs is 244 bits of randomness, which is ample for both uses. */
function randomToken_() {
  var seed = Utilities.getUuid() + Utilities.getUuid() + String(new Date().getTime());
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed));
}

/**
 * A base64 value, written so that Sheets keeps it as text.
 *
 * Sheets reads a cell beginning with =, + or - as a formula. Every security value here is
 * base64 — the session hash, the password hash, the salt — and base64 begins with + about one
 * time in sixty-four, at which point the cell was stored as #ERROR! and the value was gone.
 * A session hashed that way could never be matched again, so the person was signed out on
 * their very first click; a password hashed that way could never be matched either, and the
 * account was dead until an admin set a new one. Both had already happened in the live sheet.
 *
 * The marker makes the value start with a letter, which no spreadsheet reads as arithmetic.
 * Reads accept either form, so every value stored before this change keeps working.
 */
var TEXT_MARKER_ = 'b64.';

function asStoredText_(value) {
  var v = String(value === undefined || value === null ? '' : value);
  return v ? TEXT_MARKER_ + v : v;
}

/** The value back out, whether it was stored with the marker or before there was one. */
function fromStoredText_(value) {
  var v = String(value === undefined || value === null ? '' : value);
  return v.slice(0, TEXT_MARKER_.length) === TEXT_MARKER_ ? v.slice(TEXT_MARKER_.length) : v;
}

/**
 * Whether a stored security value survived the trip into the sheet.
 *
 * A cell Sheets turned into a formula reads back as an error string, and the value it held is
 * unrecoverable. Saying so plainly beats "that username and password do not match", which is
 * what the person was being told about a password they had typed correctly.
 */
function storedTextBroken_(value) {
  return String(value || '').indexOf('#') === 0;
}

/** A token as it is stored: hashed, so the sheet never holds anything replayable. */
function hashToken_(token) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
}

/**
 * Derives the stored form of a password.
 *
 * Repeated HMAC-SHA256 with a per-user salt: the salt means two people with the same password
 * store different values and one rainbow table cannot serve both, and the repetition means a
 * guess costs the attacker the same as it costs us. The count is stored alongside so it can
 * be raised later without invalidating every existing password.
 */
function derivePassword_(password, saltB64, iterations) {
  var salt = Utilities.base64Decode(fromStoredText_(saltB64));
  var out = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(String(password)).getBytes(), salt);
  for (var i = 1; i < iterations; i++) {
    out = Utilities.computeHmacSha256Signature(out, salt);
  }
  return Utilities.base64Encode(out);
}

/**
 * Compares two digests without giving away where they first differ.
 *
 * A comparison that stops at the first wrong byte takes longer the more of the prefix is
 * right, and that timing is enough to guess a value one byte at a time. This one always looks
 * at everything.
 */
function constantTimeEquals_(a, b) {
  var x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** What is wrong with a proposed password, or ''. */
function passwordComplaint_(password) {
  var p = String(password || '');
  if (p.length < PASSWORD_MIN_LENGTH) {
    return 'A password needs at least ' + PASSWORD_MIN_LENGTH + ' characters.';
  }
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
    return 'A password needs at least one letter and one number.';
  }
  return '';
}

/** Writes a new password onto a user row, clearing any lockout with it. */
function storePassword_(userRow, password, mustChange) {
  var complaint = passwordComplaint_(password);
  if (complaint) throw new Error(complaint);

  var salt = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid()));
  updateRowById_('Users', 'id', userRow.id, {
    passwordSalt: asStoredText_(salt),
    passwordHash: asStoredText_(derivePassword_(password, salt, PASSWORD_ITERATIONS)),
    passwordIterations: PASSWORD_ITERATIONS,
    passwordSetAt: new Date().toISOString(),
    mustChangePassword: mustChange ? 'TRUE' : 'FALSE',
    failedAttempts: 0,
    lockedUntil: ''
  }, 'Password set');
}

// ---------------------------------------------------------------- signing in

/** The Users row for an address, or null. Case-insensitive, because people type as they like. */
function userRowByEmail_(email) {
  var wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  return readTable_('Users').filter(function (u) {
    return String(u.email).trim().toLowerCase() === wanted;
  })[0] || null;
}

/**
 * The Users row for whatever somebody typed into the sign-in box.
 *
 * A username, because PIE's staff have no company addresses and asking for a personal one
 * reads as though the portal wants it. The email is still accepted: nobody who learnt to
 * sign in one way should be turned away for it, and during the changeover both are in use.
 */
function userRowByLogin_(login) {
  var wanted = String(login || '').trim().toLowerCase();
  if (!wanted) return null;
  var users = readTable_('Users');
  return users.filter(function (u) {
    return String(u.username).trim().toLowerCase() === wanted;
  })[0] || users.filter(function (u) {
    return String(u.email).trim().toLowerCase() === wanted;
  })[0] || null;
}

/**
 * A username from a name or an address, for a row that predates this field.
 *
 * Derived rather than demanded, so the change does not begin by locking everybody out of a
 * system they were using yesterday.
 */
function derivedUsername_(row) {
  var fromEmail = String(row.email || '').split('@')[0];
  var base = (fromEmail || String(row.name || '')).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return base || String(row.id || '').toLowerCase();
}

/**
 * The nearest free username to the one asked for.
 *
 * A second Arun should get an account, not an error message — the derivation is a
 * convenience, and a convenience that refuses is worse than none. A username somebody typed
 * on purpose is a different matter and is refused on a clash, because silently signing them
 * in as arun2 would be worse than telling them.
 */
function freeUsername_(base, exceptUserId) {
  var taken = {};
  readTable_('Users').forEach(function (u) {
    if (String(u.id) === String(exceptUserId || '')) return;
    var name = String(u.username || '').trim().toLowerCase();
    if (name) taken[name] = true;
  });
  var candidate = String(base || 'user');
  var n = 2;
  while (taken[candidate.toLowerCase()]) { candidate = base + n; n++; }
  return candidate;
}

/**
 * Gives a username to every row that has none, once.
 *
 * Run from the build hook rather than asked of an admin, because the alternative is a portal
 * where the sign-in box asks for something nobody has been given yet. Derived from the address
 * they already signed in with, so it is a name they will recognise. A row that already has one
 * is never touched, and a derivation that collides gets a number, because two people signing
 * in as the same thing is the one outcome worse than an awkward username.
 */
function backfillUsernames_() {
  var filled = 0;
  readTable_('Users').forEach(function (u) {
    if (String(u.username || '').trim()) return;
    var candidate = freeUsername_(derivedUsername_(u), u.id);
    updateRowById_('Users', 'id', u.id, { username: candidate },
      'Username filled in from ' + (u.email || u.name));
    filled++;
  });
  return filled;
}

/** What is wrong with a proposed username, or ''. */
function usernameComplaint_(username, exceptUserId) {
  var name = String(username || '').trim();
  if (!name) return 'Enter a username — it is what they will sign in with.';
  if (name.indexOf('@') !== -1) return 'A username is not an email address.';
  if (name.length < 3) return 'A username needs at least three characters.';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return 'A username can use letters, numbers, dots, dashes and underscores — nothing else.';
  }

  var clash = readTable_('Users').filter(function (u) {
    return String(u.id) !== String(exceptUserId || '') &&
      String(u.username).trim().toLowerCase() === name.toLowerCase();
  })[0];
  if (clash) return 'Somebody already signs in as ' + name + ' (' + clash.name + ').';
  return '';
}

/**
 * Exchanges a username and password for a session token.
 *
 * Called directly rather than through `call`, because there is no session yet. Every failure
 * says the same thing: naming which half was wrong tells somebody which addresses are real.
 */
function login(login, password, googlePass) {
  // Which Google account the browser is signed in as, checked before any password work is
  // done. It throws when the account may not be here, so a stranger with the link never gets
  // as far as finding out whether a username exists.
  var googleEmail = googleGateAtLogin_(googlePass);

  var vague = 'That username and password do not match.';
  var row = userRowByLogin_(login);

  // Still derive on a missing user, so a wrong username does not answer faster than a wrong
  // password and become a way to enumerate who works here.
  if (!row) {
    derivePassword_(String(password || ''), Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'absent')),
      PASSWORD_ITERATIONS);
    throw new Error(vague);
  }

  if (String(row.active).toUpperCase() === 'FALSE') {
    throw new Error('That account has been deactivated. Ask your ERP Admin.');
  }

  var now = new Date();
  if (row.lockedUntil && new Date(row.lockedUntil) > now) {
    var mins = Math.ceil((new Date(row.lockedUntil) - now) / 60000);
    throw new Error('Too many attempts. Try again in ' + mins +
      (mins === 1 ? ' minute' : ' minutes') + ', or ask your ERP Admin to reset it.');
  }

  if (!row.passwordHash) {
    throw new Error('No password has been set for this account yet. Ask your ERP Admin.');
  }
  // A password the sheet destroyed on the way in can never match, however carefully it is
  // typed. Say that, rather than letting somebody try their own password five times and lock
  // themselves out of an account that was already unusable.
  if (storedTextBroken_(row.passwordHash) || storedTextBroken_(row.passwordSalt)) {
    throw new Error('This account\'s password was not stored correctly and has to be set ' +
      'again. Ask your ERP Admin to set you a new one.');
  }

  var iterations = Number(row.passwordIterations) || PASSWORD_ITERATIONS;
  var offered = derivePassword_(String(password || ''), row.passwordSalt, iterations);
  if (!constantTimeEquals_(offered, fromStoredText_(row.passwordHash))) {
    var failed = (Number(row.failedAttempts) || 0) + 1;
    var patch = { failedAttempts: failed };
    if (failed >= LOGIN_MAX_ATTEMPTS) {
      patch.lockedUntil =
        new Date(now.getTime() + LOGIN_LOCKOUT_MINUTES * 60000).toISOString();
      patch.failedAttempts = 0;
    }
    updateRowById_('Users', 'id', row.id, patch, 'Failed sign-in');
    throw new Error(vague);
  }

  if (Number(row.failedAttempts) || row.lockedUntil) {
    updateRowById_('Users', 'id', row.id, { failedAttempts: 0, lockedUntil: '' },
      'Signed in after failed attempts');
  }

  var token = randomToken_();
  appendRow_('Sessions', {
    id: generateId_('SES-'),
    tokenHash: asStoredText_(hashToken_(token)),
    userEmail: row.email,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600000).toISOString(),
    lastSeenAt: now.toISOString(),
    revokedAt: '',
    // Which Google account opened this session. Re-checked against the list on every later
    // request, so taking an account off the list ends its access on the next click rather
    // than the next sign-in.
    googleEmail: googleEmail
  }, 'Signed in');

  // The Google half is finished with now, and not before: a wrong password must not cost
  // somebody the trip out to Google and back.
  googleGateConsumePass_(googlePass);

  var user = userFromRow_(row);
  user.googleEmail = googleEmail;
  user.mustChangePassword = String(row.mustChangePassword).toUpperCase() === 'TRUE';
  return { token: token, user: user };
}

/** Ends this session. Idempotent: signing out of something already gone is not an error. */
function logout(token) {
  var hash = hashToken_(token);
  CacheService.getScriptCache().remove('sess:' + hash);
  var row = readTable_('Sessions').filter(function (s) {
    return fromStoredText_(s.tokenHash) === hash && !s.revokedAt;
  })[0];
  if (row) {
    updateRowById_('Sessions', 'id', row.id, { revokedAt: new Date().toISOString() },
      'Signed out');
  }
  return { ok: true };
}

/**
 * The user behind a token, or null.
 *
 * Cached for the life of the token so that validating one does not cost a read of the
 * Sessions tab on every single call — the round trips removed from the rest of the system
 * should not come back in through the front door. The cache holds the user, so deactivating
 * somebody takes effect when their cache entry lapses or their session is revoked; both are
 * cleared explicitly where that matters.
 */
function userForToken_(token) {
  if (!token) return null;
  var hash = hashToken_(token);
  var cache = CacheService.getScriptCache();
  var cached = cache.get('sess:' + hash);
  if (cached) {
    try { return JSON.parse(cached); } catch (err) { /* fall through and re-read */ }
  }

  var session = readTable_('Sessions').filter(function (s) {
    return fromStoredText_(s.tokenHash) === hash;
  })[0];
  if (!session || session.revokedAt) return null;
  if (new Date(session.expiresAt) <= new Date()) return null;

  var row = userRowByEmail_(session.userEmail);
  if (!row || String(row.active).toUpperCase() === 'FALSE') return null;

  var user = userFromRow_(row);
  // Which Google account opened the session travels with the user, because the gate is
  // re-checked on every request and the browser cannot be asked again mid-session.
  user.googleEmail = String(session.googleEmail || '').trim().toLowerCase();
  // Six hours is the longest the cache will hold anything, and a session lasts twelve.
  cache.put('sess:' + hash, JSON.stringify(user), 6 * 3600);
  return user;
}

/** Clears every cached session for one address, so a role or password change takes hold. */
function forgetSessionsFor_(email) {
  var wanted = String(email || '').toLowerCase();
  var cache = CacheService.getScriptCache();
  var now = new Date().toISOString();
  readTable_('Sessions').forEach(function (s) {
    if (String(s.userEmail).toLowerCase() !== wanted || s.revokedAt) return;
    cache.remove('sess:' + fromStoredText_(s.tokenHash));
    updateRowById_('Sessions', 'id', s.id, { revokedAt: now }, 'Session ended');
  });
}

// ---------------------------------------------------------------- the one door in

/**
 * Every call from the browser arrives here.
 *
 * Google used to say who was calling; now the token does, and a token has to travel with each
 * request because a script instance remembers nothing between them. Routing everything
 * through one function is what keeps that from meaning a change to all hundred and seventy
 * call sites — the client's shim passes the token, and the functions themselves are untouched.
 *
 * What may be called is the same surface as before: any global that is not private. A name
 * ending in an underscore is internal by this codebase's convention, and the auth functions
 * are named here so a token cannot be used to mint another.
 */
var CALL_DENY_ = ['call', 'doGet', 'include', 'login', 'logout',
  // The editor-only doors. Their authority is that Google checked who opened the editor, so
  // reaching them from the web app would be handing that authority to anybody with the URL.
  'setInitialAdminPassword', 'createSignInPasswords', 'resetAllSignInPasswords'];

function call(token, fnName, args) {
  var user = userForToken_(token);
  if (!user) throw new Error('SESSION_ENDED');
  // The session remembers which Google account opened it; the list is read again here. A tab
  // that was already open when the requirement was switched on, or an account taken off the
  // list an hour ago, is stopped at the next click rather than the next sign-in.
  assertSessionGoogleAccount_(user);
  CURRENT_USER_ = user;

  var name = String(fnName || '');
  if (!name || name.slice(-1) === '_' || CALL_DENY_.indexOf(name) !== -1) {
    throw new Error('Unknown action: ' + name);
  }
  var fn = this[name];
  if (typeof fn !== 'function') throw new Error('Unknown action: ' + name);

  return fn.apply(null, args || []);
}

/**
 * A password somebody can read over the phone.
 *
 * Three short pieces and a number: long enough to be worth something, plain enough to dictate
 * without spelling out. The alphabet leaves out every character that is argued about out loud
 * — no O or 0, no l or 1 or I — because the first thing that happens to one of these is that
 * it gets read to somebody.
 *
 * It is a way in, not a password: whoever receives it must choose their own before anything
 * else opens.
 */
var PASSWORD_WORDS_ = ['amber', 'anvil', 'basalt', 'cedar', 'copper', 'delta', 'ember',
  'falcon', 'garnet', 'harbour', 'indigo', 'jasper', 'kettle', 'lantern', 'marble', 'nutmeg',
  'quartz', 'rattan', 'saffron', 'teak', 'umber', 'velvet', 'walnut', 'yarrow', 'zephyr'];

function readablePassword_() {
  var pick = function (list) {
    return list[Math.floor(Math.random() * list.length)];
  };
  // The tail is where ambiguity bites: a stray character carries no meaning to correct a
  // mishearing, so i, l and o go, and 0 and 1 with them. The words keep theirs — "basalt"
  // read aloud is not in doubt because it is a word.
  var letters = 'abcdefghjkmnpqrstuvwxyz'.split('');
  var digits = '23456789'.split('');
  // "anvil-anvil" is as random as any other pair and reads like a mistake, which is enough
  // reason for somebody to ring up and check before using it.
  var first = pick(PASSWORD_WORDS_);
  var second = pick(PASSWORD_WORDS_);
  while (second === first) second = pick(PASSWORD_WORDS_);
  return first + '-' + second + '-' +
    pick(letters) + pick(digits) + pick(digits) + pick(digits);
}

/**
 * Gives a password to everybody who has none, and prints them. Run from the editor.
 *
 * There has to be one way in that does not itself need a password, or a new installation has
 * nobody who can create one. Running a function from the editor requires being the script's
 * owner, which Google has already checked — that is the whole of this function's authority,
 * and it is on the deny-list above so the web app cannot reach it.
 *
 * It takes no arguments because the editor's Run button cannot pass any, and it invents the
 * passwords rather than accepting them so that none is ever typed into a file that gets
 * committed. They are printed once, to the execution log, which only the owner can see.
 */
function createSignInPasswords() {
  var made = [];
  readTable_('Users').forEach(function (row) {
    if (String(row.active).toUpperCase() === 'FALSE') return;
    if (row.passwordHash) return;
    var password = readablePassword_();
    storePassword_(row, password, true);
    made.push({ login: loginNameFor_(row), name: row.name, role: row.role,
                password: password });
  });

  if (!made.length) {
    return 'Everybody active already has a password. To replace one, use Settings → Users → ' +
      'Set password inside the portal, or resetAllSignInPasswords() if nobody can get in.';
  }
  return describePasswords_(made);
}

/**
 * Replaces everybody's password. The way back in when nobody can get in.
 *
 * Blunt on purpose: it exists for the case where the only admin has forgotten theirs, and in
 * that situation a precise tool is one that needs somebody already inside to aim it.
 */
function resetAllSignInPasswords() {
  var made = [];
  readTable_('Users').forEach(function (row) {
    if (String(row.active).toUpperCase() === 'FALSE') return;
    var password = readablePassword_();
    storePassword_(row, password, true);
    forgetSessionsFor_(row.email);
    made.push({ login: loginNameFor_(row), name: row.name, role: row.role,
                password: password });
  });
  if (!made.length) return 'There are no active users in the Users tab.';
  return describePasswords_(made);
}

/** What this person types to sign in — their username, or the address if they have none yet. */
function loginNameFor_(row) {
  return String(row.username || '').trim() || derivedUsername_(row) || String(row.email || '');
}

/**
 * Lays the new passwords out so they can be read off and handed over.
 *
 * Keyed by what the person actually types at the sign-in box, not by their email address —
 * reading out an address they do not use would be handing them the wrong half of the answer.
 */
function describePasswords_(made) {
  var width = 0;
  made.forEach(function (m) { width = Math.max(width, String(m.login).length); });
  var lines = made.map(function (m) {
    var pad = new Array(width - String(m.login).length + 3).join(' ');
    return '  ' + m.login + pad + m.password + '   (' + m.name + ', ' + m.role + ')';
  });
  var text = made.length + (made.length === 1 ? ' password set:' : ' passwords set:') + '\n\n' +
    lines.join('\n') +
    '\n\nGive each person their own. Every one has to be changed the first time it is used, ' +
    'so none of these stays in service. They are shown here once and nowhere else — nothing ' +
    'stores a password in a form anybody can read back, including this function.';
  // Logged as well as returned: the return value of a long list is awkward to read in the
  // dialog the editor shows, and the log holds it until it is needed.
  Logger.log(text);
  return text;
}

/**
 * Sets one known password for one person, for anybody driving the script from outside the
 * editor — clasp, or a test. The editor's Run button cannot reach it usefully, which is what
 * createSignInPasswords() above exists for.
 */
function setInitialAdminPassword(email, password) {
  var row = userRowByEmail_(email);
  if (!row) throw new Error('No user with the address ' + email + ' in the Users tab.');
  storePassword_(row, password, true);
  forgetSessionsFor_(row.email);
  return 'Password set for ' + row.email + '. They must change it when they first sign in.';
}
