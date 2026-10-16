/**
 * The Google services the converted modules still call, answered by Node.
 *
 * Forty-two modules reach for `Utilities`, `CacheService`, `Session` and the rest at 96 call
 * sites. Each one is a decision, and the decisions fall into three kinds:
 *
 *   ANSWERED   — Utilities.computeDigest is a SHA-256 and Node has one; CacheService is a map
 *                with expiry times; Session.getScriptTimeZone is a setting. These are
 *                implemented properly and the modules cannot tell the difference.
 *
 *   NARROWED   — Utilities.formatDate accepts any Java date pattern. This code uses exactly
 *                two of them. Supporting two and throwing by name on a third is better than
 *                a half-built pattern engine that gets one wrong in a quarter's time.
 *
 *   REFUSED    — DriveApp, MailApp, HtmlService, SpreadsheetApp. A PDF on Drive and mail sent
 *                through the owner's Gmail quota are features, not plumbing, and each needs a
 *                real replacement chosen with PIE. Calling one throws and says so. A no-op
 *                would be worse than the error: a quotation that reports itself emailed and
 *                was not is a lost order nobody can explain.
 *
 * CACHING IS PER PROCESS, AND THAT IS A DOWNGRADE WORTH NAMING. Apps Script's script cache was
 * shared by every execution; a Node cache lives in one process, so with two processes behind a
 * load balancer each keeps its own. Everything cached here is advisory and short-lived — a
 * below-reorder count, a list of product groups, a two-minute dashboard — so the cost is a
 * recomputation, not a wrong answer. Sessions are the exception and they are read from the
 * database when the cache misses, which is exactly what the sheet version did.
 */
'use strict';

const crypto = require('crypto');

/** The timezone the sheet's dates were written in. Everything date-shaped depends on it. */
const TZ = process.env.ERP_TIMEZONE || 'Asia/Kolkata';

// ------------------------------------------------------------------ dates

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

/**
 * The three patterns this code actually uses, in the timezone it actually uses.
 *
 * Not a date library and not a pattern parser. `Utilities.formatDate` takes a Java format
 * string, of which the portal uses exactly three. They are found by parsing every call site
 * rather than by grep: the first version of this list said two, because the grep that built it
 * looked for patterns containing `yyyy` and missed the `yyMM` behind every enquiry number and
 * every lead number. The refusal below is what caught it, on the first test run after this
 * file existed, which is the argument for refusing rather than guessing.
 *
 * `yyMM` is the financial-year stamp in SE2610-001 and the compressor lead series. It is two
 * digits of year and two of month, with no separator, and it has to stay that way or every
 * number PIE has issued stops matching the pattern the next one is checked against.
 */
function formatDate(date, tz, pattern) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) throw new Error('formatDate was given something that is not a date.');
  const f = tz && tz !== TZ
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      })
    : PARTS;
  const p = {};
  f.formatToParts(d).forEach((part) => { p[part.type] = part.value; });
  // Intl gives midnight as '24' in some ICU versions; the date part is already the right day.
  const hour = p.hour === '24' ? '00' : p.hour;
  const day = p.year + '-' + p.month + '-' + p.day;
  if (pattern === 'yyyy-MM-dd') return day;
  if (pattern === 'yyyy-MM-dd HH:mm:ss') {
    return day + ' ' + hour + ':' + p.minute + ':' + p.second;
  }
  if (pattern === 'yyMM') return p.year.slice(2) + p.month;
  throw new Error('Utilities.formatDate pattern "' + pattern + '" is not implemented. ' +
    'The portal uses three and all three are; add this one to server/platform.js.');
}

/**
 * Apps Script hands digests back as SIGNED bytes, -128..127, and that is load-bearing.
 *
 * Every password and session token PIE has was derived through code written against that, and
 * Sha256.gs reproduces it byte for byte on purpose. A digest returned as 0..255 would hash to
 * a different string at the next step, and every existing password would stop matching with
 * nothing in the logs to say why. So the conversion is explicit in both directions and used on
 * the way in as well as out — a signed array handed back to computeDigest has to become bytes
 * again before Node will hash it.
 */
function toSigned(buf) {
  return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
}

function signedToBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(Array.from(value).map((b) => (b < 0 ? b + 256 : b)));
}

// ------------------------------------------------------------------ cache

/**
 * One cache, with expiry, per process.
 *
 * Apps Script put a 100 KB ceiling on a value and six hours on a lifetime, and the portal has
 * code that handles being refused — `try { cache.put(...) } catch (e) {}` in several places.
 * Keeping the ceiling means that code stays exercised rather than becoming a branch nobody
 * has run since the migration. The six-hour cap likewise: a caller asking for longer got
 * six hours on Apps Script, so it gets six hours here.
 */
const MAX_VALUE_BYTES = 100 * 1024;
const MAX_SECONDS = 6 * 3600;

class Cache {
  constructor() { this.store = new Map(); }

  get(key) {
    const hit = this.store.get(String(key));
    if (!hit) return null;
    if (hit.until <= Date.now()) { this.store.delete(String(key)); return null; }
    return hit.value;
  }

  put(key, value, seconds) {
    const v = String(value);
    if (Buffer.byteLength(v) > MAX_VALUE_BYTES) {
      throw new Error('Argument too large: value');          // the message Apps Script gives
    }
    const s = Math.min(Number(seconds) > 0 ? Number(seconds) : MAX_SECONDS, MAX_SECONDS);
    this.store.set(String(key), { value: v, until: Date.now() + s * 1000 });
  }

  remove(key) { this.store.delete(String(key)); }

  getAll(keys) {
    const out = {};
    (keys || []).forEach((k) => {
      const v = this.get(k);
      if (v !== null) out[k] = v;
    });
    return out;
  }

  putAll(values, seconds) {
    Object.keys(values || {}).forEach((k) => this.put(k, values[k], seconds));
  }

  removeAll(keys) { (keys || []).forEach((k) => this.remove(k)); }
}

// ------------------------------------------------------------------ refusals

/**
 * A service that has not been migrated, failing loudly at the exact call.
 *
 * Every property is a function that throws naming the service and what it was for, so the
 * stack points at the line in the module rather than at a mystery undefined.
 */
function notMigrated(name, why) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'toString' || prop === Symbol.toPrimitive) return () => name;
      return () => {
        throw new Error(name + '.' + String(prop) + ' is not available on the server. ' + why);
      };
    }
  });
}

// ------------------------------------------------------------------ the globals

/**
 * @param opts.properties  a plain object standing in for the script properties. Settings the
 *                         portal writes at runtime live here; on Apps Script they were a
 *                         key-value store attached to the project, and the server's own
 *                         equivalent is a table, which is a migration of its own. Passing an
 *                         object keeps that decision out of this file.
 */
function platformFor(opts) {
  const o = opts || {};
  const props = o.properties || {};
  const scriptCache = o.cache || new Cache();
  const userCaches = new Map();

  const propertyStore = {
    getProperty: (k) => (props.hasOwnProperty(k) ? String(props[k]) : null),
    setProperty: (k, v) => { props[k] = String(v); return propertyStore; },
    deleteProperty: (k) => { delete props[k]; return propertyStore; },
    getProperties: () => Object.assign({}, props),
    setProperties: (obj) => { Object.assign(props, obj || {}); return propertyStore; },
    getKeys: () => Object.keys(props)
  };

  return {
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      // Both directions go through the signed/unsigned conversion, because the thing being
      // encoded is almost always a digest and digests arrive signed.
      base64Encode: (s) => signedToBytes(s).toString('base64'),
      base64EncodeWebSafe: (s) => signedToBytes(s).toString('base64url'),
      base64Decode: (s) => toSigned(Buffer.from(String(s), 'base64')),
      base64DecodeWebSafe: (s) => toSigned(Buffer.from(String(s), 'base64url')),
      // Apps Script returns signed bytes, and Sha256.gs was written against that: a digest
      // whose bytes came back 0..255 would hash to a different hex string and every existing
      // password and session token would stop matching.
      computeDigest: (algorithm, value) => {
        const name = String(algorithm).toLowerCase().replace('-', '');
        if (name !== 'sha256') {
          throw new Error('Only SHA-256 is implemented; this asked for ' + algorithm + '.');
        }
        const input = typeof value === 'string' ? Buffer.from(value, 'utf8')
          : Buffer.from(signedToBytes(value));
        return toSigned(crypto.createHash('sha256').update(input).digest());
      },
      DigestAlgorithm: { SHA_256: 'SHA-256', SHA_1: 'SHA-1', MD5: 'MD5' },
      computeHmacSha256Signature: (value, key) => toSigned(
        crypto.createHmac('sha256', Buffer.from(signedToBytes(key)))
          .update(Buffer.from(signedToBytes(value))).digest()),
      newBlob: (data, contentType, name) => {
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
        return {
          getBytes: () => Array.from(buf),
          getDataAsString: () => buf.toString('utf8'),
          getContentType: () => contentType || 'application/octet-stream',
          getName: () => name || 'blob',
          setName: (n) => { name = n; return this; }
        };
      },
      sleep: (ms) => {
        // Synchronous on Apps Script, and the two callers use it to back off a retry. A busy
        // wait would block the event loop for the whole process, so it is refused rather than
        // faked: the caller should be awaiting a timer.
        throw new Error('Utilities.sleep(' + ms + ') would block the server. Await a timer.');
      }
    },

    CacheService: {
      getScriptCache: () => scriptCache,
      getUserCache: () => {
        // Per-user on Apps Script, and the dashboard relies on that: its two-minute cache is
        // keyed by role, so one shared map would serve a coordinator's dashboard to
        // Management. The actor is set per request, which is what keys this.
        const who = o.actor || 'anonymous';
        if (!userCaches.has(who)) userCaches.set(who, new Cache());
        return userCaches.get(who);
      },
      getDocumentCache: () => scriptCache
    },

    PropertiesService: {
      getScriptProperties: () => propertyStore,
      getUserProperties: () => propertyStore,
      getDocumentProperties: () => propertyStore
    },

    Session: {
      getScriptTimeZone: () => TZ,
      // Who is calling comes from the request now, not from Google. getCurrentUser() is the
      // portal's own function and is supplied per request; this is the Google identity, which
      // on the server there is none of.
      getActiveUser: () => ({ getEmail: () => o.actor || '' }),
      getEffectiveUser: () => ({ getEmail: () => o.actor || '' })
    },

    LockService: {
      // A transaction is the real lock now; see the note in shim.js.
      getScriptLock: () => ({
        waitLock: () => true, tryLock: () => true, releaseLock: () => {}, hasLock: () => true
      }),
      getUserLock: () => ({
        waitLock: () => true, tryLock: () => true, releaseLock: () => {}, hasLock: () => true
      })
    },

    Logger: {
      log: (...args) => { if (o.quiet !== true) console.log(...args); },
      getLog: () => ''
    },

    ScriptApp: {
      getService: () => ({ getUrl: () => o.baseUrl || '' }),
      // Scheduling belongs to the host now — a cron entry, not a project trigger. KeepWarm is
      // the only caller and the server has no cold start to keep warm, which is the whole
      // reason for the migration.
      getProjectTriggers: () => [],
      newTrigger: () => notMigrated('ScriptApp',
        'Scheduling is the host\'s job now — use a cron entry.').newTrigger(),
      deleteTrigger: () => {}
    },

    UrlFetchApp: {
      // Deliberately not shimmed with node-fetch here: the four callers post to Tally and to
      // Google's token endpoint, and each needs its timeouts and its error handling looked at
      // rather than inherited.
      fetch: () => notMigrated('UrlFetchApp',
        'Outbound HTTP needs its own review per caller — Tally and the OAuth token endpoint.')
        .fetch()
    },

    DriveApp: notMigrated('DriveApp',
      'Quotation PDFs and service reports need a file store chosen with PIE.'),
    MailApp: notMigrated('MailApp',
      'Sending mail needs a provider chosen with PIE — it ran on the owner\'s Gmail quota.'),
    GmailApp: notMigrated('GmailApp',
      'Sending mail needs a provider chosen with PIE — it ran on the owner\'s Gmail quota.'),
    HtmlService: notMigrated('HtmlService',
      'The browser is served by the web framework now, not by the script.'),
    SpreadsheetApp: notMigrated('SpreadsheetApp',
      'There is no spreadsheet. A module reaching for one has not been migrated — ' +
      'run `node migration/missing.js --sheet` for the list.'),
    ContentService: notMigrated('ContentService',
      'The web framework sets content types.')
  };
}

module.exports = { platformFor, formatDate, Cache, toSigned, signedToBytes, TZ };
