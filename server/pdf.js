/**
 * HTML into a PDF, synchronously, because the portal asks for it that way.
 *
 *     var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf');
 *
 * One expression, no `await`, and nowhere to put one: `.getAs()` is a method on the object
 * `newBlob` returned, which the codemod's call graph cannot see. So the render has to finish
 * before the call returns, which rules out every asynchronous PDF library and leaves
 * Chromium's own command line, run with execFileSync.
 *
 * The honest cost: about half a second per PDF, during which this process does nothing else.
 * For a document somebody deliberately asked for, a few times an hour, that is a fair trade
 * against rewriting the 954-line template. It would stop being fair if PDFs were generated
 * in bulk, and the way out then is to mark the chain async and await it — the codemod can
 * do that once a human decides where the awaits go.
 *
 * Apps Script's own converter was a weak renderer: the template's comments apologise for it
 * twice and avoid flexbox, grid and most modern CSS because of it. Chromium renders the same
 * HTML properly, so the PDFs come out at least as good as before and the template could now
 * be modernised if anyone wants to.
 *
 * Chromium is found at ERP_CHROMIUM, or in the usual places. A host without one gets a
 * refusal naming the variable, not a broken PDF.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CANDIDATES = [
  process.env.PLAYWRIGHT_BROWSERS_PATH && path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'),
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

let found;

const there = (p) => { try { return !!p && fs.existsSync(p); } catch (e) { return false; } };

/**
 * The browser's path, or null. Looked up once: it does not move while the process runs.
 *
 * ERP_CHROMIUM is not one candidate among several — set, it is the only one. The first
 * version put it at the head of the list and fell through to the others when the path did
 * not exist, so a deployment that named the wrong path quietly rendered with a different
 * browser and reported itself healthy. An operator who names a path has said which browser
 * to use, and a typo in it is worth hearing about.
 */
function chromium() {
  if (found !== undefined) return found;
  const asked = process.env.ERP_CHROMIUM;
  if (asked) found = there(asked) ? asked : null;
  else found = CANDIDATES.find(there) || null;
  return found;
}

/** Said in the health check and in the refusal, so a typo names itself. */
function chromiumProblem() {
  if (chromium()) return null;
  return process.env.ERP_CHROMIUM
    ? 'ERP_CHROMIUM is set to ' + process.env.ERP_CHROMIUM + ', and there is nothing there'
    : 'no Chromium was found; set ERP_CHROMIUM to its path';
}

/**
 * @param html     the document
 * @param options  { timeoutMs }
 * @return         a Buffer of PDF
 */
function htmlToPdf(html, options) {
  const o = options || {};
  const exe = chromium();
  if (!exe) {
    throw new Error('This server cannot make PDFs: ' + chromiumProblem() + '.' +
      (process.env.ERP_CHROMIUM ? '' : ' Looked in: ' + CANDIDATES.join(', ')));
  }

  // Its own directory, so two requests at once cannot read each other's output, and so the
  // whole lot goes in one unlink.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pdf-'));
  const src = path.join(work, 'page.html');
  const out = path.join(work, 'out.pdf');
  // Chromium wants a profile directory it may write to, and will pick one in $HOME
  // otherwise — which on a locked-down host is not writable and fails with nothing useful.
  const profile = path.join(work, 'profile');

  try {
    fs.writeFileSync(src, html, 'utf8');
    execFileSync(exe, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',                  // no untrusted content: this HTML is ours
      '--no-first-run',
      '--disable-dev-shm-usage',       // small /dev/shm in a container makes it crash
      '--disable-extensions',
      '--user-data-dir=' + profile,
      '--print-to-pdf-no-header',      // the page draws its own footer
      '--print-to-pdf=' + out,
      'file://' + src
    ], {
      timeout: o.timeoutMs || 60000,
      stdio: 'ignore',
      // A first run builds a font cache and can take ten seconds; later ones take about
      // half of one.
      killSignal: 'SIGKILL'
    });
    if (!fs.existsSync(out)) throw new Error('Chromium produced no PDF.');
    const pdf = fs.readFileSync(out);
    // Four bytes that say it is one. A renderer that fails late can still write a file.
    if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error('Chromium produced something that is not a PDF.');
    }
    return pdf;
  } catch (err) {
    if (err && err.killed) {
      throw new Error('Making that PDF took too long and was stopped.');
    }
    throw new Error('That PDF could not be made: ' + (err && err.message ? err.message : err));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* tmp will go */ }
  }
}

module.exports = { htmlToPdf, chromium, chromiumProblem };
