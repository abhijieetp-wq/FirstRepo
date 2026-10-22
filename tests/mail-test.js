/**
 * The message that carries a quotation to a customer.
 *
 * There is no account to send through here, and there will not be one in CI either, so what
 * is tested is the part that is this project's to get right: the message. A malformed MIME
 * part is the failure that reaches the customer as an attachment they cannot open, and the
 * only way to catch it without sending is to build the message and read it back with a
 * parser that is not ours.
 *
 * The parser is Python's `email`, which is in the standard library and was not written by
 * anyone here — so it agreeing is worth something.
 *
 *   node tests/mail-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { mailer, buildMessage, addresses, headerSafe, encodeHeader } =
  require(path.join(__dirname, '..', 'server', 'mail.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(4000));
const attachment = {
  getBytes: () => Array.from(PDF),
  getName: () => 'PIE-ELGI-QUOT-26-27-418.pdf',
  getContentType: () => 'application/pdf'
};

console.log('ADDRESSES AND HEADERS');
ok('one address', addresses('a@b.com').length === 1);
ok('several, trimmed', addresses(' a@b.com , c@d.com ').join('|') === 'a@b.com|c@d.com');
ok('none', addresses('').length === 0 && addresses(null).length === 0);
// A newline in a subject is header injection: everything after it reads as another header,
// which is how a message acquires a Bcc nobody asked for.
ok('a newline cannot start a second header',
  headerSafe('Quotation\r\nBcc: thief@example.com') === 'Quotation Bcc: thief@example.com');
ok('plain ASCII is left alone', encodeHeader('Quotation 418') === 'Quotation 418');
ok('and anything else is encoded', /^=\?UTF-8\?B\?/.test(encodeHeader('Quotation ₹1,86,420')));

console.log('\nTHE MESSAGE IS WELL FORMED');
const msg = buildMessage({
  from: 'office@pie.in', name: 'Anil Mehta', to: 'buyer@example.com, second@example.com',
  cc: 'copy@example.com', replyTo: 'office@pie.in',
  subject: 'Quotation PIE/ELGI/QUOT/26-27/418 — ₹1,86,420',
  body: 'Dear Sir,\n\nPlease find our offer attached.\n', attachments: [attachment]
});
ok('every line ends CRLF, as the wire wants', !/[^\r]\n/.test(msg));
ok('the headers are all there',
  /^From: Anil Mehta <office@pie\.in>$/m.test(msg) &&
  /^To: buyer@example\.com, second@example\.com$/m.test(msg) &&
  /^Cc: copy@example\.com$/m.test(msg) &&
  /^Reply-To: office@pie\.in$/m.test(msg));
ok('it has a message id of its own', /^Message-ID: <[^>]+@pie\.in>$/m.test(msg));
ok('and a date', /^Date: \w{3}, /m.test(msg));
ok('base64 is wrapped at 76 characters',
  msg.split('\r\n').every((l) => l.length <= 998));
ok('refuses a message with nobody to send it to', (() => {
  try { buildMessage({ from: 'a@b.com', to: '', subject: 'x', body: 'y' }); return false; }
  catch (e) { return /nobody to go to/.test(e.message); }
})());
const plain = buildMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'x', body: 'y' });
ok('no attachment means no multipart', /Content-Type: text\/plain/.test(plain) &&
  !/multipart/.test(plain));

console.log('\nAND A PARSER THAT IS NOT OURS AGREES');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-mail-test-'));
const file = path.join(tmp, 'm.eml');
fs.writeFileSync(file, msg);
const report = JSON.parse(execFileSync('python3', ['-I', '-c', `
import email, email.policy, json, hashlib, sys
m = email.message_from_binary_file(open(sys.argv[1],'rb'), policy=email.policy.default)
atts = list(m.iter_attachments())
a = atts[0] if atts else None
print(json.dumps({
  'subject': m['Subject'], 'to': m['To'], 'cc': m['Cc'], 'replyTo': m['Reply-To'],
  'multipart': m.is_multipart(),
  'body': m.get_body(preferencelist=('plain',)).get_content(),
  'attachments': len(atts),
  'filename': a.get_filename() if a else None,
  'type': a.get_content_type() if a else None,
  'sha': hashlib.sha256(a.get_payload(decode=True)).hexdigest() if a else None,
}))
`, file], { encoding: 'utf8' }));
fs.rmSync(tmp, { recursive: true, force: true });

ok('it parses at all', !!report.subject);
ok('the subject survives the rupee sign and the dash',
  report.subject === 'Quotation PIE/ELGI/QUOT/26-27/418 — ₹1,86,420', report.subject);
ok('both recipients', report.to === 'buyer@example.com, second@example.com', report.to);
ok('the copy', report.cc === 'copy@example.com');
ok('the reply address', report.replyTo === 'office@pie.in');
ok('the body is the body', report.body === 'Dear Sir,\n\nPlease find our offer attached.\n',
  report.body);
ok('one attachment', report.attachments === 1);
ok('named as the quotation', report.filename === 'PIE-ELGI-QUOT-26-27-418.pdf', report.filename);
ok('typed as a PDF', report.type === 'application/pdf');
// The whole point: the customer opens what we generated, byte for byte.
ok('and the bytes are exactly the PDF we attached',
  report.sha === require('crypto').createHash('sha256').update(PDF).digest('hex'));

console.log('\nUNCONFIGURED, IT SAYS SO RATHER THAN PRETENDING');
const silent = mailer({ settings: { url: '', user: '', password: '', from: '' } });
let refused = '';
try { silent.sendEmail({ to: 'a@b.com', subject: 'x', body: 'y' }); }
catch (e) { refused = e.message; }
ok('it refuses', !!refused);
// Railway's Hobby plan blocks SMTP, so the way to fix this from the screen is the Gmail
// connection, and that is what the message sends somebody to do.
ok('naming what to do, and where', /Connect Gmail/.test(refused) &&
  /Settings \u2192 Email/.test(refused), refused);
// The quotation is saved either way; only sending is unavailable. Somebody reading this on
// screen needs to know their work is not lost.
ok('and saying the quotation is safe', /saved/.test(refused), refused);

console.log('\nCONFIGURED, IT HANDS THE RIGHT THING TO THE TRANSPORT');
let sent = null;
const probe = mailer({
  settings: { url: 'smtps://smtp.example.com:465', user: 'u', password: 'p', from: 'office@pie.in' },
  deliver: (cfg, m) => { sent = m; }
});
probe.sendEmail({ to: 'buyer@example.com', cc: 'copy@example.com', subject: 'Offer',
  body: 'text', attachments: [attachment] });
ok('an envelope sender', sent.from === 'office@pie.in');
ok('and every recipient, copies included',
  sent.rcpt.join('|') === 'buyer@example.com|copy@example.com', sent.rcpt);
ok('with the message built', /^From: office@pie\.in/m.test(sent.message));
ok('a quota it cannot know is not invented', (() => {
  try { probe.getRemainingDailyQuota(); return false; }
  catch (e) { return /does not publish/.test(e.message); }
})());

console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);
