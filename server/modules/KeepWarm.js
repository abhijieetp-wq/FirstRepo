/**
 * Converted from src/KeepWarm.gs by migration/to-async.js.
 *
 * Only two things changed: functions that reach storage are `async`, and the calls that
 * reach it are `await`ed. Everything else — the logic, the names, the comments — is the
 * original, because the original is the specification and reformatting it would make the
 * diff unreadable at exactly the moment it needs to be read.
 *
 * Storage comes from server/shim.js, which keeps the old names (`readTable_`,
 * `appendRow_`) pointing at db.js. If this file is edited from here on, edit this one —
 * the .gs original stays frozen at the point of conversion so the live portal keeps running.
 */
/**
 * An experiment, not a feature.
 *
 * The first thing anybody does in the portal takes about fifteen seconds. Everything after
 * it is instant. That shape is not the data — three part searches in a row re-read the whole
 * catalogue, the whole price list and the whole stock ledger each time, and searches two and
 * three came back immediately. It is Apps Script waking up.
 *
 * What makes the experiment worth running here, rather than dismissing: the web app is
 * deployed `executeAs: USER_DEPLOYING`, so every request runs under one identity — the
 * owner's. A time-driven trigger runs under that same identity. If Google keeps anything
 * warm per identity and script, a trigger ticking over during office hours should land on
 * the same warm thing the next person to open the portal does.
 *
 * I do not know that it works. Apps Script makes no promise about instance reuse, and plenty
 * of advice on this is folklore. So this ships as something measurable rather than as a
 * claim: turn it on, leave it a day, and compare `bootstrap` in Settings → Speed against the
 * days before. If the median falls and the p95 falls with it, keep it. If not, remove the
 * trigger and we have ruled out the cheap answer and know the expensive one is needed.
 *
 * Cost if it does nothing: a few hundred trivial executions a day, well inside the free
 * quota, and one trigger to delete.
 */

/** Every five minutes is often enough to matter and rare enough to be free. */
var KEEP_WARM_MINUTES_ = 5;
var KEEP_WARM_FN_ = 'keepWarm';

/**
 * What the trigger runs. Deliberately almost nothing.
 *
 * It touches the spreadsheet because that is the connection a real request needs first, and
 * reads the smallest thing that proves the binding works. It writes nothing, and it is not
 * recorded by the timing — a few hundred synthetic calls a day would drown the figures this
 * exists to improve.
 *
 * It must never throw. A trigger that fails repeatedly gets disabled by Google and sends the
 * owner mail about it, which is a poor result for something whose whole purpose is to be
 * ignored.
 */
function keepWarm() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Users');
    if (sheet) sheet.getRange(1, 1).getValue();
  } catch (err) {
    try { console.warn('keepWarm skipped: ' + err.message); } catch (e2) { /* nothing */ }
  }
}

/** Is the trigger installed? */
function keepWarmInstalled_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === KEEP_WARM_FN_;
    });
  } catch (err) {
    return false;
  }
}

/**
 * Installs the trigger. Run once from the Apps Script editor.
 *
 * Removes any existing one first, so running it twice leaves one trigger rather than two.
 */
function installKeepWarm() {
  removeKeepWarm();
  ScriptApp.newTrigger(KEEP_WARM_FN_)
    .timeBased()
    .everyMinutes(KEEP_WARM_MINUTES_)
    .create();
  var msg = 'Keep-warm installed: ' + KEEP_WARM_FN_ + ' every ' + KEEP_WARM_MINUTES_ +
    ' minutes. Leave it a full working day, then compare bootstrap in Settings → Speed.';
  console.log(msg);
  return msg;
}

/** Takes it out again. Run from the editor; nothing else is left behind. */
function removeKeepWarm() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== KEEP_WARM_FN_) return;
    ScriptApp.deleteTrigger(t);
    removed++;
  });
  var msg = removed ? 'Keep-warm removed (' + removed + ' trigger(s)).'
                    : 'Keep-warm was not installed.';
  console.log(msg);
  return msg;
}
