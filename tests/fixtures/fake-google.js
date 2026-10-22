/**
 * Just enough of Google for tests/gmail-test.js: the token endpoint, Gmail's upload send, and
 * revoke. Runs as its own process because the server talks to Google through curl with
 * execFileSync, which would block a fake living in the same process from ever answering.
 *
 * Every request is appended to the log file named in argv[2] as one JSON line, so the test can
 * read exactly what the server sent. Prints the port once it is listening.
 */
'use strict';

const http = require('http');
const fs = require('fs');

const LOG = process.argv[2];
const SENDER = 'admin.premierindia@gmail.com';
let minted = 1;
let sent = 0;

function idToken(email) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64({ alg: 'RS256' }) + '.' + b64({ email, email_verified: true }) + '.sig';
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    fs.appendFileSync(LOG, JSON.stringify({
      path: req.url, method: req.method,
      authorization: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '', body
    }) + '\n');
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const form = Object.fromEntries(new URLSearchParams(body));

    if (req.url.startsWith('/token')) {
      if (form.grant_type === 'authorization_code') {
        if (form.code === 'GOOD' || form.code === 'NOSEND') {
          return reply(200, {
            access_token: 'ACCESS-1', expires_in: 3599, token_type: 'Bearer',
            refresh_token: 'REFRESH-1', id_token: idToken(SENDER),
            scope: (form.code === 'GOOD' ? 'https://www.googleapis.com/auth/gmail.send ' : '') +
              'openid https://www.googleapis.com/auth/userinfo.email'
          });
        }
        return reply(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      }
      if (form.grant_type === 'refresh_token') {
        if (form.refresh_token === 'REFRESH-1') {
          minted++;
          return reply(200, { access_token: 'ACCESS-' + minted, expires_in: 3599 });
        }
        return reply(400, { error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.' });
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (req.url.startsWith('/send')) {
      if (!/^Bearer ACCESS-\d+$/.test(req.headers.authorization || '')) {
        return reply(401, { error: { code: 401, message: 'Invalid Credentials' } });
      }
      sent++;
      return reply(200, { id: 'msg-' + sent, labelIds: ['SENT'] });
    }
    if (req.url.startsWith('/revoke')) return reply(200, {});
    reply(404, {});
  });
}).listen(0, '127.0.0.1', function () {
  process.stdout.write(String(this.address().port) + '\n');
});
