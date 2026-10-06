/**
 * Builds a standalone copy of the portal that opens in a browser with no Apps Script behind it.
 *
 * Index.html, Stylesheet.html and JavaScript.html are the real files, unmodified. What changes
 * is the server: a fixture script is wedged in where the stylesheet include sits, and it
 * defines `google.script.run` as an object that answers from canned data and records what was
 * asked for. The client cannot tell the difference, which is the point — the thing under test
 * is the real client, not a copy of it that has drifted.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview-base.html [googlePass]
 *
 * The third argument stands in for a browser arriving back from Google's sign-in; doGet fills
 * that scriptlet in, and nothing here evaluates scriptlets.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const fixture = fs.readFileSync(process.argv[2], 'utf8');
const outPath = process.argv[3];
const pass = process.argv[4] || '';

const html = read('Index.html')
  .replace("<?!= include('Stylesheet'); ?>", read('Stylesheet.html') + '\n' + fixture)
  .replace("<?!= include('JavaScript'); ?>", read('JavaScript.html'))
  .replace('<?= googlePass ?>', pass);

fs.writeFileSync(outPath, html);
console.log('built ' + outPath);
