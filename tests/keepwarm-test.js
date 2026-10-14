/**
 * The keep-warm experiment: it installs cleanly, comes out cleanly, and cannot fail loudly.
 *
 * None of this proves the experiment works — only a day of real timings can say that. What
 * it checks is that the thing we are about to leave running in a client's live project is
 * safe to leave running, and safe to remove.
 */
const { load, reset, checks } = require('./harness');

const MODULES = ['Auth.gs', 'Schema.gs', 'SheetService.gs', 'StreamAccess.gs', 'SalesPolicy.gs',
  'Pricing.gs', 'Stock.gs', 'KeepWarm.gs', 'Telemetry.gs'];

const t = checks();

console.log('IT INSTALLS, AND INSTALLING TWICE LEAVES ONE');
let sb = load(MODULES);
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};

t.ok('nothing installed to begin with', sb.keepWarmInstalled_() === false);
sb.installKeepWarm();
t.ok('one trigger after installing', sb.__triggers.length === 1, sb.__triggers.length);
t.ok('and it knows it', sb.keepWarmInstalled_() === true);
t.ok('firing every five minutes', sb.__triggers[0].minutes === 5, sb.__triggers[0].minutes);

// Running the installer again is the likeliest human error — a second press, a second
// session. Two triggers would double the executions and neither would be findable by name.
sb.installKeepWarm();
t.ok('installing again still leaves one', sb.__triggers.length === 1, sb.__triggers.length);

console.log('\nAND IT COMES OUT AGAIN');
let msg = sb.removeKeepWarm();
t.ok('the trigger is gone', sb.__triggers.length === 0, sb.__triggers.length);
t.ok('it reports itself off', sb.keepWarmInstalled_() === false);
t.ok('and says what it did', /removed/i.test(msg), msg);
msg = sb.removeKeepWarm();
t.ok('removing nothing is not an error', /not installed/i.test(msg), msg);

// Other triggers belong to other features. A keep-warm cleanup that took them with it would
// be a quiet way to switch off something nobody was thinking about.
sb.ScriptApp.newTrigger('someOtherJob').timeBased().everyMinutes(30).create();
sb.installKeepWarm();
t.ok('an unrelated trigger survives installing', sb.__triggers.length === 2, sb.__triggers.length);
sb.removeKeepWarm();
t.ok('and survives removing', sb.__triggers.length === 1, sb.__triggers.length);
t.ok('the right one was left', sb.__triggers[0].getHandlerFunction() === 'someOtherJob',
  sb.__triggers[0].getHandlerFunction());

console.log('\nIT CANNOT FAIL LOUDLY');
sb = load(MODULES);
reset(sb);
// A trigger that throws repeatedly gets disabled by Google and mails the owner about it.
// For something whose entire purpose is to be ignored, that is the worst outcome available.
sb.SpreadsheetApp = {
  getActiveSpreadsheet: () => { throw new Error('sheet unavailable'); }
};
t.ok('a broken sheet does not throw', t.threw(() => sb.keepWarm()) === null);

sb = load(MODULES);
reset(sb);
t.ok('and the ordinary case does not either', t.threw(() => sb.keepWarm()) === null);

console.log('\nTHE REPORT SAYS WHICH EXPERIMENT THE NUMBERS BELONG TO');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
// Comparing one week against another is worthless if you cannot tell what was switched on
// during each of them.
t.ok('off, when it is off', sb.getTelemetryReport().keepWarm === false);
sb.installKeepWarm();
t.ok('and on, when it is on', sb.getTelemetryReport().keepWarm === true);

console.log('\nAND THE REPORT STILL WORKS WITHOUT THE MODULE AT ALL');
// Every .gs shares one scope in the deployed app, so a bare reference to keepWarmInstalled_
// would work there and fail here — which is exactly the trap telemetryWho_ fell into, where
// a guard swallowed a ReferenceError and the measurement quietly recorded nothing.
sb = load(['Auth.gs', 'Schema.gs', 'SheetService.gs', 'StreamAccess.gs', 'SalesPolicy.gs',
  'Pricing.gs', 'Telemetry.gs'], { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
let report = null;
t.ok('the report is still produced', t.threw(() => { report = sb.getTelemetryReport(); }) === null);
t.ok('and simply says off', report && report.keepWarm === false, report && report.keepWarm);

t.done();
