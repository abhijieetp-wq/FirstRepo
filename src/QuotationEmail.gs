/**
 * Sending the offer from the portal.
 *
 * Until now the last step of preparing a quotation happened outside the system: download the
 * PDF, open Gmail, find the customer's address, type a covering note, attach, send. Every part
 * of that is somewhere the wrong file or the wrong address can be picked, and none of it left
 * a record — `emailSentDate` has been a column nothing ever filled.
 *
 * Apps Script sends as the signed-in user, so the mail comes from the coordinator's own
 * address and their reply goes back to them, not into the application. That is the right
 * behaviour and it is also why there is nothing to configure.
 */

/** What the portal offers before anybody presses send. */
function prepareQuotationEmail(quotationId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var quote = getQuotation(quotationId);
  // Said before they compose the note rather than after, when the attachment fails to build.
  if (quote.addressGap) throw new Error(quote.addressGap);
  var co = getCompanyProfile();
  var contact = quote.contactId ? findRowById_('CustomerContacts', quote.contactId) : null;

  if (!contact && quote.customerId) {
    var all = findRowsByColumn_('CustomerContacts', 'customerId', [String(quote.customerId)])
      .filter(function (c) {
        return String(c.active).toUpperCase() !== 'FALSE' && String(c.email || '').trim();
      });
    contact = all.filter(function (c) {
      return String(c.isPrimary).toUpperCase() === 'TRUE';
    })[0] || all[0] || null;
  }

  var stream = quote.businessStream;
  var what = stream === STREAM_COMPRESSOR ? 'air compressor' : 'spare parts';

  return {
    quotationId: quotationId,
    quoteNo: quote.quoteNo,
    revision: quote.revision,
    customerName: quote.customerName,
    to: contact ? String(contact.email || '') : '',
    contactName: contact ? String(contact.name || '') : '',
    // Deliberately not the customer's other addresses: copying somebody in is a decision, and
    // guessing at it is how an offer reaches a person it was not meant for.
    //
    // The office address, never the coordinator's. This copied whichever address their user
    // record carried, which on this installation is a personal one — so the customer saw it in
    // the CC header of every offer, and it followed the thread from then on. The printed
    // document was corrected for the same reason; this is the other half of it. PIE work out of
    // one shared inbox, so copying it is what actually gives the coordinator sight of the
    // thread, and it survives them leaving.
    cc: String(co.email || ''),
    subject: quote.quoteNo + (quote.revision && quote.revision !== 'R0'
      ? ' ' + quote.revision : '') + ' — offer for ' + what +
      (quote.machineModel ? ' (' + quote.machineModel + ')' : ''),
    body: quotationEmailBody_(quote, co, contact, user),
    alreadySent: String(quote.emailSentDate || ''),
    grand: quote.grand
  };
}

/** A covering note the coordinator can send as it stands or rewrite before sending. */
function quotationEmailBody_(quote, co, contact, user) {
  var greeting = contact && contact.name
    ? 'Dear ' + String(contact.name).trim() + ','
    : String(co.salutation || 'Dear Sir/Madam,');

  var lines = [
    greeting,
    '',
    'Thank you for your enquiry. Our offer ' + quote.quoteNo +
      (quote.revision && quote.revision !== 'R0' ? ' ' + quote.revision : '') +
      ' is attached.',
    ''
  ];
  if (quote.validUntil) {
    lines.push('The offer is valid until ' + quote.validUntil + '.');
    lines.push('');
  }
  lines.push('We look forward to receiving your purchase order. Please do come back to us with ' +
    'any clarification you need.');
  lines.push('');
  lines.push(String(co.signOffLine || 'Yours sincerely,'));
  // Never the address as a fallback: an unnamed user is a setup mistake, and printing a
  // personal address to a customer is a worse answer to it than printing nothing.
  lines.push(String(user.name || ''));
  if (user.designation) lines.push(String(user.designation));
  lines.push('For ' + String(co.legalName || ''));
  if (co.signOffPhone) lines.push('M: ' + String(co.signOffPhone));
  return lines.join('\n');
}

/**
 * Sends the offer, with the PDF attached, and records that it went.
 *
 * The PDF is built here rather than taken from Drive, so what the customer receives is the
 * quotation as it stands at the moment of sending — not whatever was generated earlier and
 * might since have been revised.
 */
function sendQuotationEmail(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var quotationId = String((input && input.quotationId) || '');
  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
  if (!quote) throw new Error('Quotation not found.');
  requireCommercial_(user, 'A quotation');
  requireStream_(user, quote.businessStream, 'This quotation');

  var to = String((input && input.to) || '').trim();
  if (!isEmailList_(to)) {
    throw new Error('Check the address — "' + to + '" does not look like an e-mail address.');
  }
  var cc = String((input && input.cc) || '').trim();
  if (cc && !isEmailList_(cc)) {
    throw new Error('Check the copy-to address — "' + cc + '" does not look like one.');
  }
  var subject = String((input && input.subject) || '').trim();
  if (!subject) throw new Error('The e-mail needs a subject.');
  var body = String((input && input.body) || '').trim();
  if (!body) throw new Error('The e-mail needs something in it.');

  if (!readTable_('QuotationItems').some(function (i) {
    return String(i.quotationId) === String(quotationId);
  })) {
    throw new Error('This quotation has no lines on it. There is nothing to send.');
  }

  // Replies belong to the office, not to whoever happened to press send. Left as the user's
  // address, a customer replying to an offer reached one person's personal inbox — invisible to
  // everyone else, and lost entirely once that person moves on. Blank rather than falling back
  // to the user: with no reply-to, replies go to the account the script sends as, which is the
  // office account, and that is the right answer anyway.
  var co = getCompanyProfile();
  var replyTo = String((co && co.email) || '').trim();

  var html = buildQuotationHtml(quotationId);
  var name = String(quote.quoteNo).replace(/[\/\\:*?"<>|]/g, '-') +
    (quote.revision && quote.revision !== 'R0' ? ' ' + quote.revision : '') + '.pdf';
  var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);

  MailApp.sendEmail({
    to: to,
    cc: cc || undefined,
    subject: subject,
    body: body,
    name: String(user.name || ''),
    replyTo: replyTo || undefined,
    attachments: [pdf]
  });

  var patch = { emailSentDate: todayIso_() };
  // Sending it is what "submitted" has always meant; a coordinator should not have to say so
  // twice. An offer already further along keeps the status it has.
  if (['Draft', 'Approved'].indexOf(quote.status) !== -1) {
    patch.status = 'Submitted';
    patch.submittedDate = todayIso_();
    patch.locked = 'TRUE';
  }
  updateRowById_('Quotations', 'id', quotationId, patch, 'Offer e-mailed to ' + to);

  return { sentTo: to, cc: cc, quoteNo: quote.quoteNo, attachment: name,
           statusNow: patch.status || quote.status };
}

/** One address, or several separated by commas. */
function isEmailList_(value) {
  var parts = String(value || '').split(',').map(function (p) { return p.trim(); })
    .filter(function (p) { return p; });
  if (!parts.length) return false;
  return parts.every(function (p) { return /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(p); });
}

/** How many messages the account can still send today, so the screen can warn before it fails. */
function remainingEmailQuota() {
  getCurrentUser();
  try {
    return MailApp.getRemainingDailyQuota();
  } catch (err) {
    return null;
  }
}
