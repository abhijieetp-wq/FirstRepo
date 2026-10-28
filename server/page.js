/**
 * The portal's HTML, assembled the way Apps Script assembled it.
 *
 * Index.html pulls in Stylesheet.html and JavaScript.html with `<?!= include('Stylesheet') ?>`
 * — Apps Script's templating, evaluated server-side before the page is sent. There is no Apps
 * Script here, so the same substitution happens in this file.
 *
 * TWO FACES, ONE PORTAL. The markup and the 10,900 lines of behaviour are the live files in
 * src/, shared with Apps Script, because a second copy of either is a second copy that drifts.
 * What differs is how it looks:
 *
 *   'web'      src/Index.html and src/JavaScript.html, dressed by web/Stylesheet.html and
 *              extended by web/Shell.html — the sidebar, the icons, the command palette.
 *              This is what the Node server serves.
 *   'classic'  src/ and nothing else: byte for byte what Apps Script serves. Kept so the new
 *              design can be switched off with one environment variable if it ever has to be.
 *   'v2'       ERP 2.0's look: the 'web' face with web2/Theme.html after its stylesheet and
 *              web2/Shell.html after its shell. Still the same markup and behaviour — every
 *              screen, rule, import and printed document is ERP 1's — so 2.0 can be looked at,
 *              and switched on and off, without anything underneath changing.
 *
 * The new design lives in web/ rather than src/ for one reason: clasp pushes src/ and only
 * src/. Nothing in web/ can reach the live Apps Script portal by accident, which is what makes
 * "keep Apps Script on the old look until the cutover" a property of the repository rather
 * than something somebody has to remember before every `clasp push`.
 *
 * Only two template forms exist in this project — `<?!= include('X'); ?>` and the two scalars
 * doGet sets — so this is a substitution, not a template engine. Anything else in the markup
 * is left alone and reported, because quietly ignoring a tag you do not understand is how a
 * page goes out with a hole in it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'web');
const WEB2 = path.join(ROOT, 'web2');

/** `<?!= include('Name'); ?>` and `<?= x ?>` / `<?!= x ?>`, which is all doGet ever used. */
const INCLUDE = /<\?!?=\s*include\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*;?\s*\?>/g;
const SCALAR = /<\?!?=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*\?>/g;
const ANY_TAG = /<\?[\s\S]*?\?>/g;

// Where a test fixture goes: straight after the stylesheet, before any script runs, which is
// where tests/build-preview.js has always put its stand-in for google.script.run.
const AFTER_STYLES = '<!--erp:after-styles-->';

const UIS = ['web', 'classic', 'v2'];

/** Which file answers each include, for one face of the portal. */
function sourcesFor(ui) {
  const web = ui !== 'classic';
  const v2 = ui === 'v2';
  return {
    Index: path.join(SRC, 'Index.html'),
    Stylesheet: path.join(web ? WEB : SRC, 'Stylesheet.html'),
    // After the stylesheet, so its tokens win.
    Theme: v2 ? path.join(WEB2, 'Theme.html') : null,
    JavaScript: path.join(SRC, 'JavaScript.html'),
    // Runs after JavaScript.html, so everything it extends already exists.
    Shell: web ? path.join(WEB, 'Shell.html') : null,
    // And this after that, so it can build on what the shell drew.
    Shell2: v2 ? path.join(WEB2, 'Shell.html') : null
  };
}

const cache = {};

function assemble(ui) {
  const files = sourcesFor(ui);
  const stamp = Object.values(files).filter(Boolean)
    .map((f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } })
    .join(':');
  if (cache[ui] && cache[ui].stamp === stamp) return cache[ui].html;

  let html = fs.readFileSync(files.Index, 'utf8');
  html = html.replace(INCLUDE, (_, name) => {
    if (name === 'Stylesheet') {
      return fs.readFileSync(files.Stylesheet, 'utf8') +
        (files.Theme ? '\n' + fs.readFileSync(files.Theme, 'utf8') : '') + '\n' + AFTER_STYLES;
    }
    if (name === 'JavaScript') {
      return fs.readFileSync(files.JavaScript, 'utf8') +
        (files.Shell ? '\n' + fs.readFileSync(files.Shell, 'utf8') : '') +
        (files.Shell2 ? '\n' + fs.readFileSync(files.Shell2, 'utf8') : '');
    }
    return fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
  });
  cache[ui] = { stamp, html };
  return html;
}

/**
 * @param vars     what doGet set on the template: title, googlePass.
 * @param options  { ui: 'web' | 'classic' | 'v2', inject: html placed after the stylesheet }
 * @return         { html, warnings, ui }
 */
function render(vars, options) {
  const v = vars || {};
  const o = options || {};
  const ui = UIS.indexOf(o.ui) !== -1 ? o.ui : 'web';

  // A function rather than a string as the replacement, here and below: a string replacement
  // reads `$&` and `$'` inside it as instructions, so a fixture or a company name containing
  // either would be silently spliced with the text around it.
  let html = assemble(ui).replace(AFTER_STYLES, () => o.inject || '');

  html = html.replace(SCALAR, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(v, name)) return String(v[name]);
    return whole;                                  // left for the check below to notice
  });

  // Anything still looking like a template tag is something this does not understand, and
  // a page served with `<?!= something ?>` visible in it is a page nobody can use.
  const left = html.match(ANY_TAG) || [];
  html = html.replace(ANY_TAG, '');

  // The head needs what doGet added through HtmlService rather than through the markup.
  html = html.replace('</head>', () =>
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>' + escapeHtml(v.title || 'ERP') + '</title>\n</head>');

  return { html, warnings: left, ui };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { render, escapeHtml, UIS };
