/**
 * Builds a standalone copy of the portal that opens in a browser with no server behind it.
 *
 * Index.html, Stylesheet.html and JavaScript.html are the real files, unmodified, assembled by
 * the same server/page.js the Node server uses — so a preview cannot drift from what the
 * server actually sends. What changes is the backend: a fixture script is wedged in after the
 * stylesheet, and it defines `google.script.run` as an object that answers from canned data
 * and records what was asked for. The client cannot tell the difference, which is the point —
 * the thing under test is the real client, not a copy of it that has drifted.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [googlePass]
 *        [--ui=classic|web|v2] [--title="ELGi Sales ERP"]
 *
 * --ui=classic (the default) is exactly what Apps Script serves. --ui=web is the Node server's
 * face: the same markup and behaviour, dressed by web/Stylesheet.html and web/Shell.html.
 *
 * The googlePass argument stands in for a browser arriving back from Google's sign-in; doGet
 * fills that scriptlet in, and so does this.
 */
const fs = require('fs');
const path = require('path');
const { render } = require(path.join(__dirname, '..', 'server', 'page.js'));

const flags = {};
const positional = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.*)$/.exec(a);
  if (m) flags[m[1]] = m[2]; else positional.push(a);
}

const fixture = fs.readFileSync(positional[0], 'utf8');
const outPath = positional[1];
const pass = positional[2] || '';
const ui = flags.ui === 'web' || flags.ui === 'v2' ? flags.ui : 'classic';

const page = render({ title: flags.title || 'ERP', googlePass: pass }, { ui, inject: fixture });
if (page.warnings.length) {
  console.error('template tags the renderer does not understand: ' + page.warnings.join(' '));
  process.exit(1);
}
fs.writeFileSync(outPath, page.html);
console.log('built ' + outPath + ' (' + ui + ')');
