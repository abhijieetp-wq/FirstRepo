/**
 * Outbound HTTP, synchronously, because the portal asks for it that way.
 *
 * Four callers: Billing pushes an invoice to Tally, Collections pulls receipts and tests the
 * connection, GoogleGate exchanges an OAuth code for a token. All four are written as
 *
 *     var response = UrlFetchApp.fetch(endpoint, { ... });
 *     var body = response.getContentText();
 *
 * with no `await`, and the codemod could not add one: it records calls by bare name, and
 * `UrlFetchApp.fetch` is a member expression it does not see. Teaching it to see them would
 * change how all forty-two modules convert, to make three functions work.
 *
 * So the same answer as the PDF and the mail: curl, through execFileSync. It blocks this
 * process for as long as the other end takes, which is why the timeout is short and
 * deliberate — a Tally box that has been switched off must not hold the whole portal.
 *
 * NO URL RESTRICTION, on purpose. Tally lives on PIE's own network and its address is
 * whatever they typed into Settings; refusing private addresses here would refuse the only
 * address that works. What stops this being an open proxy is that nothing takes a URL from
 * the browser: the two endpoints are a stored setting and a constant.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT = 30;

/** An object payload is a form, the way Apps Script encodes one. */
function formEncode(obj) {
  return Object.keys(obj).map((k) =>
    encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] === undefined ? '' : obj[k]))
    .join('&');
}

/** Apps Script's HTTPResponse, as much of it as the four callers use. */
function responseFor(code, body, headers) {
  return {
    getResponseCode: () => code,
    getContentText: () => body,
    getContent: () => Array.from(Buffer.from(body, 'utf8')),
    getBlob: () => ({
      getBytes: () => Array.from(Buffer.from(body, 'utf8')),
      getDataAsString: () => body,
      getContentType: () => headers['content-type'] || 'application/octet-stream',
      getName: () => 'response'
    }),
    getHeaders: () => Object.assign({}, headers),
    getAllHeaders: () => Object.assign({}, headers)
  };
}

function urlFetchApp(options) {
  const o = options || {};
  const timeout = o.timeoutSeconds || Number(process.env.ERP_FETCH_TIMEOUT) || DEFAULT_TIMEOUT;

  function fetch(url, params) {
    const p = params || {};
    const method = String(p.method || 'get').toUpperCase();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-fetch-'));
    const bodyFile = path.join(work, 'body');
    const headFile = path.join(work, 'head');
    const sendFile = path.join(work, 'send');

    try {
      const args = ['--silent', '--show-error', '--location',
        '--max-time', String(timeout),
        '--request', method,
        '--output', bodyFile,
        '--dump-header', headFile,
        '--write-out', '%{http_code}'];

      if (p.payload !== undefined && p.payload !== null) {
        let type = p.contentType;
        let data;
        if (typeof p.payload === 'string') {
          data = p.payload;
        } else {
          // Apps Script form-encodes an object payload unless told otherwise. The Google
          // token exchange relies on it, and its client secret is in there — so it goes
          // through a file, never the command line, where `ps` would show it.
          data = formEncode(p.payload);
          type = type || 'application/x-www-form-urlencoded';
        }
        fs.writeFileSync(sendFile, data, 'utf8');
        if (type) args.push('--header', 'Content-Type: ' + type);
        args.push('--data-binary', '@' + sendFile);
      }

      for (const [k, v] of Object.entries(p.headers || {})) {
        args.push('--header', k + ': ' + v);
      }
      args.push('--', url);

      const printed = execFileSync('curl', args,
        { encoding: 'utf8', timeout: (timeout + 5) * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
      const code = Number(String(printed).trim().slice(-3));
      const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';

      const headers = {};
      if (fs.existsSync(headFile)) {
        for (const line of fs.readFileSync(headFile, 'utf8').split(/\r?\n/)) {
          const at = line.indexOf(':');
          if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
      }

      // Apps Script throws on a failure response unless told to mute it, and two of the
      // four callers rely on being handed the body of a rejection to read the error out of.
      if (!p.muteHttpExceptions && (code < 200 || code >= 300)) {
        throw new Error('Request failed for ' + url + ' — returned code ' + code + '. ' +
          'Truncated server response: ' + body.slice(0, 200));
      }
      return responseFor(code, body, headers);
    } catch (err) {
      if (err && err.message && /returned code/.test(err.message)) throw err;
      const said = (err && err.stderr ? String(err.stderr).trim() : '') ||
        (err && err.message ? err.message : String(err));
      throw new Error('Could not reach ' + url + ': ' + said.slice(0, 200));
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* tmp will go */ }
    }
  }

  return { fetch, fetchAll: (requests) => (requests || []).map((r) =>
    fetch(typeof r === 'string' ? r : r.url, typeof r === 'string' ? {} : r)) };
}

module.exports = { urlFetchApp, formEncode, responseFor };
