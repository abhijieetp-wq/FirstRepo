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
 *        [--title="ELGi Sales ERP"]
 *
 * Always ERP 2.0's face, the portal's only one (server/page.js). --ui=... from older commands
 * is accepted and ignored.
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
// ERP 2.0 is the only face (server/page.js); --ui is accepted and ignored.
const ui = 'v2';

const page = render({ title: flags.title || 'ERP', googlePass: pass }, { ui, inject: fixture });
if (page.warnings.length) {
  console.error('template tags the renderer does not understand: ' + page.warnings.join(' '));
  process.exit(1);
}
fs.writeFileSync(outPath, page.html);
console.log('built ' + outPath + ' (' + ui + ')');
