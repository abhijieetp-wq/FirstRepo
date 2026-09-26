/**
 * The printed quotation — M19.
 *
 * Built to the shape of the client's own compressor offer, which they named as the reference
 * where their two samples disagree: letterhead, covering letter, why-ELGi, the technical
 * specification of each machine, the scope of supply, the price schedule, the terms, and the
 * installation notes. A spares offer is the same document with the sections that have no
 * content left out — nobody maintains two templates that drift apart.
 *
 * Everything that reads as boilerplate is stored, not written here: the letterhead comes from
 * the company profile, the standing text from QuoteTemplates. Reworded terms need no code
 * change, which matters because terms change more often than software does.
 *
 * The HTML is deliberately plain — tables and simple rules rather than flexbox — because
 * Apps Script's HTML-to-PDF converter is a basic renderer and silently ignores modern layout.
 */

var QUOTE_PDF_FOLDER = 'ERP Quotations';

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders a template body as a list, honouring one level of nesting.
 *
 * A line beginning "- " is a sub-point of the line above it. Their Why ELGi has three headings
 * with bullets beneath each, and their warranty clause has four lettered sub-clauses; flattening
 * either loses the sense of what belongs to what.
 */
function bulletList_(lines, ordered) {
  // Build the shape first, then render it. Knowing whether an item has children before the
  // opening tag is written is what lets a heading be marked as one.
  var tree = [];
  lines.forEach(function (raw) {
    var isSub = /^-\s+/.test(raw);
    var text = raw.replace(/^-\s+/, '');
    if (isSub && tree.length) tree[tree.length - 1].children.push(text);
    else tree.push({ text: isSub ? text : raw, children: [] });
  });

  var tag = ordered ? 'ol' : 'ul';
  var out = ['<' + tag + '>'];
  tree.forEach(function (node) {
    // Their document signals a heading by weight and bullet shape, not by indenting it —
    // the points beneath sit at the same margin. An item with nothing under it is an
    // ordinary bullet and stays that way.
    out.push('<li' + (node.children.length ? ' class="lead"' : '') + '>' + esc_(node.text));
    if (node.children.length) {
      out.push('<' + tag + ' class="sub">');
      node.children.forEach(function (c) { out.push('<li>' + esc_(c) + '</li>'); });
      out.push('</' + tag + '>');
    }
    out.push('</li>');
  });
  out.push('</' + tag + '>');
  return out.join('');
}


/** Template bodies are one item per line; blank lines separate paragraphs. */
function templateLines_(body) {
  return String(body || '').split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return l !== ''; });
}

/**
 * The active template for a section.
 *
 * A section can have a row for one stream and a general row for both. The specific one wins —
 * otherwise which text printed would depend on the order rows happen to sit in the sheet,
 * which is not a thing anyone should have to know.
 */
function quoteTemplate_(section, stream) {
  var rows = readTable_('QuoteTemplates').filter(function (t) {
    if (t.section !== section) return false;
    if (String(t.active).toUpperCase() === 'FALSE') return false;
    return !t.businessStream || t.businessStream === stream;
  });
  return rows.filter(function (t) { return t.businessStream === stream; })[0] || rows[0];
}

/**
 * The document's short phrases, one `key = value` per line in the Labels section.
 *
 * A column per phrase would have meant twenty columns and a migration every time one more
 * word turned out to be client-specific. This way the whole vocabulary of the document is one
 * editable block, and any key left out simply falls back to what the code would have said.
 */
function docLabels_(stream) {
  var out = {};
  // General first, then the stream's own on top: a spares offer needs its four different words
  // without having to restate the twenty it shares with every other offer.
  var rows = readTable_('QuoteTemplates').filter(function (t) {
    if (t.section !== 'Labels') return false;
    if (String(t.active).toUpperCase() === 'FALSE') return false;
    return !t.businessStream || t.businessStream === stream;
  }).sort(function (a, b) {
    return (a.businessStream ? 1 : 0) - (b.businessStream ? 1 : 0);
  });

  rows.forEach(function (tpl) {
    templateLines_(tpl.body).forEach(function (line) {
      var eq = line.indexOf('=');
      if (eq === -1) return;
      var key = line.slice(0, eq).trim();
      if (key) out[key] = line.slice(eq + 1).trim();
    });
  });
  return out;
}

function ddmmyyyy_(iso) {
  var p = String(iso || '').slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : String(iso || '');
}

/**
 * One line of address, the way it would be written on an envelope.
 *
 * The block used to stop at the city, which reads fine on screen and is short of what a
 * courier or a GST officer expects. State and PIN go on because an offer is a document that
 * gets filed, forwarded and occasionally posted — and because the fields are already on the
 * customer record, so leaving them out was losing information rather than saving space.
 */
function postalAddress_(address) {
  var parts = [address.line1, address.line2, address.city, address.state]
    .map(function (p) { return String(p === undefined || p === null ? '' : p).trim(); })
    .filter(Boolean);
  var line = parts.join(', ');
  var pin = String(address.pincode === undefined || address.pincode === null
    ? '' : address.pincode).trim();
  return pin ? (line ? line + ' - ' + pin : pin) : line;
}

/**
 * Renders the whole document. Returned to the screen for preview and handed to the PDF
 * converter unchanged, so what is previewed is what is sent.
 */
function buildQuotationHtml(quotationId) {
  getCurrentUser();

  var q = readTable_('Quotations').filter(function (r) {
    return String(r.id) === String(quotationId);
  })[0];
  if (!q) throw new Error('Quotation not found.');

  var co = getCompanyProfile();
  var stream = q.businessStream;
  var isCompressor = stream === STREAM_COMPRESSOR;

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(q.customerId);
  })[0] || {};
  var contact = readTable_('CustomerContacts').filter(function (c) {
    return String(c.id) === String(q.contactId);
  })[0] || {};
  // Refuses rather than prints a name over blank space; the message names the record to fix.
  requireQuoteAddress_(q);
  var address = resolveQuoteAddress_(q) || {};

  var items = readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(quotationId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });

  // Only the catalogues this offer actually quotes from, and only as much of them as the
  // document prints. A spares offer used to read every compressor in the Products tab and
  // every column of all 3,500 parts to look up five HSN codes.
  var hasType = {};
  items.forEach(function (i) { hasType[String(i.itemType)] = true; });

  // A compressor line prints a full specification table, so those rows are needed whole.
  var products = {};
  if (hasType.Product) {
    readTable_('Products').forEach(function (p) { products[String(p.id)] = p; });
  }
  // A spare line prints one thing off the master: its HSN code.
  var spareHsn = hasType.Spare ? columnMap_('Spares', 'id', 'hsnCode') : {};

  // One row, and only when the offer came from an enquiry at all.
  var enquiryNo = '';
  if (String(q.spareEnquiryId || '').trim()) {
    var se = findRowById_('SpareEnquiries', q.spareEnquiryId);
    enquiryNo = se ? String(se.enquiryNo || '') : '';
  }

  var preparer = readTable_('Users').filter(function (u) {
    return String(u.email).toLowerCase() === String(q.preparedBy).toLowerCase();
  })[0] || {};

  var labels = docLabels_(stream);
  /** A phrase from the Labels section, or what the code would have said. */
  var L = function (key, fallback) {
    return labels[key] === undefined || labels[key] === '' ? fallback : labels[key];
  };

  var out = [];
  var push = function (h) { out.push(h); };

  // ---------------------------------------------------------------- the page frame
  /**
   * Their letterhead is not a block at the top of the document — it is a page frame: our logo
   * and the principal's at the head of every page, the address and GST number in the footer of
   * every page. Ours used to be a block, inserted by hand wherever the code happened to start a
   * new section, which meant any page produced by text simply overflowing got nothing at all —
   * a sign-off marooned on a blank sheet with no indication of who sent it.
   *
   * A thead and a tfoot on a table wrapping the whole document is the portable way to say
   * "repeat this on every page"; the renderer handles it wherever the text actually breaks.
   */
  var pageHead = function () {
    return '<thead><tr><td>' +
      '<table class="lh"><tr>' +
        '<td class="lh-l">' +
          (co.logoUrl ? '<img src="' + esc_(co.logoUrl) + '" class="logo" />' : '') + '</td>' +
        '<td class="lh-r">' +
          (co.partnerLogoUrl ? '<img src="' + esc_(co.partnerLogoUrl) + '" class="partner-logo" />' : '') +
        '</td>' +
      '</tr></table>' +
      '</td></tr></thead>';
  };

  var pageFoot = function () {
    return '<tfoot><tr><td>' +
      '<div class="ft">' +
        (co.partnerLine ? '<div class="ft-partner">' + esc_(co.partnerLine).toUpperCase() + '</div>' : '') +
        // A wordmark already carries the name; setting it again reads as a mistake.
        (co.logoUrl && String(co.logoShowsName).toUpperCase() === 'TRUE'
          ? '' : '<div class="ft-name">' + esc_(co.legalName).toUpperCase() + '</div>') +
        '<div class="ft-line">Address: ' +
          esc_([co.addressLine1, co.addressLine2, co.city].filter(Boolean).join(' ')) +
          (co.pincode ? '-' + esc_(co.pincode) : '') + '</div>' +
        '<div class="ft-line">' +
          (co.email ? 'Email: ' + esc_(co.email) : '') +
          (co.phone ? ', Mobile: ' + esc_(co.phone) : '') +
          (co.website ? ', ' + esc_(co.website) : '') + '</div>' +
        (co.gstin ? '<div class="ft-line">' + esc_(L('gstNo', 'GST No')) + ': ' +
          esc_(co.gstin) + '</div>' : '') +
      '</div>' +
      '</td></tr></tfoot>';
  };

  // The seal prints only if one is configured. This client stamps the paper by hand, so the
  // field is blank and the block simply leaves room for it.
  var signoff = function () {
    return '<div class="signoff">' +
      '<div>' + esc_(co.signOffLine || 'Yours sincerely,') + '</div>' +
      '<div class="for">For ' + esc_(co.legalName) + '</div>' +
      (co.sealUrl ? '<div><img src="' + esc_(co.sealUrl) + '" class="seal" /></div>'
                  : '<div class="sig-space"></div>') +
      '<div><b>' + esc_(preparer.name || '') + '</b>' +
        (preparer.designation || preparer.role
          ? ' | ' + esc_(preparer.designation || preparer.role) : '') + '</div>' +
      (co.signOffPhone ? '<div>M: ' + esc_(co.signOffPhone) + '</div>' : '') +
      // The company's address, never the preparer's. It used to print whichever address the
      // coordinator's user record carried, which on this installation is a personal one — so
      // every offer that went out published an employee's private e-mail to a customer, and
      // a reply to it reached one person's inbox rather than the office.
      (co.email ? '<div>E: ' + esc_(co.email) + '</div>' : '') +
      '</div>';
  };

  // The document names itself. Browsers stamp the page title into the print margin, and
  // without one it stamps whatever the application is called — which put "ELGi Spares ERP"
  // above a compressor offer. The quotation number is what belongs there.
  var docTitle = String(q.quoteNo || 'Quotation') +
    (q.revision && q.revision !== 'R0' ? ' ' + q.revision : '');
  push('<html><head><meta charset="UTF-8" /><title>' + esc_(docTitle) + '</title>' +
    quotationCss_(co) + '</head><body>');
  push('<table class="page">');
  push(pageHead());
  push(pageFoot());
  push('<tbody><tr><td>');

  // ---------------------------------------------------------------- page 1: the letter
  var titleTpl = quoteTemplate_('DocumentTitle', stream);
  if (titleTpl) {
    if (titleTpl.title) push('<div class="doc-title">' + esc_(titleTpl.title) + '</div>');
    if (titleTpl.body) push('<div class="doc-sub">' + esc_(String(titleTpl.body).trim()) + '</div>');
  }

  push('<table class="refbar"><tr>' +
    '<td><b>' + esc_(L('refNo', 'Ref No.')) + ':</b> ' + esc_(q.quoteNo) +
      (q.revision && q.revision !== 'R0' ? ' <b>(' + esc_(q.revision) + ')</b>' : '') + '</td>' +
    '<td class="right"><b>' + esc_(L('dated', 'Dated')) + ':</b> ' +
      esc_(ddmmyyyy_(q.date)) + '</td>' +
    // The customer's own request, quoted back at them. They rang about something and this is
    // the answer to it; naming the enquiry is what lets either side tie the two together
    // weeks later, and it is the number PIE's own staff search by.
    (enquiryNo
      ? '</tr><tr><td colspan="2"><b>' + esc_(L('enquiryNo', 'Enquiry No.')) + ':</b> ' +
        esc_(enquiryNo) + '</td>'
      : '') +
    '</tr></table>');

  push('<div class="to">To,<br />' +
    '<b>M/s. ' + esc_(customer.name) + '</b><br />' +
    (address.line1 ? esc_(postalAddress_(address)) + '<br />' : '') +
    (contact.name
      ? esc_(L('attention', 'Kind Attention')) + ': ' + esc_(plainName_(contact.name)) + '<br />'
      : '') +
    (contact.phone ? esc_(L('mobile', 'Mobile No')) + ': ' + esc_(contact.phone) + '<br />' : '') +
    (contact.email ? esc_(L('email', 'Email Id')) + ': ' + esc_(contact.email) : '') +
    '</div>');

  var cover = quoteTemplate_('CoverLetter', stream);
  if (cover) {
    if (cover.title) {
      push('<div class="subject"><b>' + esc_(L('subject', 'Subject')) + ':</b> ' +
        esc_(cover.title) + '</div>');
    }
    push('<div class="salut">' + esc_(co.salutation || 'Dear Sir/Madam,') + '</div>');
    String(cover.body).split('\n\n').forEach(function (para) {
      if (para.trim()) push('<p>' + esc_(para.trim()) + '</p>');
    });
  }

  // Every machine on the offer gets a specification table, whether or not its specifications
  // are on file. Printing only the ones that were filled in hid the gap: a missing table is
  // invisible, and nobody goes looking for a page that was never there. A table with empty
  // rows is a to-do that the next person to read the offer will act on.
  var specced = items.filter(function (i) {
    return i.itemType === 'Product' && products[String(i.itemId)];
  });

  var why = quoteTemplate_('WhyBrand', stream);
  if (why) {
    push('<div class="h2">' + esc_(why.title) + '</div>');
    push(bulletList_(templateLines_(why.body), false));
  }

  // What follows, so the reader knows the offer is more than one page. Each entry is listed
  // only if that section will actually be printed — promising an enclosure that is not there
  // is worse than omitting it.
  var scopeTpl = quoteTemplate_('ScopeOfSupply', stream);
  var enclosures = [];
  if (specced.length && scopeTpl) {
    enclosures.push(L('enclSpecScope', 'Technical specifications and scope of supply'));
  } else if (specced.length) {
    enclosures.push(L('enclSpec', 'Technical specifications'));
  } else if (scopeTpl) {
    enclosures.push(L('scopeHeading', 'Scope of supply'));
  }
  enclosures.push(L('enclPrice', 'Price schedule'));
  if (quoteTemplate_('Terms', stream)) enclosures.push(L('enclTerms', 'Commercial terms and conditions'));
  if (isCompressor && quoteTemplate_('InstallationNotes', stream)) {
    enclosures.push(L('enclInstall', 'Installation guidelines'));
  }
  // Documents that travel with the offer but are not generated by it — the UPTIME Assurance
  // annexure above all, which is ELGi's own and comes as it is. Listed here so the reader is
  // told what is in the envelope, which is the whole point of this list.
  if (isCompressor && quoteTemplate_('UptimeWarranty', stream)) {
    enclosures.push(L('enclUptime', 'UPTIME Warranty'));
  }
  var extraEncl = quoteTemplate_('ExtraEnclosures', stream);
  if (extraEncl) {
    templateLines_(extraEncl.body).forEach(function (line) {
      // The annexure prints now, so the standing "attached separately" list must not name it
      // a second time.
      if (enclosures.indexOf(line) === -1) enclosures.push(line);
    });
  }
  push('<div class="h2">' + esc_(L('enclosures', 'Please find enclosed with this offer')) +
    '</div><ul>');
  enclosures.forEach(function (e) { push('<li>' + esc_(e) + '</li>'); });
  push('</ul>');

  var closing = quoteTemplate_('Closing', stream);
  if (closing) {
    String(closing.body).split('\n\n').forEach(function (para) {
      if (para.trim()) push('<p>' + esc_(para.trim()) + '</p>');
    });
  }
  push(signoff());

  // ---------------------------------------------------------------- specifications
  if (specced.length) {
    push('<div class="page-break"></div>');
    push('<div class="h1">' + esc_(L('specHeading', 'Technical specifications')) + '</div>');
    var specNote = quoteTemplate_('SpecNote', stream);
    if (specNote) push('<div class="note">' + esc_(String(specNote.body).trim()) + '</div>');
    specced.forEach(function (i) {
      var p = products[String(i.itemId)];
      // Every row every time, blanks included. An empty cell is the prompt to go and fill it;
      // dropping the row leaves the offer looking complete when it is not.
      var rows = [
        ['Model', p.model || p.productCode],
        [L('specCapacity', 'Capacity'), p.capacityCfm],
        [L('specMaxPressure', 'Maximum pressure'), p.maxPressure],
        [L('specWorkPressure', 'Normal working pressure'), p.workingPressure],
        [L('specMotor', 'Main motor nominal rating'), p.motorKw],
        [L('specStarter', 'Starter'), p.starterType],
        [L('specDimensions', 'Dimensions'), p.dimensionsMm],
        [L('specWeight', 'Weight of the package'), p.weightKg]
      ];

      push('<div class="spec-title">' + esc_(p.model || p.productCode) + '</div>');
      push('<table class="spec"><tr><th>' + esc_(L('colDescription', 'Description')) +
        '</th><th>' + esc_(L('colSpecification', 'Specifications')) + '</th></tr>');
      rows.forEach(function (r) {
        var value = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
        push('<tr><td>' + esc_(r[0]) + '</td>' +
          (value ? '<td>' + esc_(value) + '</td>'
                 : '<td class="spec-blank">&nbsp;</td>') + '</tr>');
      });
      push('</table>');
    });
  }

  if (scopeTpl) {
    push('<div class="h1">' + esc_(scopeTpl.title || L('scopeHeading', 'Scope of supply')) + '</div>');
    templateLines_(scopeTpl.body).forEach(function (l) {
      // A line ending in a colon is a heading for the block beneath it.
      push(/:$/.test(l) ? '<div class="scope-head">' + esc_(l) + '</div>'
                        : '<div class="scope-line">' + esc_(l) + '</div>');
    });
  }

  // ---------------------------------------------------------------- price schedule
  // A compressor offer arrives here after pages of specification, so the schedule starts a
  // page of its own. A spares offer arrives after a single covering letter, and forcing the
  // break there cost two pages: the letter ended a third of the way down one page and the
  // annexure a third of the way down another, so a two-page offer printed as four. It flows
  // now, and the pieces that must not be split say so for themselves.
  if (isCompressor) push('<div class="page-break"></div>');
  push('<div class="h1">' + esc_(L('priceHeading', 'Price schedule')) + '</div>');

  // The machine the parts belong to. A spare part is meaningless without it — their own spares
  // offer opens the annexure with these two lines, and we were holding both and printing
  // neither.
  // Their spares annexure opens with these two, and prints them empty when the counter has
  // not been told the machine yet — "FAB NO :-" with nothing after it. Printing the rows only
  // when they are filled hid the gap: an offer for parts that never says which machine they
  // fit looks complete, and nobody chases what was never on the page.
  if (!isCompressor) {
    push('<table class="spec" style="margin-bottom:10px;">' +
      '<tr><td>' + esc_(L('fabNo', 'Fab No')) + '</td>' +
      (q.serialNo ? '<td>' + esc_(q.serialNo) + '</td>'
                  : '<td class="spec-blank">&nbsp;</td>') + '</tr>' +
      '<tr><td>' + esc_(L('modelNo', 'Model No')) + '</td>' +
      (q.machineModel ? '<td>' + esc_(q.machineModel) + '</td>'
                      : '<td class="spec-blank">&nbsp;</td>') + '</tr>' +
      '</table>');
  }


  /*
   * The two documents schedule prices differently, and each is right for what it sells.
   *
   * A compressor offer lists a handful of machines at a basic price, with the tax rate shown
   * per line because the package is quoted before tax. A spares offer is a parts list: the
   * customer checks it against their machine, so the part number leads and each line carries
   * its own extended total. Following the compressor layout for spares would drop the part
   * number, which is the one column a storeman actually reads.
   */
  var priceCols = isCompressor
    ? [L('colDescription', 'Description'), L('colBasicPrice', 'Basic price'),
       L('colQty', 'Qty'), L('colUnit', 'Unit'), L('colHsn', 'HSN code'),
       L('colTaxRate', 'Tax rate')]
    // The HSN code and the unit belong with what is being sold, before the money starts: a
    // storeman reads left to right and stops once the figures begin. The HSN used to sit in
    // the last column, past the totals, where it read as an afterthought on a tax document.
    : [L('colPartNo', 'Part Number'), L('colDescription', 'Description'),
       L('colHsn', 'HSN code'), L('colUom', 'Unit of measurement'),
       L('colPricePer', 'Price Per'), L('colQuantity', 'Quantity'),
       L('colTotalAmount', 'Total Amount')];

  push('<table class="price"><thead><tr>' +
    (isCompressor
      ? '<th class="w-desc">' + esc_(priceCols[0]) + '</th>' +
        '<th class="num">' + esc_(priceCols[1]) + '</th>' +
        '<th class="num">' + esc_(priceCols[2]) + '</th>' +
        '<th>' + esc_(priceCols[3]) + '</th>' +
        '<th>' + esc_(priceCols[4]) + '</th>' +
        '<th class="num">' + esc_(priceCols[5]) + '</th>'
      : '<th class="w-part">' + esc_(priceCols[0]) + '</th>' +
        '<th class="w-desc">' + esc_(priceCols[1]) + '</th>' +
        '<th>' + esc_(priceCols[2]) + '</th>' +
        '<th>' + esc_(priceCols[3]) + '</th>' +
        '<th class="num">' + esc_(priceCols[4]) + '</th>' +
        '<th class="num">' + esc_(priceCols[5]) + '</th>' +
        '<th class="num">' + esc_(priceCols[6]) + '</th>') +
    '</tr></thead><tbody>');

  var gross = 0;
  // What this customer calls each part, looked up once rather than per line. Resolved
  // here rather than stored on the line, so correcting a mapping corrects the offers
  // that have not gone out yet.
  var theirCodes = customerCodeMap_(q.customerId);
  items.forEach(function (i) {
    var isCharge = i.lineType === 'Charge';
    var qty = Number(i.qty) || 0;
    var unit = Number(i.unitPrice) || 0;
    var lineTotal = unit * qty;
    gross += lineTotal;
    var hsn = isCharge ? '' : esc_(hsnFor_(i, products, spareHsn));

    push('<tr>' + (isCompressor
      ? '<td>' + esc_(i.description || i.itemCode) + '</td>' +
        '<td class="num">' + inr_(unit) + '</td>' +
        '<td class="num">' + esc_(qty) + '</td>' +
        '<td>' + esc_(i.uom || 'No') + '</td>' +
        '<td>' + (hsn || '—') + '</td>' +
        '<td class="num">' + (isCharge ? '—' : esc_((Number(i.taxPct) || 0).toFixed(2)) + '%') + '</td>'
      // A charge has no part number and no extended rate — it is simply an amount.
      : '<td class="mono">' + (isCharge ? '' : esc_(i.itemCode) +
          // Their own code under ours, where they have one. Their stores department receipts
          // goods against the code on their purchase order, not against ELGi's.
          (theirCodes[i.itemType + '|' + i.itemId]
            ? '<div class="their-code">' +
              esc_(theirCodes[i.itemType + '|' + i.itemId].theirCode) + '</div>'
            : '')) + '</td>' +
        '<td>' + esc_(i.description || i.itemCode) + '</td>' +
        '<td>' + hsn + '</td>' +
        // A charge is an amount, not a quantity of anything, so it has no unit either.
        '<td>' + (isCharge ? '' : esc_(i.uom || 'Nos')) + '</td>' +
        '<td class="num">' + (isCharge ? '' : inr_(unit)) + '</td>' +
        '<td class="num">' + (isCharge ? '' : esc_(qty)) + '</td>' +
        '<td class="num">' + inr_(lineTotal) + '</td>') +
      '</tr>');
  });

  // Totals, laid out the way their offer lays them out: everything listed at full price, one
  // percentage struck off the whole package, then P&F, freight and the tax note.
  var pkgPct = Number(q.packageDiscountPct) || 0;
  // recalcQuotation_ stores line discounts and the package discount together, so the net of
  // both is what the customer pays for goods.
  var netGoods = gross - (Number(q.discountAmt) || 0);
  var totals = [];
  totals.push([esc_(L('packageTotal', 'Total package price')), inr_(gross), pkgPct > 0 ? '' : 'strong']);
  if (pkgPct > 0) {
    totals.push([esc_(L('discountedTotal', 'Total discounted price')) +
      ' (' + pkgPct + '% less)', inr_(netGoods), 'strong']);
  }
  // Their compressor offer states P&F and freight even when nil, because those are negotiated
  // on a machine. Their spares offer omits them entirely and folds carting into a line.
  if (isCompressor || Number(q.pfAmount) > 0) {
    totals.push([esc_(L('pf', 'P&F')), Number(q.pfAmount) > 0 ? inr_(q.pfAmount) : 'NIL', '']);
  }
  // Freight terms, not the delivery time. This printed q.deliveryTerms, so a compressor offer
  // read "Freight: 4-6 weeks" where theirs reads "Extra from Ex-works Coimbatore" — a delivery
  // promise standing in for a freight condition. The wording is standing text, so it lives
  // with the rest of the document's wording rather than being typed per quotation. Their
  // spares offer has no freight row at all: carting is a line and term 2 covers the rest.
  if (isCompressor) {
    totals.push([esc_(L('freight', 'Freight')),
                 esc_(L('freightNote', 'Extra at actuals')), '']);
  }

  // The row reading "18% GST" on a compressor offer and "Total Tax 18%" on a spares one — same
  // figure, their two documents word it differently, so the wording is a label with the rate
  // substituted into it.
  var taxRow = esc_(L('taxRow', '{rate}% GST')).replace('{rate}', esc_(headlineTaxRate_(items)));
  // Their two offers differ here, and not by accident. A compressor offer writes "18% GST
  // EXTRA" with no figure: the machine price is negotiated and GST is charged at the rate
  // prevailing on the date of dispatch, so a number printed today would be wrong by then.
  // A spares offer is a firm total the customer raises a purchase order against, so it states
  // the tax and the amount payable — theirs reads "Total Tax 18% 51001.74" and
  // "Total Amount 334344.74" even though its own term 1 says GST is extra on the basic value.
  var taxExtra = String(q.taxMode || 'Extra') === 'Extra';
  if (isCompressor && taxExtra) {
    totals.push([taxRow, esc_(L('taxExtra', 'EXTRA')), '']);
  } else {
    // GST split the way a tax document has to split it: CGST and SGST between two places in
    // the same state, IGST across a border. One "Total Tax 18%" line said the right amount
    // and the wrong thing — the customer's accounts cannot post it, and their purchase order
    // is raised off this page.
    gstRows_(q, co, address, items).forEach(function (r) { totals.push(r); });
    // What the customer will actually pay. This printed q.grand, which excludes the tax when
    // the offer quotes GST as extra — so the page listed the tax and then a total that
    // ignored it, and the figure a purchase order would be raised against was short by the
    // GST. The stored figure is left alone; this is the arithmetic the page has to show.
    totals.push([esc_(L('grandTotal', 'Total amount')), inr_(payableTotal_(q)), 'strong']);
  }

  // One table, not two. The items and the totals were separate tables, so the money did not
  // line up under the money and the last row of one sat beside the first row of the other.
  // On the spares annexure the totals are now rows of the same grid; the compressor offer
  // keeps its own block, which is how their machine quotation is laid out.
  if (isCompressor) {
    push('</tbody></table>');
    push('<table class="totals">');
    totals.forEach(function (t) {
      push('<tr class="' + t[2] + '"><td>' + t[0] + '</td><td class="num">' + t[1] + '</td></tr>');
    });
    push('</table>');
  } else {
    totals.forEach(function (t) {
      push('<tr class="' + t[2] + '"><td class="tot-label" colspan="6">' + t[0] + '</td>' +
        '<td class="num">' + t[1] + '</td></tr>');
    });
    push('</tbody></table>');
  }

  // ---------------------------------------------------------------- terms
  var terms = quoteTemplate_('Terms', stream);
  if (terms) {
    // The standing terms carry a validity clause in general words; this quotation knows the
    // actual number of days and the actual date. Rather than print both and contradict
    // ourselves, the concrete one replaces the clause where it appears.
    var validity = 'Validity: this offer is valid for ' + (q.validityDays || 30) +
      ' days from the date of offer' +
      (q.validUntil ? ' (until ' + ddmmyyyy_(q.validUntil) + ')' : '') + '.';
    var statedValidity = false;
    push('<div class="h1">' + esc_(terms.title || L('termsHeading', 'Terms & conditions')) +
      '</div>');
    push(bulletList_(templateLines_(terms.body).map(function (l) {
      if (/^validity\b/i.test(l)) { statedValidity = true; return validity; }
      return l;
    }), true));
    if (!statedValidity) push('<div class="note">' + esc_(validity) + '</div>');
  }

  // They close twice, and differently: the letter ends by inviting questions, the terms end by
  // asking for a meeting. Printing the first one again in the second place loses that.
  var closingFinal = quoteTemplate_('ClosingFinal', stream);
  if (closingFinal) {
    String(closingFinal.body).split('\n\n').forEach(function (para) {
      if (para.trim()) push('<p>' + esc_(para.trim()) + '</p>');
    });
  }
  push(signoff());

  // ---------------------------------------------------------------- installation
  var install = quoteTemplate_('InstallationNotes', stream);
  if (install && isCompressor) {
    push('<div class="page-break"></div>');
    push('<div class="h1">' + esc_(install.title) + '</div>');
    push(bulletList_(templateLines_(install.body), true));
  }

  // ---------------------------------------------------------------- UPTIME warranty
  // ELGi's annexure, printed rather than attached. It is a page that gets filled in by hand
  // and signed by both sides at commissioning, so the fields print as ruled blanks: an
  // attachment nobody can sign is worth nothing, which is why it is here at all.
  var uptime = quoteTemplate_('UptimeWarranty', stream);
  if (uptime && isCompressor) {
    push('<div class="page-break"></div>');
    push('<div class="h1">' + esc_(uptime.title) + '</div>');
    templateLines_(uptime.body).forEach(function (l) {
      if (/^#\s+/.test(l)) {
        // A field completed by hand: the label, then a rule to write on.
        push('<div class="fillin"><span>' + esc_(l.replace(/^#\s+/, '')) +
          '</span><span class="rule"></span></div>');
      } else if (/:$/.test(l)) {
        push('<div class="scope-head">' + esc_(l) + '</div>');
      } else {
        push('<div class="uptime-line">' + esc_(l) + '</div>');
      }
    });
  }

  push('</td></tr></tbody></table>');
  push('</body></html>');
  return out.join('\n');
}

/**
 * The single headline rate their offers quote, as a bare number: "18", not "18.00".
 *
 * Both their documents write "18% GST"; we were printing "18.00% GST", which is the sort of
 * detail nobody asks you to fix and everybody notices.
 */
/**
 * The GST rows: CGST and SGST inside one state, IGST across a border.
 *
 * Which of the two applies is the place of supply — where the goods are going against where
 * they are coming from. The GSTIN is the reliable comparison, since its first two digits are
 * the state code and a state typed by hand can be spelt three ways; the spelling is the
 * fallback. When the customer's state cannot be established at all the tax stays as one line
 * rather than guessing, because naming the wrong pair of taxes on a document somebody posts
 * into their books is worse than not splitting it.
 */
function gstRows_(q, co, address, items) {
  var rate = Number(headlineTaxRate_(items)) || 0;
  var tax = Number(q.taxAmt) || 0;
  var oneLine = [esc_(String(rate) + '% GST'), inr_(tax), ''];

  // Like compared with like. A GSTIN's first two digits and a state's name are both ways of
  // saying where somebody is, but "27" is not "maharashtra" — comparing one against the other
  // makes every customer look like a different state and puts IGST on a local sale.
  var us = placeOf_(co.gstin, co.state);
  var them = placeOf_(q.customerGstin, address && address.state);
  var same;
  if (us.code && them.code) same = us.code === them.code;
  else if (us.name && them.name) same = us.name === them.name;
  else return [oneLine];

  var half = function (n) { return Math.round(n * 50) / 100; };
  if (same) {
    // Halved from the total rather than recomputed, so the two halves always add back to the
    // tax the rest of the document shows.
    var cg = half(tax);
    return [
      ['CGST ' + esc_(String(rate / 2)) + '%', inr_(cg), ''],
      ['SGST ' + esc_(String(rate / 2)) + '%', inr_(tax - cg), '']
    ];
  }
  return [['IGST ' + esc_(String(rate)) + '%', inr_(tax), '']];
}

/**
 * A person's name as it should be printed: the name, without the honorific in front of it.
 *
 * Contacts are typed in as "Mr Rajesh Pathak" or "Shri R. Pathak" as often as not, and the
 * offer already labels the line — "Kind Attention: Mr Rajesh Pathak" reads as a form letter
 * rather than a letter to somebody. Only a leading title is removed, and only when a name
 * follows it, so "Mr" as somebody's whole entry is left alone rather than erased.
 */
function plainName_(name) {
  var n = String(name || '').trim();
  var stripped = n.replace(
    /^(mr|mrs|ms|miss|shri|shrimati|smt|sri|dr|prof|capt|col|er)\.?\s+/i, '');
  return stripped.trim() || n;
}

/**
 * Where somebody is, said both ways: the state code off their GSTIN, and their state's name
 * folded down. "Maharashtra", "MAHARASHTRA" and "maharashtra " are one state, and
 * 27AAHFP1707A1ZQ says the same thing without depending on anybody's spelling.
 */
function placeOf_(gstin, stateName) {
  var g = String(gstin || '').trim();
  return {
    code: /^[0-9]{2}/.test(g) ? g.slice(0, 2) : '',
    name: String(stateName || '').trim().toLowerCase().replace(/\s+/g, ' ')
  };
}

function headlineTaxRate_(items) {
  var rates = {};
  items.forEach(function (i) {
    if (i.lineType === 'Charge') return;
    var r = Number(i.taxPct) || 0;
    rates[r] = (rates[r] || 0) + 1;
  });
  var keys = Object.keys(rates);
  var rate = keys.length
    ? Number(keys.sort(function (a, b) { return rates[b] - rates[a]; })[0])
    : 18;
  return String(Number(rate.toFixed(2)));
}

/**
 * The HSN code, from the item master.
 *
 * A quotation line does not carry one — the master is the only place it is maintained, and
 * copying it onto the line would let the two drift. Both catalogs are passed in already read,
 * so a twenty-line offer does not read the sheet twenty times.
 */
function hsnFor_(item, products, spareHsn) {
  if (item.itemType === 'Product') {
    var rec = products[String(item.itemId)];
    return rec ? (rec.hsnCode || '') : '';
  }
  return spareHsn[String(item.itemId)] || '';
}

/**
 * Converts the document to a PDF in the user's Drive and hands back a link.
 *
 * Apps Script runs this as the person clicking it, so the file lands in their own Drive and
 * is theirs to share — the app never becomes a place documents get stranded. The first run
 * asks for Drive permission, which is expected and only needs granting once.
 */
function generateQuotationPdf(quotationId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var q = readTable_('Quotations').filter(function (r) {
    return String(r.id) === String(quotationId);
  })[0];
  if (!q) throw new Error('Quotation not found.');

  var html = buildQuotationHtml(quotationId);
  var safeName = String(q.quoteNo).replace(/[\/\\:*?"<>|]/g, '-');
  var name = safeName + (q.revision && q.revision !== 'R0' ? ' ' + q.revision : '') + '.pdf';

  var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);

  var folders = DriveApp.getFoldersByName(QUOTE_PDF_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(QUOTE_PDF_FOLDER);
  var file = folder.createFile(pdf);

  audit_('Print', 'Quotations', quotationId, 'pdf', '', name, 'Quotation PDF generated');

  // The file itself goes back with the answer, not only a link to it.
  //
  // The script runs as its owner, and people sign in to the portal with a username rather
  // than a Google account — so the Drive copy belongs to an account the coordinator who asked
  // for it cannot open. A link to it offers them a "Request access" page instead of their own
  // quotation. The Drive copy stays as the company's record; the bytes are what the person
  // gets.
  return { name: name, url: file.getUrl(), downloadUrl: file.getDownloadUrl(),
           bytes: Utilities.base64Encode(pdf.getBytes()) };
}

/** Plain CSS on purpose — the PDF converter ignores flexbox, grid and most modern layout. */
/** Plain CSS on purpose — the PDF converter ignores flexbox, grid and most modern layout. */
function quotationCss_(co) {
  var accent = String((co && co.docAccentColor) || '#C00000').trim() || '#C00000';
  return '<style>' +
    '@page{size:A4;margin:10mm 12mm;}' +
    // Verdana at 10pt, which is what PIE's own offers are set in. Geneva and the generic
    // sans-serif stand behind it for the PDF converter, which embeds only the fonts it has.
    'body{font-family:Verdana,Geneva,sans-serif;font-size:10pt;color:#111;line-height:1.32;margin:0;}' +

    // The page frame. thead and tfoot on this table are what repeat on every page.
    'table.page{width:100%;border-collapse:collapse;}' +
    'table.page > tbody > tr > td{padding:14px 0 0;vertical-align:top;}' +
    'table.page > thead > tr > td{padding:0;}' +
    'table.page > tfoot > tr > td{padding:0;}' +

    // The customer's own code, under ours in the part-number cell: quieter than the part
    // number, because it is a cross-reference rather than what we are selling.
    '.their-code{font-size:8.5pt;color:#555;margin-top:1px;}' +

    '.lh{width:100%;border-collapse:collapse;}' +
    '.lh td{padding:0;vertical-align:middle;}' +
    '.lh-l{text-align:left;width:50%;}' +
    '.lh-r{text-align:right;width:50%;}' +
    '.logo{max-height:144px;max-width:210px;}' +  // 144px = 108pt, theirs exactly
    '.partner-logo{max-height:80px;max-width:160px;}' +

    '.ft{border-top:1px solid #222;margin-top:10px;padding-top:4px;text-align:center;}' +
    '.ft-partner{font-size:8.5pt;color:' + accent + ';text-decoration:underline;}' +
    '.ft-name{font-size:11pt;font-weight:bold;letter-spacing:.3px;}' +
    '.ft-line{font-size:8.5pt;color:#222;}' +

    '.doc-title{font-size:12pt;font-weight:bold;color:' + accent + ';margin:4px 0 10px;}' +
    '.doc-sub{font-size:11pt;font-weight:bold;margin:0 0 12px;}' +
    '.refbar{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:10pt;}' +
    '.refbar td{padding:0;}' +
    '.right{text-align:right;}' +
    '.to{margin-bottom:12px;font-size:10pt;}' +
    '.subject{margin:12px 0 8px;}' +
    '.salut{margin-bottom:8px;}' +
    'p{margin:0 0 7px;text-align:justify;}' +
    '.h1{font-size:11.5pt;font-weight:bold;color:' + accent + ';margin:11px 0 6px;page-break-after:avoid;}' +
    '.h2{font-size:10.5pt;font-weight:bold;color:' + accent + ';margin:10px 0 5px;page-break-after:avoid;}' +
    'ul,ol{margin:0 0 7px;padding-left:26px;}' +   // 18px clipped the '10.' on a two-digit list
    'li{margin-bottom:4px;text-align:justify;}' +
    // Theirs marks the heading with a hollow bullet and the points under it with a filled
    // one — the reverse of a browser's default nesting — and does not indent the children.
    'ul{list-style-type:circle;}' +
    // The weight must not run on into the points beneath the heading.
    'ul.sub{list-style-type:disc;margin:4px 0 4px;padding-left:16px;font-weight:normal;}' +
    'ol.sub{margin:4px 0 4px;padding-left:22px;list-style-type:lower-alpha;}' +
    'ul > li.lead{font-weight:bold;}' +
    '.note{font-size:9pt;color:#444;margin:8px 0 12px;font-style:italic;}' +

    '.spec-title{font-weight:bold;margin:14px 0 5px;}' +
    'table.spec{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:10pt;}' +
    'table.spec th{background:#eee;text-align:left;padding:5px 8px;border:1px solid #999;}' +
    'table.spec td{padding:5px 8px;border:1px solid #999;}' +
    // An empty specification keeps its row and its box, so the gap is obvious on the page
    // rather than closing up as if the line had never existed.
    '.spec-blank{background:#FCFCFC;}' +
    // The annexure runs long, so it is set a point smaller than the rest of the offer; the
    // fill-in rules are what make it a form rather than a leaflet.
    '.uptime-line{margin:2px 0;font-size:9pt;text-align:justify;}' +
    '.fillin{display:flex;align-items:flex-end;gap:8px;margin:7px 0 2px;font-size:9.5pt;}' +
    '.fillin .rule{flex:1;border-bottom:1px solid #333;height:11px;}' +
    '.scope-head{font-weight:bold;margin:10px 0 3px;}' +
    '.scope-line{margin-left:12px;font-size:10pt;}' +

    'table.price{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:10pt;}' +
    'table.price th{background:#eee;padding:4px 7px;border:1px solid #999;text-align:left;}' +
    'table.price td{padding:4px 7px;border:1px solid #999;}' +
    // A part whose description carries on overleaf reads as a printing fault, so a row moves
    // to the next page whole. The heading row is a thead, so it repeats above it.
    'table.price tr{page-break-inside:avoid;}' +
    '.w-desc{width:42%;}' +
    '.w-part{width:18%;}' +
    // A totals row inside the price grid: the label runs across the columns the figures do
    // not need, and the amount lands under the amounts.
    'table.price td.tot-label{text-align:right;font-weight:bold;}' +
    'table.price tr.strong td{font-weight:bold;background:#f2f2f2;}' +
    'table.machine{border-collapse:collapse;margin-bottom:10px;font-size:10pt;}' +
    'table.machine td{border:1px solid #999;padding:4px 10px;}' +
    'table.machine td:first-child{font-weight:bold;background:#eee;}' +
    '.num{text-align:right;}' +
    'table.totals{width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:8px;}' +
    'table.totals td{padding:4px 7px;border:1px solid #999;}' +
    'table.totals tr.strong td{font-weight:bold;background:#f2f2f2;}' +

    // A signature split across a page break reads as a printing fault, so it moves whole.
    '.signoff{margin-top:14px;font-size:10pt;page-break-inside:avoid;}' +
    '.signoff .for{margin-top:4px;font-weight:bold;}' +
    '.sig-space{height:26px;}' +
    '.seal{max-height:80px;margin:6px 0;}' +
    'table.totals{page-break-inside:avoid;}' +
    '.page-break{page-break-before:always;}' +
    '</style>';
}

