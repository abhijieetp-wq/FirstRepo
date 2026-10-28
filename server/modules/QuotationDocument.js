/**
 * Converted from src/QuotationDocument.gs by migration/to-async.js.
 *
 * Only two things changed: functions that reach storage are `async`, and the calls that
 * reach it are `await`ed. Everything else — the logic, the names, the comments — is the
 * original, because the original is the specification and reformatting it would make the
 * diff unreadable at exactly the moment it needs to be read.
 *
 * Storage comes from server/shim.js, which keeps the old names (`readTable_`,
 * `appendRow_`) pointing at db.js. If this file is edited from here on, edit this one —
 * the .gs original stays frozen at the point of conversion so the live portal keeps running.
 */
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
 * What a template is written for, off its "Applies to" column: compressor series ("EG",
 * "EQ, EN") or a kind of machine ("RECIP", "DRYER"). None means every offer. "All", which is
 * what the lost-reasons list uses for the same idea, is read as none rather than as a series
 * called ALL.
 */
function templateSeries_(tpl) {
  return String(tpl && tpl.appliesTo || '').toUpperCase().split(/[\s,;\/]+/)
    .filter(function (s) { return s && s !== 'ALL'; });
}

/**
 * A compressor's series — EG, EQ, EN — off its record, or the letters its model starts with
 * when the series column was left empty ("EG 26-7.5 DM" is an EG).
 */
function productSeries_(p) {
  // The first word only: "EG Series" is the EG.
  var s = String(p && p.series || '').trim().toUpperCase().split(/\s+/)[0];
  if (s) return s;
  var m = String(p && (p.model || p.productCode) || '').trim().toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : '';
}

/**
 * ELGi's model names say what a machine is. In PIE's unit master (28 Oct 2026: 641 screw codes,
 * 176 reciprocating) every screw starts EG, EQ or EN and every reciprocating starts TS (two
 * stage), SS (single stage) or MS (super pressure and PET), with no code in both. Whole dryers
 * in ELGi's price list are the ELRD, ELHD, HLD, AR and 3GD families.
 */
var SCREW_MODEL_ = /^\s*E[GQN]\s*\d/i;
var RECIP_MODEL_ = /^\s*[TSM]S\s*\d/i;
var DRYER_MODEL_ = /^\s*(ELRD|ELHD|HLD|3GD|AR\s*\d)/i;

/**
 * What kind of machine a product is, for the wording that differs by kind — PIE titles a
 * screw compressor, a reciprocating compressor and a dryer differently.
 *
 * The model decides first. A reciprocating description never says "reciprocating" ("TS10
 * LB-12 BM"), so reading the words alone printed the screw title on every reciprocating offer
 * whose family had been left empty; and a screw with a built-in dryer ("EG 11-7.5 D") is a
 * screw, whatever its family says about the dryer. Only a model that matches none of ELGi's
 * names falls back to the family, the category and the description, and then to SCREW.
 */
function productKind_(p) {
  if (!p) return '';
  var names = [p.model, p.productCode, p.description];
  for (var i = 0; i < names.length; i++) {
    var n = String(names[i] || '');
    if (SCREW_MODEL_.test(n)) return 'SCREW';
    if (RECIP_MODEL_.test(n)) return 'RECIP';
    if (DRYER_MODEL_.test(n)) return 'DRYER';
  }
  var text = [p.family, p.category, p.description].join(' ');
  if (/recip/i.test(text)) return 'RECIP';
  if (/dryer|drier/i.test(text)) return 'DRYER';
  return 'SCREW';
}

/**
 * Whether a part from the price list is a whole dryer rather than a part of one.
 *
 * Dryers are sold off ELGi's price list, so they reach an offer as parts, not as units. More
 * than nine in ten price-list lines that mention a dryer are parts of one (kits, valves, heat
 * exchangers, the dryer built into a screw), and those sit with the compressor spares; the
 * whole dryers sit in the "Dryer /OWS /HRS/Tank" group, beside receivers, heat-recovery kits
 * and oil-water separators. So: a dryer family's name or "air dryer" in the description, not a
 * kit or an assembly, and not filed under some other group.
 */
function spareIsDryerUnit_(s) {
  if (!s) return false;
  var d = String(s.description || '');
  if (/\b(KIT|ASSY|ASSEMBLY|ELEMENT|FILTER|VALVE|EXCHANG\w*|INTEGRATED|SPARES?)\b/i.test(d)) return false;
  var group = String(s.productGroup || '').trim();
  if (group && !/dryer|drier/i.test(group)) return false;
  return DRYER_MODEL_.test(d) || /\bAIR\s+DR[IY]ER\b/i.test(d);
}

/**
 * The machine's name as the screw wording carries it, and what replaces it for the others:
 * the full name ("Rotary Screw Air Compressor"), the short one ("Screw compressors"), and for
 * a dryer the bare word too ("Our compressors meet..." is "Our dryers meet...").
 */
var MACHINE_NAMES_ = {
  RECIP: { full: 'Reciprocating Air Compressor', short: 'Reciprocating Compressor' },
  DRYER: { full: 'Air Dryer', short: 'Air Dryer', bare: 'Dryer' }
};

/** A replacement written in the case of the words it replaces. */
function inCaseOf_(was, now) {
  if (was === was.toUpperCase()) return now.toUpperCase();
  if (was === was.toLowerCase()) return now.toLowerCase();
  var titleCase = was.split(/\s+/).every(function (w) { return w.charAt(0) === w.charAt(0).toUpperCase(); });
  return titleCase ? now : now.charAt(0) + now.slice(1).toLowerCase();
}

/**
 * A line of offer text with the machine's name changed for the kind of machine quoted.
 *
 * PIE's rule (28 Oct 2026): only the machine changes and the rest stays as written —
 * "Submission of Budgetary Offer for ELGi Rotary Screw Air Compressor" becomes "...for ELGi
 * Reciprocating Air Compressor", "ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR" becomes
 * "...OIL AIR DRYER", and in the letter "ELGi Screw compressors are precision designed" becomes
 * "ELGi Reciprocating compressors..." or "ELGi Air dryers...". Keeps the case the text was
 * written in, so an edit to the screw wording in Settings carries over to the others.
 */
function swapMachineName_(text, kind) {
  var w = MACHINE_NAMES_[kind];
  var out = String(text || '');
  if (!w) return out;
  out = out.replace(/(rotary\s+)?screw\s+air\s+compressor(s?)/gi, function (m, rotary, s) {
    return inCaseOf_(m.slice(0, m.length - s.length), w.full) + s;
  });
  out = out.replace(/screw\s+compressor(s?)/gi, function (m, s) {
    return inCaseOf_(m.slice(0, m.length - s.length), w.short) + s;
  });
  if (w.bare) {
    out = out.replace(/\bcompressor(s?)\b/gi, function (m, s) {
      return inCaseOf_(m.slice(0, m.length - s.length), w.bare) + s;
    });
  }
  return out;
}

/**
 * One paragraph of the compressor letter, for the kind of machine quoted: the machine's name
 * changed, and any sentence about a screw series left out ("our EG series of screw compressors
 * provide Report Generation options" is true of an EG and of nothing a reciprocating or dryer
 * offer quotes). A paragraph left with nothing in it is dropped.
 */
function letterParagraph_(para, kind) {
  if (!MACHINE_NAMES_[kind]) return para;
  var sentences = String(para).match(/[^.!?]+(?:[.!?]+|$)/g) || [String(para)];
  var kept = sentences.filter(function (x) { return !/\bE[GQN]\s+series\b/i.test(x); })
    .map(function (x) { return x.trim(); }).filter(Boolean);
  return swapMachineName_(kept.join(' '), kind);
}

/**
 * The heading or subject line for the kind of machine on the offer.
 *
 * A row written for the kind ("Applies to: RECIP") prints as it is. Otherwise a compressor
 * offer takes its general row with the machine's name changed. A dryer quoted from the spares
 * desk takes the compressor wording for a dryer the same way — it is a machine, not a part —
 * while every other line of the spares offer stays the spares offer's own.
 */
async function machineLine_(section, stream, keys, kind, own) {
  var ownTitle = own ? String(own.title || '') : '';
  if (!kind || kind === 'SCREW') return ownTitle;
  if (own && templateSeries_(own).indexOf(kind) !== -1) return ownTitle;
  if (stream === STREAM_COMPRESSOR) return swapMachineName_(ownTitle, kind);
  if (kind !== 'DRYER') return ownTitle;
  var tpl = await quoteTemplate_(section, STREAM_COMPRESSOR, keys);
  if (!tpl || !tpl.title) return ownTitle;
  return templateSeries_(tpl).indexOf(kind) !== -1 ? String(tpl.title) : swapMachineName_(tpl.title, kind);
}

/**
 * The active template for a section.
 *
 * A section can have a row for one stream and a general row for both, and a row for one
 * compressor series and a general row for all of them. The most specific one wins — series
 * first, then stream — otherwise which text printed would depend on the order rows happen to
 * sit in the sheet, which is not a thing anyone should have to know.
 *
 * The series is why an EG offer and an EQ offer can carry different scopes of supply: the two
 * are different machines, with different controllers, valves and options. A row written for
 * one series is never printed on an offer for another, or on a spares offer, which has none.
 */
async function quoteTemplate_(section, stream, series) {
  // One key or several: an offer is for a series and a kind of machine at once.
  var want = [].concat(series || []).map(function (k) { return String(k || '').trim().toUpperCase(); })
    .filter(Boolean);
  var best;
  var bestScore = -1;
  (await readTable_('QuoteTemplates')).forEach(function (t) {
    if (t.section !== section) return;
    if (String(t.active).toUpperCase() === 'FALSE') return;
    if (t.businessStream && t.businessStream !== stream) return;
    var applies = templateSeries_(t);
    if (applies.length && !applies.some(function (k) { return want.indexOf(k) !== -1; })) return;
    var score = (applies.length ? 2 : 0) + (t.businessStream === stream ? 1 : 0);
    if (score > bestScore) { best = t; bestScore = score; }
  });
  return best;
}

/**
 * The document's short phrases, one `key = value` per line in the Labels section.
 *
 * A column per phrase would have meant twenty columns and a migration every time one more
 * word turned out to be client-specific. This way the whole vocabulary of the document is one
 * editable block, and any key left out simply falls back to what the code would have said.
 */
async function docLabels_(stream) {
  var out = {};
  // General first, then the stream's own on top: a spares offer needs its four different words
  // without having to restate the twenty it shares with every other offer.
  var rows = (await readTable_('QuoteTemplates')).filter(function (t) {
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

/**
 * The installation page, laid out as PIE's: an opening line, the picture of the compressed-air
 * system, the placement points numbered 1 to 6 with the clearance drawing after the two that
 * refer to it, and the closing note.
 *
 * The text says where things go, so PIE can reword it without a code change:
 *   - a line "[picture: air system]" or "[picture: placement]" places that picture, uploaded
 *     in Settings → Letterhead (nothing prints until one is);
 *   - a line ending in a colon is a heading; the lines under it are numbered, and the numbers
 *     run on across a picture;
 *   - a line starting "Note:" is the closing note, in bold;
 *   - lines before the first heading are plain paragraphs.
 *
 * Text written before any of this — one numbered point per line, no headings, no pictures —
 * still prints as it did, with the pictures where PIE puts them: the system at the top and
 * the clearance drawing after the second point.
 */
function installationHtml_(body, co) {
  var lines = templateLines_(body);
  var isPicture = function (l) { return /^\[picture:\s*[^\]]+\]$/i.test(l); };
  var isHeading = function (l) { return /:$/.test(l); };
  var isNote = function (l) { return /^note\s*:/i.test(l); };
  var pictures = {
    'air system': co.airSystemPictureUrl,
    'placement': co.placementPictureUrl
  };
  if (!lines.some(function (l) { return isPicture(l) || isHeading(l); })) {
    var numbered = 0;
    var placed = [];
    lines.forEach(function (l) {
      placed.push(l);
      if (!isNote(l) && ++numbered === 2) placed.push('[picture: placement]');
    });
    // Everything in the old text is a numbered point, so it reads as if under a heading.
    lines = ['[picture: air system]', ':'].concat(placed);
  }

  var html = [];
  var inList = false;
  var afterHeading = false;
  var number = 0;
  var closeList = function () { if (inList) { html.push('</ol>'); inList = false; } };
  lines.forEach(function (l) {
    if (isPicture(l)) {
      closeList();
      var key = l.replace(/^\[picture:\s*/i, '').replace(/\]$/, '').trim().toLowerCase();
      var src = String(pictures[key] || '').trim();
      if (src) html.push('<div class="offer-picture"><img src="' + esc_(src) + '" /></div>');
    } else if (isNote(l)) {
      closeList();
      html.push('<p class="install-note">' + esc_(l) + '</p>');
    } else if (isHeading(l)) {
      closeList();
      if (l !== ':') html.push('<div class="scope-head">' + esc_(l) + '</div>');
      afterHeading = true;
      number = 0;
    } else if (afterHeading) {
      if (!inList) { html.push('<ol start="' + (number + 1) + '">'); inList = true; }
      html.push('<li>' + esc_(l) + '</li>');
      number++;
    } else {
      html.push('<p>' + esc_(l) + '</p>');
    }
  });
  closeList();
  return html.join('');
}

/** Whether a part carries any of the specification table a compressor offer prints. */
function hasAccessorySpec_(spare) {
  if (!spare) return false;
  return SPARE_SPEC_FIELDS.some(function (k) { return String(spare[k] || '').trim() !== ''; });
}

/**
 * The specification table for an accessory on a compressor offer — PIE's layout: the title,
 * then Model, Capacity, the two pressures, Dimensions and Weight.
 *
 * Only the rows filled in print. A receiver has no maximum pressure and a filter no
 * dimensions on ELGi's sheets, and PIE's own offers leave those rows out rather than print
 * them empty. The machine's table keeps its blanks because every compressor has every one of
 * those figures; an accessory does not.
 */
function accessorySpecTable_(spare, item, L) {
  var title = String(spare.specTitle || '').trim() || String(item.description || '').trim() ||
    String(spare.description || '').trim() || String(spare.partNo || '');
  var rows = [
    ['Model', spare.specModel || spare.description || spare.partNo],
    [L('specCapacity', 'Capacity'), spare.specCapacity],
    [L('specMaxPressure', 'Maximum pressure'), spare.specMaxPressure],
    [L('specWorkPressure', 'Normal working pressure'), spare.specWorkingPressure],
    [L('specDimensions', 'Dimensions'), spare.specDimensions],
    [L('specWeight', 'Weight of the package'), spare.specWeight]
  ];
  var html = '<div class="spec-block"><div class="spec-title">' + esc_(title) + '</div>' +
    '<table class="spec"><tr><th>' + esc_(L('colDescription', 'Description')) +
    '</th><th>' + esc_(L('colSpecification', 'Specifications')) + '</th></tr>';
  rows.forEach(function (r) {
    var value = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
    if (value) html += '<tr><td>' + esc_(r[0]) + '</td><td>' + esc_(value) + '</td></tr>';
  });
  return html + '</table></div>';
}

/**
 * What a line is called on a compressor offer's price schedule — PIE's wording: "ELGi make
 * Compressor EG 26-7.5 DM", "ELGi make Air Dryer AR 0310NS A2".
 *
 * Built from the catalogue rather than the line's stored description, which for a machine is
 * the full catalogue sentence ("lubricated screw air compressor, 22 kW (30 hp), 7.5 bar,
 * 400V/50Hz, direct drive" — the specification table says all that) and for a part is ELGi's
 * terse price-list code. An accessory with a specification table is named by its heading, so
 * the table and the price line agree; any other part falls back to its description. A charge
 * — installation, carting — is printed as written.
 */
function scheduleName_(item, products, spareSpecs, L) {
  if (item.lineType === 'Charge') return String(item.description || item.itemCode || '');
  var name = '';
  if (item.itemType === 'Product') {
    var p = products[String(item.itemId)];
    var model = p ? String(p.model || p.productCode || '').trim() : '';
    if (model) name = L('compressorWord', 'Compressor') + ' ' + model;
  } else if (item.itemType === 'Spare') {
    var sp = spareSpecs[String(item.itemId)];
    name = sp ? String(sp.specTitle || '').trim() : '';
  }
  if (!name) name = String(item.description || item.itemCode || '').trim();
  return L('itemPrefix', 'ELGi make') + ' ' + name;
}

/**
 * The totals under a compressor offer's price schedule, the way PIE's own offers set them:
 *
 *   Total Package Price            ₹20,23,700.00
 *   Discounted Price (40% Less)    ₹12,14,220.00   ← highlighted
 *   P&F @                          0.00
 *   Freight                        Extra from Ex-works Coimbatore
 *   18% GST                        EXTRA
 *
 * GST quoted as extra prints as the word, with no total after it, as theirs does. An offer
 * set to "GST included" prints the tax and the total instead, for the customer who needs the
 * figure on the page.
 */
function compressorTotals_(q, co, address, items, gross, netGoods, L) {
  var rows = [[esc_(L('packageTotal', 'Total Package Price')), inr_(gross), '']];
  if (gross - netGoods > 0.005) {
    // "(40% Less)" only when that is the whole story. With line discounts as well, the
    // percentage would not take the package total to the discounted one.
    var pkgPct = Number(q.packageDiscountPct) || 0;
    var lineDiscounts = items.some(function (i) { return (Number(i.discountPct) || 0) > 0; });
    var note = pkgPct > 0 && !lineDiscounts
      ? ' ' + L('discountNote', '({pct}% Less)').replace('{pct}', String(pkgPct)) : '';
    rows.push([esc_(L('discountedTotal', 'Discounted Price') + note), inr_(netGoods), 'hl']);
  }
  var pf = Number(q.pfAmount) || 0;
  rows.push([esc_(L('pf', 'P&F @')), pf > 0 ? inr_(pf) : esc_(L('pfNil', '0.00')), '']);
  // Freight terms, not the delivery time: standing wording, the same on every offer.
  rows.push([esc_(L('freight', 'Freight')),
             esc_(L('freightNote', 'Extra from Ex-works Coimbatore')), '']);

  if (String(q.taxMode || 'Extra') === 'Extra') {
    var rate = Number(headlineTaxRate_(items)) || 0;
    rows.push([esc_(L('taxRow', '{rate}% GST').replace('{rate}', String(rate))),
               esc_(L('taxExtra', 'EXTRA')), '']);
    return rows;
  }
  gstRows_(q, co, address, items).forEach(function (r) { rows.push(r); });
  rows.push([esc_(L('grandTotal', 'Total amount')), inr_(payableTotal_(q)), 'strong']);
  return rows;
}

/**
 * The totals under a spares offer's parts list: full price, the package discount if any,
 * P&F only when charged, the GST split for the customer's accounts, and what they will pay.
 */
function spareTotals_(q, co, address, items, gross, netGoods, pkgPct, L) {
  var rows = [];
  rows.push([esc_(L('packageTotal', 'Total package price')), inr_(gross), pkgPct > 0 ? '' : 'strong']);
  if (pkgPct > 0) {
    rows.push([esc_(L('discountedTotal', 'Total discounted price')) +
      ' (' + pkgPct + '% less)', inr_(netGoods), 'strong']);
  }
  // Their spares offer has no P&F row unless there is a charge, and no freight row at all:
  // carting is a line and term 2 covers the rest.
  if (Number(q.pfAmount) > 0) {
    rows.push([esc_(L('pf', 'P&F')), inr_(q.pfAmount), '']);
  }
  // GST split the way a tax document has to split it: CGST and SGST between two places in the
  // same state, IGST across a border. One "Total Tax 18%" line said the right amount and the
  // wrong thing — the customer's accounts cannot post it, and their purchase order is raised
  // off this page.
  gstRows_(q, co, address, items).forEach(function (r) { rows.push(r); });
  // What the customer will actually pay. This printed q.grand, which excludes the tax when
  // the offer quotes GST as extra — so the page listed the tax and then a total that ignored
  // it, and the figure a purchase order would be raised against was short by the GST.
  rows.push([esc_(L('grandTotal', 'Total amount')), inr_(payableTotal_(q)), 'strong']);
  return rows;
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
async function buildQuotationHtml(quotationId) {
  getCurrentUser();

  var q = (await readTable_('Quotations')).filter(function (r) {
    return String(r.id) === String(quotationId);
  })[0];
  if (!q) throw new Error('Quotation not found.');

  var co = await getCompanyProfile();
  var stream = q.businessStream;
  var isCompressor = stream === STREAM_COMPRESSOR;

  var customer = (await readTable_('Customers')).filter(function (c) {
    return String(c.id) === String(q.customerId);
  })[0] || {};
  var customerContacts = (await readTable_('CustomerContacts')).filter(function (c) {
    return String(c.customerId) === String(q.customerId);
  });
  var contact = customerContacts.filter(function (c) {
    return String(c.id) === String(q.contactId);
  })[0] || {};
  // The customer's e-mail, which PIE wants on every offer: the addressed person's, or else the
  // customer's own (their primary contact's) when that person has none on file.
  var customerEmail = quoteEmailFor_(q.contactId, customerContacts);
  // Refuses rather than prints a name over blank space; the message names the record to fix.
  await requireQuoteAddress_(q);
  var address = await resolveQuoteAddress_(q) || {};

  var items = (await readTable_('QuotationItems'))
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
    (await readTable_('Products')).forEach(function (p) { products[String(p.id)] = p; });
  }
  // A spare line prints one thing off the master: its HSN code.
  var spareHsn = hasType.Spare ? await columnMap_('Spares', 'id', 'hsnCode') : {};

  // On a compressor offer the accessories sold with the machine — dryer, filters, receiver —
  // print a specification table of their own, the way PIE's offers always have. Only the
  // parts this offer quotes, read whole; a spares offer prints none and reads none.
  var spareSpecs = {};
  if (isCompressor && hasType.Spare) {
    var quotedSpares = items.filter(function (i) { return i.itemType === 'Spare'; })
      .map(function (i) { return String(i.itemId); });
    (await findRowsByColumn_('Spares', 'id', quotedSpares)).forEach(function (s) {
      spareSpecs[String(s.id)] = s;
    });
  }

  // The series of the machines on the offer, in line order — EG, EQ. The first chooses any
  // text written for one series; the scope of supply is printed for each series quoted,
  // because an offer for an EG and an EQ describes two different machines.
  var seriesOnOffer = [];
  items.forEach(function (i) {
    if (i.itemType !== 'Product') return;
    var ps = productSeries_(products[String(i.itemId)]);
    if (ps && seriesOnOffer.indexOf(ps) === -1) seriesOnOffer.push(ps);
  });
  var series = seriesOnOffer[0] || '';
  // The kind of machine the offer leads with — screw, reciprocating, dryer — for the title.
  var leadProduct = items.filter(function (i) {
    return i.itemType === 'Product' && products[String(i.itemId)];
  })[0];
  var offerKind = leadProduct ? productKind_(products[String(leadProduct.itemId)]) : '';
  // No unit on it: an offer for a whole dryer, on either desk, is a dryer offer. It used to take
  // the screw heading on the compressor desk and "spare parts" on the spares desk.
  if (!offerKind && hasType.Spare) {
    var spareRows = isCompressor ? spareSpecs : {};
    if (!isCompressor) {
      (await findRowsByColumn_('Spares', 'id', items.filter(function (i) { return i.itemType === 'Spare'; })
        .map(function (i) { return String(i.itemId); }))).forEach(function (s) { spareRows[String(s.id)] = s; });
    }
    if (items.some(function (i) { return i.itemType === 'Spare' && spareIsDryerUnit_(spareRows[String(i.itemId)]); })) {
      offerKind = 'DRYER';
    }
  }
  // What any series- or kind-specific text is chosen by.
  var offerKeys = [series, offerKind].filter(Boolean);

  // One row, and only when the offer came from an enquiry at all.
  var enquiryNo = '';
  if (String(q.spareEnquiryId || '').trim()) {
    var se = await findRowById_('SpareEnquiries', q.spareEnquiryId);
    enquiryNo = se ? String(se.enquiryNo || '') : '';
  }

  var preparer = (await readTable_('Users')).filter(function (u) {
    return String(u.email).toLowerCase() === String(q.preparedBy).toLowerCase();
  })[0] || {};

  var labels = await docLabels_(stream);
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
  var titleTpl = await quoteTemplate_('DocumentTitle', stream, offerKeys);
  // The heading names the kind of machine quoted; only the machine changes (machineLine_).
  var headTitle = await machineLine_('DocumentTitle', stream, offerKeys, offerKind, titleTpl);
  if (headTitle) push('<div class="doc-title">' + esc_(headTitle) + '</div>');
  if (titleTpl && titleTpl.body) push('<div class="doc-sub">' + esc_(String(titleTpl.body).trim()) + '</div>');

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
    (customerEmail ? esc_(L('email', 'Email Id')) + ': ' + esc_(customerEmail) : '') +
    '</div>');

  var cover = await quoteTemplate_('CoverLetter', stream, offerKeys);
  // The subject as well: "...for ELGi Rotary Screw Air Compressor" becomes "...for ELGi Air
  // Dryer", the rest as written. On a compressor offer the letter follows (letterParagraph_);
  // a row written for the kind is left exactly as it is.
  var subject = await machineLine_('CoverLetter', stream, offerKeys, offerKind, cover);
  var swapBody = isCompressor && cover && templateSeries_(cover).indexOf(offerKind) === -1;
  if (cover) {
    if (subject) {
      push('<div class="subject"><b>' + esc_(L('subject', 'Subject')) + ':</b> ' +
        esc_(subject) + '</div>');
    }
    push('<div class="salut">' + esc_(co.salutation || 'Dear Sir/Madam,') + '</div>');
    String(cover.body).split('\n\n').forEach(function (para) {
      var text = swapBody ? letterParagraph_(para.trim(), offerKind) : para.trim();
      if (text) push('<p>' + esc_(text) + '</p>');
    });
  }

  // Every machine on the offer gets a specification table, whether or not its specifications
  // are on file. Printing only the ones that were filled in hid the gap: a missing table is
  // invisible, and nobody goes looking for a page that was never there. A table with empty
  // rows is a to-do that the next person to read the offer will act on.
  //
  // An accessory is the other way round: it gets a table only when its specifications are on
  // file. A dryer or a receiver sold with the machine wants one; a drain valve or a hose on the
  // same offer does not, and an empty table under it would be noise rather than a to-do.
  var specced = items.filter(function (i) {
    if (i.itemType === 'Product') return !!products[String(i.itemId)];
    if (i.itemType === 'Spare') return hasAccessorySpec_(spareSpecs[String(i.itemId)]);
    return false;
  });

  var why = await quoteTemplate_('WhyBrand', stream, offerKeys);
  if (why) {
    push('<div class="h2">' + esc_(why.title) + '</div>');
    push(bulletList_(templateLines_(why.body), false));
  }

  // What follows, so the reader knows the offer is more than one page. Each entry is listed
  // only if that section will actually be printed — promising an enclosure that is not there
  // is worse than omitting it.
  //
  // One scope of supply per series quoted, each the text written for that series or else the
  // general one. Two series that come to the same text print it once, naming both.
  var scopes = [];
  for (var sr of (seriesOnOffer.length ? seriesOnOffer : [''])) {
    var scopeTpl = await quoteTemplate_('ScopeOfSupply', stream, sr);
    if (!scopeTpl) continue;
    var sameTpl = scopes.filter(function (x) { return String(x.tpl.id) === String(scopeTpl.id); })[0];
    if (sameTpl) { if (sr) sameTpl.series.push(sr); continue; }
    scopes.push({ tpl: scopeTpl, series: sr ? [sr] : [] });
  }
  var enclosures = [];
  if (specced.length && scopes.length) {
    enclosures.push(L('enclSpecScope', 'Technical specifications and scope of supply'));
  } else if (specced.length) {
    enclosures.push(L('enclSpec', 'Technical specifications'));
  } else if (scopes.length) {
    enclosures.push(L('scopeHeading', 'Scope of supply'));
  }
  enclosures.push(L('enclPrice', 'Price schedule'));
  if (await quoteTemplate_('Terms', stream, offerKeys)) enclosures.push(L('enclTerms', 'Commercial terms and conditions'));
  if (isCompressor && await quoteTemplate_('InstallationNotes', stream, offerKeys)) {
    enclosures.push(L('enclInstall', 'Installation guidelines'));
  }
  // Documents that travel with the offer but are not generated by it — the UPTIME Assurance
  // annexure above all, which is ELGi's own and comes as it is. Listed here so the reader is
  // told what is in the envelope, which is the whole point of this list.
  if (isCompressor && await quoteTemplate_('UptimeWarranty', stream, offerKeys)) {
    enclosures.push(L('enclUptime', 'UPTIME Warranty'));
  }
  var extraEncl = await quoteTemplate_('ExtraEnclosures', stream, offerKeys);
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

  var closing = await quoteTemplate_('Closing', stream, offerKeys);
  if (closing) {
    String(closing.body).split('\n\n').forEach(function (para) {
      if (para.trim()) push('<p>' + esc_(para.trim()) + '</p>');
    });
  }
  push(signoff());

  // ---------------------------------------------------------------- specifications
  var offerPicture = isCompressor && String(co.compressorPictureUrl || '').trim()
    ? '<div class="offer-picture"><img src="' + esc_(co.compressorPictureUrl) + '" /></div>' : '';
  if (specced.length) {
    push('<div class="page-break"></div>');
    // A compressor offer heads its specifications with what the machine is — "ELGi ELECTRIC
    // POWERED OIL SCREW AIR COMPRESSOR", or the reciprocating or dryer wording — as PIE's own
    // offers do: the document title for the kind of machine quoted.
    push('<div class="h1">' + esc_(isCompressor && headTitle
      ? headTitle : L('specHeading', 'Technical specifications')) + '</div>');
    // The picture of the range that opens the specifications on every one of PIE's compressor
    // offers, the same whatever the model. Set once in Settings → Letterhead.
    if (offerPicture) push(offerPicture);
    var specNote = await quoteTemplate_('SpecNote', stream, offerKeys);
    if (specNote) push('<div class="note">' + esc_(String(specNote.body).trim()) + '</div>');
    specced.forEach(function (i) {
      if (i.itemType === 'Spare') {
        push(accessorySpecTable_(spareSpecs[String(i.itemId)], i, L));
        return;
      }
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

      // Heading and table kept on one page: a table whose heading is at the foot of one sheet
      // and whose rows are on the next reads as two half-tables.
      push('<div class="spec-block"><div class="spec-title">' + esc_(p.model || p.productCode) + '</div>');
      push('<table class="spec"><tr><th>' + esc_(L('colDescription', 'Description')) +
        '</th><th>' + esc_(L('colSpecification', 'Specifications')) + '</th></tr>');
      rows.forEach(function (r) {
        var value = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
        push('<tr><td>' + esc_(r[0]) + '</td>' +
          (value ? '<td>' + esc_(value) + '</td>'
                 : '<td class="spec-blank">&nbsp;</td>') + '</tr>');
      });
      push('</table></div>');
    });
  }

  scopes.forEach(function (sc) {
    var heading = sc.tpl.title || L('scopeHeading', 'Scope of supply');
    // Named by series when the offer quotes more than one, so an EG with an EL beside it
    // does not read as if the EG's scope covered both.
    if (seriesOnOffer.length > 1 && sc.series.length) {
      heading += ' \u2014 ' + sc.series.join(', ') + ' ' + L('seriesWord', 'series');
    }
    push('<div class="h1">' + esc_(heading) + '</div>');
    templateLines_(sc.tpl.body).forEach(function (l) {
      // A line ending in a colon is a heading for the block beneath it.
      push(/:$/.test(l) ? '<div class="scope-head">' + esc_(l) + '</div>'
                        : '<div class="scope-line">' + esc_(l) + '</div>');
    });
  });

  // ---------------------------------------------------------------- price schedule
  // The schedule starts a page of its own, in both documents.
  //
  // It flowed for a while, once, because forcing the break used to cost a spares offer two
  // whole pages — the letter ended a third of the way down one and the annexure a third of
  // the way down another. Letting it flow meant the annexure could open at the foot of the
  // covering letter and its parts table break across the fold, which on an offer sent to a
  // customer reads as a printing fault. The letterhead is smaller and the leading tighter
  // now, so the letter fills its page and the annexure starts the next one: the break costs
  // nothing it used to cost, and the table is whole.
  push('<div class="page-break"></div>');
  // An offer with nothing to specify — a heat recovery kit on its own — has no specifications
  // page to carry the picture, so it heads the price schedule instead: every compressor offer
  // carries it.
  if (offerPicture && !specced.length) push(offerPicture);
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
  // The HSN code and the unit belong with what is being sold, before the money starts: a
  // storeman reads left to right and stops once the figures begin. On both documents the HSN
  // used to sit past the figures, where it read as an afterthought on a tax document.
  // A delivery column costs a column on a page that is already tight, so it earns its place
  // only when a line actually needs it: when every part goes out together the promise is one
  // sentence in the terms, and repeating it against each row says nothing. It sits with the
  // goods rather than after the figures — partly for the same reason the HSN does, and partly
  // because the totals below merge into the last column and would land under "Delivery"
  // otherwise.
  //
  // The compressor offer is the exception, at PIE's request: it follows their own price
  // schedule column for column — Description, Basic price, Qty, Unit, HSN code, Tax rate —
  // because that is the page their customers and their ELGi counterparts are used to reading,
  // and an offer from the website should not look like it came from somebody else.
  var perLine = anyLeadTime_(items);
  var priceCols;
  if (isCompressor) {
    priceCols = [{ t: L('colDescription', 'Description'), c: 'w-desc' }];
    if (perLine) priceCols.push({ t: L('colDelivery', 'Delivery'), c: '' });
    priceCols.push({ t: L('colBasicPrice', 'Basic price'), c: 'num' },
                   { t: L('colQty', 'Qty'), c: 'num' },
                   { t: L('colUnit', 'UNIT'), c: '' },
                   { t: L('colHsn', 'HSN Code'), c: '' },
                   { t: L('colTaxRate', 'Tax Rate'), c: 'num' });
  } else {
    priceCols = [{ t: L('colPartNo', 'Part Number'), c: 'w-part' },
       { t: L('colDescription', 'Description'), c: 'w-desc' },
       { t: L('colHsn', 'HSN code'), c: '' },
       { t: L('colUom', 'Unit of measurement'), c: '' }];
    if (perLine) priceCols.push({ t: L('colDelivery', 'Delivery'), c: '' });
    // Quantity before the price, at PIE's request: how many, at what each, for how much.
    priceCols.push({ t: L('colQuantity', 'Quantity'), c: 'num' },
                   { t: L('colPricePer', 'Price Per'), c: 'num' },
                   { t: L('colTotalAmount', 'Total Amount'), c: 'num' });
  }

  push('<table class="price' + (isCompressor ? ' pie' : '') + '"><thead><tr>' +
    priceCols.map(function (col) {
      return '<th' + (col.c ? ' class="' + col.c + '"' : '') + '>' + esc_(col.t) + '</th>';
    }).join('') +
    '</tr></thead><tbody>');

  var gross = 0;
  // What this customer calls each part, looked up once rather than per line. Resolved
  // here rather than stored on the line, so correcting a mapping corrects the offers
  // that have not gone out yet.
  var theirCodes = await customerCodeMap_(q.customerId);
  items.forEach(function (i) {
    var isCharge = i.lineType === 'Charge';
    var qty = Number(i.qty) || 0;
    var unit = Number(i.unitPrice) || 0;
    var lineTotal = unit * qty;
    gross += lineTotal;
    var hsn = isCharge ? '' : esc_(hsnFor_(i, products, spareHsn));

    push('<tr>' + (isCompressor
      ? '<td>' + esc_(scheduleName_(i, products, spareSpecs, L)) + '</td>' +
        (perLine ? '<td>' + (isCharge ? '' : esc_(lineDeliveryText_(i, q))) + '</td>' : '') +
        '<td class="num">' + inr_(unit) + '</td>' +
        '<td class="num">' + esc_(qty) + '</td>' +
        '<td>' + (isCharge ? '' : esc_(i.uom || 'No')) + '</td>' +
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
        (perLine ? '<td>' + (isCharge ? '' : esc_(lineDeliveryText_(i, q))) + '</td>' : '') +
        '<td class="num">' + (isCharge ? '' : esc_(qty)) + '</td>' +
        '<td class="num">' + (isCharge ? '' : inr_(unit)) + '</td>' +
        '<td class="num">' + inr_(lineTotal) + '</td>') +
      '</tr>');
  });

  // Totals, laid out the way their offer lays them out: everything listed at full price, one
  // percentage struck off the whole package, then P&F, freight and the tax note.
  var pkgPct = Number(q.packageDiscountPct) || 0;
  // recalcQuotation_ stores line discounts and the package discount together, so the net of
  // both is what the customer pays for goods.
  var netGoods = gross - (Number(q.discountAmt) || 0);
  var totals = isCompressor
    ? compressorTotals_(q, co, address, items, gross, netGoods, L)
    : spareTotals_(q, co, address, items, gross, netGoods, pkgPct, L);

  if (isCompressor) {
    // Their grid: the label across Description and Basic price, the amount across the rest,
    // and the discounted price picked out in yellow — the figure the customer looks for first.
    var qtyAt = perLine ? 3 : 2;
    totals.forEach(function (t) {
      push('<tr class="' + t[2] + '"><td class="tot-label" colspan="' + qtyAt + '">' + t[0] +
        '</td><td class="num tot-val" colspan="' + (priceCols.length - qtyAt) + '">' + t[1] + '</td></tr>');
    });
  } else {
    // One table, not two. The items and the totals used to be separate tables, so the money
    // did not line up under the money and the last row of one sat beside the first row of
    // the other. The totals are rows of the same grid now: the label runs across every column
    // but the last, and the amount lands under the amounts.
    var labelSpan = priceCols.length - 1;
    totals.forEach(function (t) {
      push('<tr class="' + t[2] + '"><td class="tot-label" colspan="' + labelSpan + '">' +
        t[0] + '</td><td class="num">' + t[1] + '</td></tr>');
    });
  }
  push('</tbody></table>');

  // ---------------------------------------------------------------- terms
  var terms = await quoteTemplate_('Terms', stream, offerKeys);
  if (terms) {
    // The standing terms carry a validity clause in general words; this quotation knows the
    // actual number of days and the actual date. Rather than print both and contradict
    // ourselves, the concrete one replaces the clause where it appears.
    var validity = 'Validity: this offer is valid for ' + (q.validityDays || 30) +
      ' days from the date of offer' +
      (q.validUntil ? ' (until ' + ddmmyyyy_(q.validUntil) + ')' : '') + '.';
    var statedValidity = false;
    // The same treatment for delivery. The standing clause carries the wording that matters
    // and does not change — what the period is reckoned from — while the period itself is this
    // offer's to state. Replacing only the period keeps both: "Delivery: 2-3 weeks. This
    // delivery shall reckon from the date of receipt of your clear and firm order."
    var deliveryPhrase = deliveryClause_(q, items);
    push('<div class="h1">' + esc_(terms.title || L('termsHeading', 'Terms & conditions')) +
      '</div>');
    push(bulletList_(templateLines_(terms.body).map(function (l) {
      if (/^validity\b/i.test(l)) { statedValidity = true; return validity; }
      if (deliveryPhrase && /^delivery\s*:/i.test(l)) {
        return l.replace(/^(delivery\s*:\s*)([^.]*)/i, function (m, head) {
          return head + deliveryPhrase;
        });
      }
      return l;
    }), true));
    if (!statedValidity) push('<div class="note">' + esc_(validity) + '</div>');
  }

  // They close twice, and differently: the letter ends by inviting questions, the terms end by
  // asking for a meeting. Printing the first one again in the second place loses that.
  var closingFinal = await quoteTemplate_('ClosingFinal', stream, offerKeys);
  if (closingFinal) {
    String(closingFinal.body).split('\n\n').forEach(function (para) {
      if (para.trim()) push('<p>' + esc_(para.trim()) + '</p>');
    });
  }
  // No second signature. The letter is signed where it closes, on the first page, and that is
  // the signature on the offer. Signing again under the terms was how their old compressor
  // document did it; on the spares one it only ever produced a sheet of its own, and PIE
  // asked for the two documents to agree.

  // ---------------------------------------------------------------- installation
  var install = await quoteTemplate_('InstallationNotes', stream, offerKeys);
  if (install && isCompressor) {
    push('<div class="page-break"></div>');
    push('<div class="h1">' + esc_(install.title) + '</div>');
    push(installationHtml_(install.body, co));
  }

  // ---------------------------------------------------------------- UPTIME warranty
  // ELGi's annexure, printed rather than attached. It is a page that gets filled in by hand
  // and signed by both sides at commissioning, so the fields print as ruled blanks: an
  // attachment nobody can sign is worth nothing, which is why it is here at all.
  var uptime = await quoteTemplate_('UptimeWarranty', stream, offerKeys);
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
 * How long a line takes, in the words an offer uses.
 *
 * Zero is not "0 days". A part on the shelf is the single most useful thing a spares offer can
 * say, and saying it as a number says the opposite. Whole weeks read as weeks because that is
 * how both their documents already phrase delivery — "4-6 weeks", not "28-42 days".
 */
function leadTimeText_(days) {
  if (days === '' || days === null || days === undefined) return '';
  var n = Number(days);
  if (isNaN(n) || n < 0) return '';
  if (n === 0) return 'Ex-stock';
  if (n === 7) return '1 week';
  if (n % 7 === 0) return (n / 7) + ' weeks';
  return n + (n === 1 ? ' day' : ' days');
}

/** Whether any line carries its own promise, which is what makes the column worth a column. */
function anyLeadTime_(items) {
  var found = false;
  (items || []).forEach(function (i) {
    if (leadTimeText_(i.leadTimeDays)) found = true;
  });
  return found;
}

/**
 * What one row says under Delivery.
 *
 * A line without its own lead time is not undecided — it goes out with the rest of the order,
 * so it shows the offer's period rather than a dash. A dash appears only when nothing has been
 * promised anywhere, which is a gap worth seeing on the draft.
 */
function lineDeliveryText_(item, q) {
  return leadTimeText_(item.leadTimeDays) || String(q.deliveryPeriod || '').trim() || '\u2014';
}

/**
 * The delivery promise, as the terms should state it.
 *
 * Empty means the quotation has said nothing, and then the standing clause is left exactly as
 * written — the same reasoning as validity: print the concrete promise where there is one, and
 * never contradict the standing text with a blank.
 */
function deliveryClause_(q, items) {
  if (anyLeadTime_(items)) return 'as stated against each item above';
  return String(q.deliveryPeriod || '').trim();
}

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
async function generateQuotationPdf(quotationId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var q = (await readTable_('Quotations')).filter(function (r) {
    return String(r.id) === String(quotationId);
  })[0];
  if (!q) throw new Error('Quotation not found.');

  var html = await buildQuotationHtml(quotationId);
  var safeName = String(q.quoteNo).replace(/[\/\\:*?"<>|]/g, '-');
  var name = safeName + (q.revision && q.revision !== 'R0' ? ' ' + q.revision : '') + '.pdf';

  var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);

  var folders = DriveApp.getFoldersByName(QUOTE_PDF_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(QUOTE_PDF_FOLDER);
  var file = folder.createFile(pdf);

  await audit_('Print', 'Quotations', quotationId, 'pdf', '', name, 'Quotation PDF generated');

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
    'body{font-family:Verdana,Geneva,sans-serif;font-size:10pt;color:#111;line-height:1.25;margin:0;}' +

    // The page frame. thead and tfoot on this table are what repeat on every page.
    'table.page{width:100%;border-collapse:collapse;}' +
    'table.page > tbody > tr > td{padding:8px 0 0;vertical-align:top;}' +
    'table.page > thead > tr > td{padding:0;}' +
    'table.page > tfoot > tr > td{padding:0;}' +

    // The customer's own code, under ours in the part-number cell: quieter than the part
    // number, because it is a cross-reference rather than what we are selling.
    '.their-code{font-size:8.5pt;color:#555;margin-top:1px;}' +

    '.lh{width:100%;border-collapse:collapse;}' +
    '.lh td{padding:0;vertical-align:middle;}' +
    '.lh-l{text-align:left;width:50%;}' +
    '.lh-r{text-align:right;width:50%;}' +
    // 104px = 78pt. Theirs is drawn at 144px, but that band repeated on every sheet cost
    // more of the page than the artwork was worth; the mark is still legible at this size.
    '.logo{max-height:104px;max-width:170px;}' +
    '.partner-logo{max-height:62px;max-width:130px;}' +

    '.ft{border-top:1px solid #222;margin-top:6px;padding-top:3px;text-align:center;}' +
    '.ft-partner{font-size:8pt;color:' + accent + ';text-decoration:underline;}' +
    '.ft-name{font-size:10pt;font-weight:bold;letter-spacing:.3px;}' +
    '.ft-line{font-size:8pt;color:#222;line-height:1.2;}' +

    '.doc-title{font-size:12pt;font-weight:bold;color:' + accent + ';margin:2px 0 7px;}' +
    '.doc-sub{font-size:11pt;font-weight:bold;margin:0 0 8px;}' +
    '.refbar{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:10pt;}' +
    '.refbar td{padding:0;}' +
    '.right{text-align:right;}' +
    '.to{margin-bottom:8px;font-size:10pt;}' +
    '.subject{margin:8px 0 6px;}' +
    '.salut{margin-bottom:6px;}' +
    'p{margin:0 0 5px;text-align:justify;}' +
    '.h1{font-size:11.5pt;font-weight:bold;color:' + accent + ';margin:9px 0 5px;page-break-after:avoid;}' +
    '.h2{font-size:10.5pt;font-weight:bold;color:' + accent + ';margin:8px 0 4px;page-break-after:avoid;}' +
    'ul,ol{margin:0 0 5px;padding-left:26px;}' +   // 18px clipped the '10.' on a two-digit list
    'li{margin-bottom:2px;text-align:justify;}' +
    // Theirs marks the heading with a hollow bullet and the points under it with a filled
    // one — the reverse of a browser's default nesting — and does not indent the children.
    'ul{list-style-type:circle;}' +
    // The weight must not run on into the points beneath the heading.
    'ul.sub{list-style-type:disc;margin:4px 0 4px;padding-left:16px;font-weight:normal;}' +
    'ol.sub{margin:4px 0 4px;padding-left:22px;list-style-type:lower-alpha;}' +
    'ul > li.lead{font-weight:bold;}' +
    '.note{font-size:9pt;color:#444;margin:6px 0 8px;font-style:italic;}' +

    '.spec-block{page-break-inside:avoid;break-inside:avoid;}' +
    // Across the full width of the page, as on PIE's offers — scaled up if the upload is
    // narrower than the page, which a resized photograph usually is.
    '.offer-picture{margin:4px 0 8px;page-break-inside:avoid;}' +
    '.offer-picture img{display:block;width:100%;height:auto;}' +
    '.install-note{font-weight:bold;margin-top:10px;}' +
    '.spec-title{font-weight:bold;margin:10px 0 4px;page-break-after:avoid;break-after:avoid;}' +
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
    'table.price th{background:#eee;padding:3px 6px;border:1px solid #999;text-align:left;}' +
    'table.price td{padding:3px 6px;border:1px solid #999;}' +
    // A part whose description carries on overleaf reads as a printing fault, so a row moves
    // to the next page whole. The heading row is a thead, so it repeats above it.
    'table.price tr{page-break-inside:avoid;}' +
    '.w-desc{width:42%;}' +
    '.w-part{width:18%;}' +
    // A totals row inside the price grid: the label runs across the columns the figures do
    // not need, and the amount lands under the amounts.
    'table.price td.tot-label{text-align:right;font-weight:bold;}' +
    'table.price tr.strong td{font-weight:bold;background:#f2f2f2;}' +
    // The compressor schedule is PIE's own grid: plain heading row, darker rules, totals
    // labelled from the left, and the discounted price highlighted.
    'table.price.pie th{background:#fff;font-weight:normal;border-color:#555;}' +
    'table.price.pie td{border-color:#555;}' +
    'table.price.pie td.tot-label{text-align:left;font-weight:normal;}' +
    // Their figures sit at the left of the cell on the lines, and the totals at the right.
    'table.price.pie th.num,table.price.pie td.num{text-align:left;}' +
    'table.price.pie td.tot-val{text-align:right;}' +
    'table.price tr.hl td{background:#ffff00;}' +
    'table.machine{border-collapse:collapse;margin-bottom:8px;font-size:10pt;page-break-inside:avoid;}' +
    'table.machine td{border:1px solid #999;padding:4px 10px;}' +
    'table.machine td:first-child{font-weight:bold;background:#eee;}' +
    '.num{text-align:right;}' +
    // table.totals is gone: both documents now put their totals in the price grid, and a
    // stylesheet that still dresses a table nothing emits is a rule nobody can test.

    // A signature split across a page break reads as a printing fault, so it moves whole.
    '.signoff{margin-top:10px;font-size:10pt;page-break-inside:avoid;}' +
    '.signoff .for{margin-top:4px;font-weight:bold;}' +
    '.sig-space{height:20px;}' +
    '.seal{max-height:70px;margin:4px 0;}' +
    '.page-break{page-break-before:always;}' +
    '</style>';
}

