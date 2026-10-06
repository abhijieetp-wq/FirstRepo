/**
 * Where the seconds actually go.
 *
 * PIE say the portal is slow and they are right, but "slow" is not a thing you can fix —
 * every guess about which part is slow has an equally plausible rival, and the cost of acting
 * on the wrong one is a week spent making something faster that nobody was waiting on. So
 * this measures: for every server call, how long it took, how many tabs it read and how many
 * rows came back with them.
 *
 * It has to be nearly free or it becomes the thing it is measuring. Two decisions follow from
 * that. It is off unless somebody turns it on, so the ordinary day costs nothing at all. And
 * when it is on, records go into the script cache and reach the sheet in batches of fifty —
 * a write per call would have added a round trip to every single request, which on this
 * platform is most of what a request costs, and the measurement would have been of itself.
 *
 * Nothing here may break a call. Every entry point is wrapped: a portal that falls over
 * because its stopwatch failed would be a poor trade for knowing how fast it was.
 */

var TELEMETRY_PROP_ = 'TELEMETRY';
var TELEMETRY_BATCH_ = 50;
var TELEMETRY_CACHE_KEY_ = 'telemetry:buffer';
/** Six hours is the longest the cache will hold anything. */
var TELEMETRY_CACHE_TTL_ = 6 * 3600;

/** Counters for the request being served, reset when it starts. */
var TELEMETRY_TABS_ = {};
var TELEMETRY_ROWS_ = 0;

function telemetryOn_() {
  try {
    return String(PropertiesService.getScriptProperties()
      .getProperty(TELEMETRY_PROP_) || '').toLowerCase() === 'on';
  } catch (err) {
    return false;
  }
}

/** Starts the counters for one request. */
function telemetryBegin_() {
  TELEMETRY_TABS_ = {};
  TELEMETRY_ROWS_ = 0;
}

/**
 * One tab read, and how much came back.
 *
 * Called from readTable_, which is the single place this application gets data from — so a
 * count here is a count of everything, and a screen that reads the same tab twice shows up as
 * one tab and one set of rows, because the second read was served from the request cache and
 * cost nothing.
 */
function telemetryRead_(sheetName, rowCount) {
  if (!TELEMETRY_TABS_) return;
  if (TELEMETRY_TABS_[sheetName]) return;      // already counted this request
  TELEMETRY_TABS_[sheetName] = rowCount;
  TELEMETRY_ROWS_ += rowCount;
}

/** How many distinct tabs this request has read. */
function telemetryTabCount_() {
  return Object.keys(TELEMETRY_TABS_ || {}).length;
}

/**
 * The widest tab this request touched, which is usually the answer.
 *
 * A call reading eight small tabs and a call reading one tab of forty thousand rows have the
 * same tab count and completely different problems. The biggest single read names the second
 * kind without needing the whole breakdown stored against every row.
 */
function telemetryWidest_() {
  var name = '', rows = 0;
  Object.keys(TELEMETRY_TABS_ || {}).forEach(function (t) {
    if (TELEMETRY_TABS_[t] > rows) { rows = TELEMETRY_TABS_[t]; name = t; }
  });
  return name ? name + ':' + rows : '';
}

function telemetryCache_() { return CacheService.getScriptCache(); }

/**
 * Who is making the call, without assuming the module that holds that is loaded.
 *
 * CURRENT_USER_ lives in Session.gs. Naming it bare made this file depend on another one
 * having been evaluated first — true in the deployed app, where every .gs shares one scope,
 * and not true of anything that loads a subset. The guard below swallowed the resulting
 * ReferenceError exactly as designed, which meant the measurement quietly recorded nothing and
 * said nothing about why. A stopwatch with a silent failure mode is worse than no stopwatch.
 */
function telemetryWho_() {
  try {
    if (typeof CURRENT_USER_ === 'undefined' || !CURRENT_USER_) return '';
    return String(CURRENT_USER_.email || '');
  } catch (err) {
    return '';
  }
}

/**
 * Records one finished call and flushes when the batch is full.
 *
 * Read-modify-write on a shared cache key, so two calls landing together can lose one of
 * them. Deliberately not locked: this is a sample, not a ledger, and taking a lock on every
 * request to count requests would be a worse bargain than missing one in a hundred.
 */
function telemetryRecord_(fnName, ms, errorText) {
  try {
    var cache = telemetryCache_();
    var raw = cache.get(TELEMETRY_CACHE_KEY_);
    var buffer = raw ? JSON.parse(raw) : [];
    buffer.push({
      at: new Date().toISOString(),
      email: telemetryWho_(),
      fn: String(fnName || ''),
      ms: Math.round(ms),
      tabs: telemetryTabCount_(),
      rows: TELEMETRY_ROWS_,
      widest: telemetryWidest_(),
      error: String(errorText || '').slice(0, 120)
    });
    if (buffer.length >= TELEMETRY_BATCH_) {
      cache.remove(TELEMETRY_CACHE_KEY_);
      telemetryFlush_(buffer);
      return;
    }
    cache.put(TELEMETRY_CACHE_KEY_, JSON.stringify(buffer), TELEMETRY_CACHE_TTL_);
  } catch (err) {
    // A stopwatch that throws must not take the call down with it.
    try { console.warn('Telemetry skipped: ' + err.message); } catch (e2) { /* nothing */ }
  }
}

/** Writes a batch to the Telemetry tab in one append. */
function telemetryFlush_(buffer) {
  if (!buffer || !buffer.length) return;
  var rows = buffer.map(function (r) {
    return {
      id: generateId_('TLM-'),
      at: r.at,
      userEmail: r.email,
      fn: r.fn,
      ms: r.ms,
      tabsRead: r.tabs,
      rowsRead: r.rows,
      widestRead: r.widest,
      error: r.error
    };
  });
  appendRows_('Telemetry', rows, 'Timings for ' + rows.length + ' calls');
}

/**
 * Times one call. Returns whatever the call returned, and re-throws whatever it threw.
 *
 * The failure path is measured too, and on purpose: a call that takes four seconds to fail is
 * worth knowing about, and a timing set that quietly contains only the successes describes a
 * portal nobody is using.
 */
function telemetryWrap_(fnName, run) {
  if (!telemetryOn_()) return run();
  telemetryBegin_();
  var started = Date.now();
  var out;
  try {
    out = run();
  } catch (err) {
    telemetryRecord_(fnName, Date.now() - started, err && err.message);
    throw err;
  }
  telemetryRecord_(fnName, Date.now() - started, '');
  return out;
}

// ------------------------------------------------------------------ what Settings calls

var TELEMETRY_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Turns measuring on or off, and says what it did. */
function setTelemetry(on) {
  var user = getCurrentUser();
  requireRole_(user, TELEMETRY_ROLES);
  var want = on ? 'on' : 'off';
  PropertiesService.getScriptProperties().setProperty(TELEMETRY_PROP_, want);
  audit_('SETTING', 'Telemetry', 'TELEMETRY', 'state', want === 'on' ? 'off' : 'on', want,
    'Timing ' + (want === 'on' ? 'started' : 'stopped') + ' by ' + user.email);
  return getTelemetryReport();
}

/** Writes out whatever is still buffered, so a report does not wait for the fiftieth call. */
function flushTelemetry() {
  var user = getCurrentUser();
  requireRole_(user, TELEMETRY_ROLES);
  try {
    var cache = telemetryCache_();
    var raw = cache.get(TELEMETRY_CACHE_KEY_);
    if (raw) {
      cache.remove(TELEMETRY_CACHE_KEY_);
      telemetryFlush_(JSON.parse(raw));
    }
  } catch (err) { /* nothing buffered, or it expired */ }
  return getTelemetryReport();
}

/** The nth percentile of a sorted list, nearest-rank. */
function telemetryPercentile_(sorted, p) {
  if (!sorted.length) return 0;
  var i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
}

/**
 * What the timings say, per function.
 *
 * Sorted by total time rather than by the worst single call, because the thing to fix is
 * whatever the office spends its day waiting on. A four-second report run twice a week
 * matters less than a four-hundred-millisecond search run two thousand times, and sorting by
 * the maximum puts them the wrong way round.
 *
 * p95 alongside the median because an average hides the shape: a call that is usually quick
 * and occasionally terrible is a different problem from one that is evenly slow, and only the
 * first is likely to be a cold start.
 */
function getTelemetryReport() {
  var user = getCurrentUser();
  requireRole_(user, TELEMETRY_ROLES);

  var rows = [];
  try { rows = readTable_('Telemetry'); } catch (err) { rows = []; }

  var byFn = {};
  rows.forEach(function (r) {
    var key = String(r.fn || '(unknown)');
    if (!byFn[key]) byFn[key] = { fn: key, calls: 0, times: [], rows: 0, tabs: 0,
      errors: 0, widest: '', widestRows: 0 };
    var e = byFn[key];
    e.calls++;
    e.times.push(Number(r.ms) || 0);
    e.rows += Number(r.rowsRead) || 0;
    e.tabs += Number(r.tabsRead) || 0;
    if (String(r.error || '').trim()) e.errors++;
    var w = String(r.widestRead || '');
    var n = Number(w.split(':')[1]) || 0;
    if (n > e.widestRows) { e.widestRows = n; e.widest = w; }
  });

  var out = Object.keys(byFn).map(function (k) {
    var e = byFn[k];
    var sorted = e.times.slice().sort(function (a, b) { return a - b; });
    var total = sorted.reduce(function (s, n) { return s + n; }, 0);
    return {
      fn: e.fn,
      calls: e.calls,
      totalMs: total,
      medianMs: telemetryPercentile_(sorted, 50),
      p95Ms: telemetryPercentile_(sorted, 95),
      maxMs: sorted[sorted.length - 1] || 0,
      avgTabs: Math.round((e.tabs / e.calls) * 10) / 10,
      avgRows: Math.round(e.rows / e.calls),
      widest: e.widest,
      errors: e.errors
    };
  }).sort(function (a, b) { return b.totalMs - a.totalMs; });

  var allTimes = rows.map(function (r) { return Number(r.ms) || 0; })
    .sort(function (a, b) { return a - b; });

  return {
    on: telemetryOn_(),
    samples: rows.length,
    from: rows.length ? String(rows[0].at || '').slice(0, 16).replace('T', ' ') : '',
    to: rows.length ? String(rows[rows.length - 1].at || '').slice(0, 16).replace('T', ' ') : '',
    overallMedianMs: telemetryPercentile_(allTimes, 50),
    overallP95Ms: telemetryPercentile_(allTimes, 95),
    functions: out
  };
}

/** Empties the Telemetry tab, for starting a fresh measurement after a change. */
function clearTelemetry() {
  var user = getCurrentUser();
  requireRole_(user, TELEMETRY_ROLES);
  deleteRowsWhere_('Telemetry', function () { return true; }, 'Timings cleared by ' + user.email);
  try { telemetryCache_().remove(TELEMETRY_CACHE_KEY_); } catch (err) { /* nothing held */ }
  return getTelemetryReport();
}
