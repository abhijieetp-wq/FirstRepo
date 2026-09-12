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

/** Indian digit grouping: 13,16,600.00 rather than 1,316,600.00. */
function inr_(n) {
  var v = Math.abs(Number(n) || 0).toFixed(2);
  var parts = v.split('.');
  var whole = parts[0];
  var last3 = whole.length > 3 ? whole.slice(-3) : whole;
  var rest = whole.length > 3 ? whole.slice(0, -3) : '';
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (Number(n) < 0 ? '-' : '') + '₹ ' + rest + last3 + '.' + parts[1];
}

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Template bodies are one item per line; blank lines separate paragraphs. */
function templateLines_(body) {
  return String(body || '').split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return l !== ''; });
}

function quoteTemplate_(section, stream) {
  return readTable_('QuoteTemplates').filter(function (t) {
    if (t.section !== section) return false;
    if (String(t.active).toUpperCase() === 'FALSE') return false;
    return !t.businessStream || t.businessStream === stream;
  })[0];
}

/**
 * The document's short phrases, one `key = value` per line in the Labels section.
 *
 * A column per phrase would have meant twenty columns and a migration every time one more
 * word turned out to be client-specific. This way the whole vocabulary of the document is one
 * editable block, and any key left out simply falls back to what the code would have said.
 */
function docLabels_(stream) {
  var tpl = quoteTemplate_('Labels', stream);
  var out = {};
  if (!tpl) return out;
  templateLines_(tpl.body).forEach(function (line) {
    var eq = line.indexOf('=');
    if (eq === -1) return;
    var key = line.slice(0, eq).trim();
    if (key) out[key] = line.slice(eq + 1).trim();
  });
  return out;
}

function ddmmyyyy_(iso) {
  var p = String(iso || '').slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : String(iso || '');
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
  var address = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.id) === String(q.billingAddressId);
  })[0] || {};

  var items = readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(quotationId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });

  var products = {};
  readTable_('Products').forEach(function (p) { products[String(p.id)] = p; });
  var spares = {};
  readTable_('Spares').forEach(function (p) { spares[String(p.id)] = p; });

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
      (co.signOffPhone ? '<div>P: ' + esc_(co.signOffPhone) + '</div>' : '') +
      '</div>';
  };

  push('<html><head><meta charset="UTF-8" />' + quotationCss_(co) + '</head><body>');
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
    '</tr></table>');

  push('<div class="to">To,<br />' +
    '<b>M/s. ' + esc_(customer.name) + '</b><br />' +
    (address.line1 ? esc_([address.line1, address.line2, address.city].filter(Boolean).join(', ')) + '<br />' : '') +
    (contact.name ? esc_(L('attention', 'Kind Attention')) + ': ' + esc_(contact.name) + '<br />' : '') +
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

  // Only machines with specifications on file get a specification table; the enclosure list
  // above needs to know that before the letter is written.
  var specced = items.filter(function (i) {
    var p = products[String(i.itemId)];
    return i.itemType === 'Product' && p && (p.capacityCfm || p.motorKw || p.maxPressure);
  });

  var why = quoteTemplate_('WhyBrand', stream);
  if (why) {
    push('<div class="h2">' + esc_(why.title) + '</div><ul>');
    templateLines_(why.body).forEach(function (l) { push('<li>' + esc_(l) + '</li>'); });
    push('</ul>');
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
      var rows = [
        ['Model', p.model || p.productCode],
        ['Capacity', p.capacityCfm],
        ['Maximum pressure', p.maxPressure],
        ['Normal working pressure', p.workingPressure],
        ['Main motor nominal rating', p.motorKw],
        ['Starter', p.starterType],
        ['Dimensions', p.dimensionsMm],
        ['Weight of the package', p.weightKg]
      ].filter(function (r) { return String(r[1] || '').trim() !== ''; });

      push('<div class="spec-title">' + esc_(p.model || p.productCode) + '</div>');
      push('<table class="spec"><tr><th>' + esc_(L('colDescription', 'Description')) +
        '</th><th>' + esc_(L('colSpecification', 'Specifications')) + '</th></tr>');
      rows.forEach(function (r) {
        push('<tr><td>' + esc_(r[0]) + '</td><td>' + esc_(r[1]) + '</td></tr>');
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
  push('<div class="page-break"></div>');
  push('<div class="h1">' + esc_(L('priceHeading', 'Price schedule')) + '</div>');
  push('<table class="price"><tr>' +
    '<th class="w-desc">' + esc_(L('colDescription', 'Description')) + '</th>' +
    '<th class="num">' + esc_(L('colBasicPrice', 'Basic price')) + '</th>' +
    '<th class="num">' + esc_(L('colQty', 'Qty')) + '</th>' +
    '<th>' + esc_(L('colUnit', 'Unit')) + '</th>' +
    '<th>' + esc_(L('colHsn', 'HSN code')) + '</th>' +
    '<th class="num">' + esc_(L('colTaxRate', 'Tax rate')) + '</th></tr>');

  var gross = 0;
  items.forEach(function (i) {
    var isCharge = i.lineType === 'Charge';
    var qty = Number(i.qty) || 0;
    var unit = Number(i.unitPrice) || 0;
    gross += unit * qty;
    push('<tr>' +
      '<td>' + esc_(i.description || i.itemCode) + '</td>' +
      '<td class="num">' + inr_(unit) + '</td>' +
      '<td class="num">' + esc_(qty) + '</td>' +
      '<td>' + esc_(i.uom || 'No') + '</td>' +
      '<td>' + (isCharge ? '—' : esc_(hsnFor_(i, products, spares))) + '</td>' +
      '<td class="num">' + (isCharge ? '—' : esc_((Number(i.taxPct) || 0).toFixed(2)) + '%') + '</td>' +
      '</tr>');
  });
  push('</table>');

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
  totals.push([esc_(L('pf', 'P&F')), Number(q.pfAmount) > 0 ? inr_(q.pfAmount) : 'NIL', '']);
  totals.push([esc_(L('freight', 'Freight')), esc_(q.deliveryTerms || 'Extra at actuals'), '']);

  var taxExtra = String(q.taxMode || 'Extra') === 'Extra';
  if (taxExtra) {
    totals.push([esc_(headlineTaxRate_(items)) + ' GST', esc_(L('taxExtra', 'EXTRA')), '']);
  } else {
    totals.push([esc_(headlineTaxRate_(items)) + ' GST', inr_(q.taxAmt), '']);
    totals.push([esc_(L('grandTotal', 'Total amount')), inr_(q.grand), 'strong']);
  }

  push('<table class="totals">');
  totals.forEach(function (t) {
    push('<tr class="' + t[2] + '"><td>' + t[0] + '</td><td class="num">' + t[1] + '</td></tr>');
  });
  push('</table>');

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
      '</div><ol>');
    templateLines_(terms.body).forEach(function (l) {
      if (/^validity\b/i.test(l)) { statedValidity = true; l = validity; }
      push('<li>' + esc_(l) + '</li>');
    });
    push('</ol>');
    if (!statedValidity) push('<div class="note">' + esc_(validity) + '</div>');
  }
  push(signoff());

  // ---------------------------------------------------------------- installation
  var install = quoteTemplate_('InstallationNotes', stream);
  if (install && isCompressor) {
    push('<div class="page-break"></div>');
    push('<div class="h1">' + esc_(install.title) + '</div><ol>');
    templateLines_(install.body).forEach(function (l) { push('<li>' + esc_(l) + '</li>'); });
    push('</ol>');
  }

  push('</td></tr></tbody></table>');
  push('</body></html>');
  return out.join('\n');
}

/** The rate to print beside "GST EXTRA" — their offers quote a single headline figure. */
function headlineTaxRate_(items) {
  var rates = {};
  items.forEach(function (i) {
    if (i.lineType === 'Charge') return;
    var r = Number(i.taxPct) || 0;
    rates[r] = (rates[r] || 0) + 1;
  });
  var keys = Object.keys(rates);
  if (!keys.length) return '18.00%';
  keys.sort(function (a, b) { return rates[b] - rates[a]; });
  return Number(keys[0]).toFixed(2) + '%';
}

/**
 * The HSN code, from the item master.
 *
 * A quotation line does not carry one — the master is the only place it is maintained, and
 * copying it onto the line would let the two drift. Both catalogs are passed in already read,
 * so a twenty-line offer does not read the sheet twenty times.
 */
function hsnFor_(item, products, spares) {
  var rec = (item.itemType === 'Product' ? products : spares)[String(item.itemId)];
  return rec ? (rec.hsnCode || '') : '';
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

  return { name: name, url: file.getUrl(), downloadUrl: file.getDownloadUrl() };
}

/** Plain CSS on purpose — the PDF converter ignores flexbox, grid and most modern layout. */
/** Plain CSS on purpose — the PDF converter ignores flexbox, grid and most modern layout. */
function quotationCss_(co) {
  var accent = String((co && co.docAccentColor) || '#C00000').trim() || '#C00000';
  return '<style>' +
    '@page{size:A4;margin:10mm 14mm;}' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111;line-height:1.45;margin:0;}' +

    // The page frame. thead and tfoot on this table are what repeat on every page.
    'table.page{width:100%;border-collapse:collapse;}' +
    'table.page > tbody > tr > td{padding:14px 0 0;vertical-align:top;}' +
    'table.page > thead > tr > td{padding:0;}' +
    'table.page > tfoot > tr > td{padding:0;}' +

    '.lh{width:100%;border-collapse:collapse;}' +
    '.lh td{padding:0;vertical-align:middle;}' +
    '.lh-l{text-align:left;width:50%;}' +
    '.lh-r{text-align:right;width:50%;}' +
    '.logo{max-height:132px;max-width:210px;}' +
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
    '.to{margin-bottom:12px;font-size:10.5pt;}' +
    '.subject{margin:12px 0 8px;}' +
    '.salut{margin-bottom:8px;}' +
    'p{margin:0 0 9px;text-align:justify;}' +
    '.h1{font-size:11.5pt;font-weight:bold;color:' + accent + ';margin:16px 0 8px;}' +
    '.h2{font-size:10.5pt;font-weight:bold;color:' + accent + ';margin:14px 0 6px;}' +
    'ul,ol{margin:0 0 10px;padding-left:26px;}' +   // 18px clipped the '10.' on a two-digit list
    'li{margin-bottom:4px;text-align:justify;}' +
    '.note{font-size:9pt;color:#444;margin:8px 0 12px;font-style:italic;}' +

    '.spec-title{font-weight:bold;margin:14px 0 5px;}' +
    'table.spec{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:10pt;}' +
    'table.spec th{background:#eee;text-align:left;padding:5px 8px;border:1px solid #999;}' +
    'table.spec td{padding:5px 8px;border:1px solid #999;}' +
    '.scope-head{font-weight:bold;margin:10px 0 3px;}' +
    '.scope-line{margin-left:12px;font-size:10pt;}' +

    'table.price{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:10pt;}' +
    'table.price th{background:#eee;padding:6px 8px;border:1px solid #999;text-align:left;}' +
    'table.price td{padding:6px 8px;border:1px solid #999;}' +
    '.w-desc{width:42%;}' +
    '.num{text-align:right;}' +
    'table.totals{width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:8px;}' +
    'table.totals td{padding:5px 8px;border:1px solid #999;}' +
    'table.totals tr.strong td{font-weight:bold;background:#f2f2f2;}' +

    // A signature split across a page break reads as a printing fault, so it moves whole.
    '.signoff{margin-top:22px;font-size:10.5pt;page-break-inside:avoid;}' +
    '.signoff .for{margin-top:4px;font-weight:bold;}' +
    '.sig-space{height:36px;}' +
    '.seal{max-height:80px;margin:6px 0;}' +
    'table.totals{page-break-inside:avoid;}' +
    '.page-break{page-break-before:always;}' +
    '</style>';
}

