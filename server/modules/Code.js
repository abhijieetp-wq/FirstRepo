/**
 * Converted from src/Code.gs by migration/to-async.js.
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
 * Which build is actually running.
 *
 * Apps Script serves the /exec URL from a pinned deployment version, so pushing code and
 * seeing no change is the normal experience rather than a fault — and there was no way to tell
 * a stale deployment from a broken feature except by hunting for the feature. This is shown in
 * the footer of every screen and on Settings → System. Bump it with anything worth deploying.
 */
var APP_BUILD = '2026-10-28.9';

async function doGet(e) {
  // Which Google account, if the office has asked for one. This either says "carry on", or
  // hands back the page to serve instead — the button that sends the browser to Google, or
  // the notice that it came back as somebody who may not be here. See GoogleGate.gs.
  var gate = googleGateForRequest_(e);
  if (!gate.serve) return gate.html;

  // The browser tab is named by the company profile, so a second installation is not called
  // after the first one's brand.
  var title = 'ERP';
  try { title = (await getCompanyProfile()).appName || title; } catch (err) { /* pre-setup */ }
  var page = HtmlService.createTemplateFromFile('Index');
  // The proof that Google was satisfied, spent once by the sign-in call that carries it.
  // Written into the page rather than asked for afterwards, because the answer arrived with
  // this request and there is nowhere else to put it.
  page.googlePass = gate.pass || '';
  return page
    .evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by Index.html to pull in Stylesheet.html / JavaScript.html at template-eval time. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * First call the client makes on load: identifies the user, gates the UI by role, and hands
 * back what the application calls itself so the header is not spelled into the markup.
 */
async function bootstrap() {
  var user = getCurrentUser();
  // Naming the header must never be what stops the app opening: on a Sheet that predates the
  // CompanyProfile tab this read throws, and the whole application would go down with it.
  try {
    var co = await getCompanyProfile();
    user.appName = co.appName || 'ERP';
    user.appSubtitle = co.appSubtitle || '';
    user.appMark = String(co.appName || 'ERP').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  } catch (err) {
    user.appName = 'ERP';
    user.appSubtitle = '';
    user.appMark = 'ER';
  }
  user.build = APP_BUILD;
  // Standard quotation text that is new in this build is installed on the first load after a
  // deployment. A Sheet not yet set up has no QuoteTemplates tab, and that must not be what
  // stops the app opening.
  try {
    user.installedSections = await applyBuildUpdates_();
  } catch (err) {
    user.installedSections = null;
  }
  return user;
}
