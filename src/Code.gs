function doGet(e) {
  // The browser tab is named by the company profile, so a second installation is not called
  // after the first one's brand.
  var title = 'ERP';
  try { title = getCompanyProfile().appName || title; } catch (err) { /* pre-setup */ }
  return HtmlService.createTemplateFromFile('Index')
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
function bootstrap() {
  var user = getCurrentUser();
  // Naming the header must never be what stops the app opening: on a Sheet that predates the
  // CompanyProfile tab this read throws, and the whole application would go down with it.
  try {
    var co = getCompanyProfile();
    user.appName = co.appName || 'ERP';
    user.appSubtitle = co.appSubtitle || '';
    user.appMark = String(co.appName || 'ERP').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  } catch (err) {
    user.appName = 'ERP';
    user.appSubtitle = '';
    user.appMark = 'ER';
  }
  return user;
}
