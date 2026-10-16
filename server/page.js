/**
 * The portal's HTML, assembled the way Apps Script assembled it.
 *
 * Index.html pulls in Stylesheet.html and JavaScript.html with `<?!= include('Stylesheet') ?>`
 * — Apps Script's templating, evaluated server-side before the page is sent. There is no Apps
 * Script here, so the same substitution happens in this file, over the same three files.
 *
 * The three files are NOT copied into server/. They are the live ones in src/, because during
 * the cutover both systems serve the same portal and a second copy of a 10,000-line
 * JavaScript.html is a second copy that drifts. When the sheet is finally switched off they
 * can move; until then there is one of each.
 *
 * Only two template forms exist in this project — `<?!= include('X'); ?>` and the two scalars
 * doGet sets — so this is a substitution, not a template engine. Anything else in the markup
 * is left alone and reported, because quietly ignoring a tag you do not understand is how a
 * page goes out with a hole in it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** `<?!= include('Name'); ?>` and `<?= x ?>` / `<?!= x ?>`, which is all doGet ever used. */
const INCLUDE = /<\?!?=\s*include\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*;?\s*\?>/g;
const SCALAR = /<\?!?=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*\?>/g;
const ANY_TAG = /<\?[\s\S]*?\?>/g;

let cache = null;

/**
 * @param vars  what doGet set on the template: title, googlePass.
 * @return      { html, warnings }
 */
function render(vars) {
  const v = vars || {};
  const stamp = ['Index.html', 'Stylesheet.html', 'JavaScript.html']
    .map((f) => { try { return fs.statSync(path.join(SRC, f)).mtimeMs; } catch (e) { return 0; } })
    .join(':');

  if (!cache || cache.stamp !== stamp) {
    let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
    html = html.replace(INCLUDE, (_, name) =>
      fs.readFileSync(path.join(SRC, name + '.html'), 'utf8'));
    cache = { stamp, html };
  }

  let html = cache.html.replace(SCALAR, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(v, name)) return String(v[name]);
    return whole;                                  // left for the check below to notice
  });

  // Anything still looking like a template tag is something this does not understand, and
  // a page served with `<?!= something ?>` visible in it is a page nobody can use.
  const left = html.match(ANY_TAG) || [];
  html = html.replace(ANY_TAG, '');

  // The head needs what doGet added through HtmlService rather than through the markup.
  html = html.replace('</head>',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>' + escapeHtml(v.title || 'ERP') + '</title>\n</head>');

  return { html, warnings: left };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { render, escapeHtml };
