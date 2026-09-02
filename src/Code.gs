function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ELGI Spares ERP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by Index.html to pull in Stylesheet.html / JavaScript.html at template-eval time. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** First call the client makes on load: identifies the user and gates the UI by role. */
function bootstrap() {
  return getCurrentUser();
}
