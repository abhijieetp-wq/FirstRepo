/**
 * Sending the quotation, now that there is no MailApp.
 *
 * Synchronous again, and for the same reason as the PDF: QuotationEmail.gs calls
 *
 *     MailApp.sendEmail({ to: ..., attachments: [pdf] });
 *
 * with no `await`, and it matters that it is synchronous — if the send throws, the quotation
 * is not marked Submitted. Queue the message and flush it after the call returns and an
 * offer that never reached the customer is recorded as sent. So the send has to finish
 * inside the call, which rules out nodemailer and every other asynchronous client.
 *
 * curl speaks SMTP and is on every host this will run on, so the message is built here as
 * RFC 5322 text and handed to `curl --upload-file` over execFileSync. No new dependency,
 * and the one thing that could go wrong — a malformed MIME part — is this file's own code
 * and is tested.
 *
 * Configured entirely by environment, because the account is PIE's to choose and this should
 * not care which one they pick:
 *
 *     SMTP_URL       smtps://smtp.gmail.com:465  or  smtp://smtp.office365.com:587
 *     SMTP_USER      the mailbox
 *     SMTP_PASSWORD  its password, or an app password where the provider wants one
 *     SMTP_FROM      what the customer sees; defaults to SMTP_USER
 *
 * Unset, it refuses in words naming the variables. It never pretends to have sent anything.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/** Addresses, one or several, as a clean list. */
function addresses(value) {
  return String(value || '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * A header value that cannot carry a second header.
 *
 * A newline in a subject is header injection: everything after it is read as another header,
 * which is how a message acquires a Bcc nobody asked for. Folded onto one line rather than
 * refused, because a pasted subject with a line break in it is a mistake, not an attack.
 */
function headerSafe(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ').trim();
}

/** Anything outside plain ASCII, encoded so a subject in any language survives the wire. */
function encodeHeader(value) {
  const v = headerSafe(value);
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

/** Base64 in 76-character lines, as MIME wants it. */
function wrap(b64) {
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * The whole message as RFC 5322 text.
 *
 * Exported so a test can read what would be sent without sending it, which is the only way
 * to check MIME construction without an account to send through.
 */
function buildMessage(m) {
  const boundary = '--erp-' + crypto.randomBytes(12).toString('hex');
  const to = addresses(m.to);
  const cc = addresses(m.cc);
  if (!to.length) throw new Error('That message has nobody to go to.');

  const from = m.name
    ? encodeHeader(m.name) + ' <' + headerSafe(m.from) + '>'
    : headerSafe(m.from);

  const head = [
    'From: ' + from,
    'To: ' + to.map(headerSafe).join(', '),
    cc.length ? 'Cc: ' + cc.map(headerSafe).join(', ') : null,
    m.replyTo ? 'Reply-To: ' + headerSafe(m.replyTo) : null,
    'Subject: ' + encodeHeader(m.subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomUUID() + '@' +
      (String(m.from || '').split('@')[1] || 'localhost') + '>',
    'MIME-Version: 1.0'
  ].filter(Boolean);

  const attachments = (m.attachments || []).filter(Boolean);
  const bodyText = String(m.body === undefined || m.body === null ? '' : m.body);

  if (!attachments.length) {
    return head.concat([
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(bodyText, 'utf8').toString('base64'))
    ]).join('\r\n') + '\r\n';
  }

  const parts = [
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(bodyText, 'utf8').toString('base64'))
  ];
  for (const a of attachments) {
    const bytes = typeof a.getBytes === 'function' ? a.getBytes() : a.bytes;
    const buf = Buffer.isBuffer(bytes) ? bytes
      : Buffer.from((bytes || []).map((b) => (b < 0 ? b + 256 : b)));
    const name = headerSafe(typeof a.getName === 'function' ? a.getName() : (a.name || 'attachment'));
    const type = (typeof a.getContentType === 'function' ? a.getContentType() : a.mimeType)
      || 'application/octet-stream';
    parts.push(
      '--' + boundary,
      'Content-Type: ' + headerSafe(type) + '; name="' + name.replace(/"/g, '') + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + name.replace(/"/g, '') + '"',
      '',
      wrap(buf.toString('base64'))
    );
  }
  parts.push('--' + boundary + '--', '');

  return head.concat([
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    ''
  ]).join('\r\n') + parts.join('\r\n') + '\r\n';
}

function settings(env) {
  const e = env || process.env;
  return {
    url: e.SMTP_URL || '',
    user: e.SMTP_USER || '',
    password: e.SMTP_PASSWORD || '',
    from: e.SMTP_FROM || e.SMTP_USER || ''
  };
}

/** @return a MailApp with the methods QuotationEmail.gs calls. */
function mailer(options) {
  const o = options || {};
  const cfg = o.settings || settings(o.env);
  // A test passes this to capture the message instead of sending it.
  const deliver = o.deliver || curlSend;

  return {
    sendEmail: (m) => {
      if (!cfg.url || !cfg.user || !cfg.password) {
        throw new Error('This server cannot send e-mail yet: no mailbox is configured. ' +
          'Set SMTP_URL, SMTP_USER and SMTP_PASSWORD on the server, then try again. ' +
          'The quotation itself is saved — only sending it is unavailable.');
      }
      const message = buildMessage(Object.assign({ from: cfg.from }, m));
      deliver(cfg, {
        from: cfg.from,
        rcpt: addresses(m.to).concat(addresses(m.cc)),
        message
      });
      return true;
    },

    /**
     * Apps Script metered this and the screen warned before a send would fail. An ordinary
     * mailbox has limits too, but no way to ask what is left — so the honest answer is that
     * it is not known, which the portal already handles: remainingEmailQuota returns null
     * and the screen says nothing rather than something made up.
     */
    getRemainingDailyQuota: () => {
      throw new Error('An SMTP mailbox does not publish a remaining quota.');
    }
  };
}

function curlSend(cfg, msg) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-mail-'));
  const file = path.join(work, 'message.eml');
  try {
    fs.writeFileSync(file, msg.message, 'utf8');
    const args = [
      '--silent', '--show-error', '--ssl-reqd',
      '--url', cfg.url,
      '--mail-from', msg.from,
      '--upload-file', file,
      // Credentials go on stdin, not the command line, where `ps` would show them.
      '--config', '-'
    ];
    for (const r of msg.rcpt) args.splice(args.indexOf('--upload-file'), 0, '--mail-rcpt', r);
    execFileSync('curl', args, {
      input: 'user = "' + String(cfg.user).replace(/"/g, '\\"') + ':' +
        String(cfg.password).replace(/"/g, '\\"') + '"\n',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    const said = (err && err.stderr ? String(err.stderr) : '') ||
      (err && err.message ? err.message : String(err));
    // Never the password, whatever curl decided to print.
    throw new Error('That e-mail could not be sent: ' +
      said.replace(new RegExp(String(cfg.password).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        '****').trim().slice(0, 300));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* tmp will go */ }
  }
}

module.exports = { mailer, buildMessage, settings, addresses, headerSafe, encodeHeader };
