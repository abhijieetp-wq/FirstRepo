/**
 * The seller, and the standing text that goes on a quotation.
 *
 * Two of the client's own quotations carry the same GSTIN but a different address, a different
 * phone number, a different spelling of the company name and a misspelt website. That is what
 * happens when a letterhead lives in whichever Word file someone copied last. Here it lives in
 * one row, and every printed document reads from it.
 *
 * The standing text — the covering letter, the "why ELGi" section, the scope of supply, the
 * terms — is seeded from their existing offers so nobody retypes it, and is editable in
 * Settings so they can reword a clause without asking us.
 */

var COMPANY_ROW_ID = 'CO-1';

function getCompanyProfile() {
  getCurrentUser();
  var row = readTable_('CompanyProfile').filter(function (c) {
    return String(c.id) === COMPANY_ROW_ID;
  })[0];
  return row ? stripRow_(row) : defaultCompanyProfile_();
}

/**
 * Taken from the client's own letterheads so the first print is close to right. The address
 * differs between their two documents, so this is a starting point to be corrected in
 * Settings, not an assertion about which is current.
 */
function defaultCompanyProfile_() {
  return {
    id: COMPANY_ROW_ID,
    legalName: 'Premier India Enterprise',
    tradeName: 'Premier India Enterprise',
    partnerLine: 'Authorised Channel Partner for ELGi Equipments Ltd.',
    addressLine1: '2nd Floor, 74/B Vidya Bhavan',
    addressLine2: 'Central Avenue',
    city: 'Nagpur',
    state: 'Maharashtra',
    pincode: '440018',
    gstin: '27AAHFP1707A1ZQ',
    pan: '',
    phone: '+91-7767014004',
    altPhone: '',
    email: 'admin.premierindia@gmail.com',
    website: 'www.premierindiaenterprise.com',
    logoUrl: '',
    bankName: '', bankAccount: '', bankIfsc: '',
    quotePrefix: 'PIE/ELGI/QUOT',
    jurisdiction: 'Nagpur',

    // Left blank deliberately: this client stamps the seal on the printed page by hand. Set it
    // and it prints above the signature — which is what the next client will want.
    sealUrl: '',
    // The number under the signature. Not the letterhead number: the letterhead is the office,
    // this is who the customer rings about the offer.
    signOffPhone: '9158004003',
    salutation: 'Dear Sir/Madam,',
    signOffLine: 'Yours sincerely,',
    // Drives the quotation numbering and the default on new records, so a house selling a
    // different make does not need the code opened.
    defaultBrand: 'ELGI',
    appName: 'ELGI Spares ERP',
    appSubtitle: 'Spares Sales Department'
  };
}

function saveCompanyProfile(input) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);

  if (!String(input.legalName || '').trim()) throw new Error('The company name is required.');

  var gstin = String(input.gstin || '').trim().toUpperCase();
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) {
    throw new Error('GSTIN should be 15 characters. Leave it blank rather than storing a wrong one — it prints on every document.');
  }

  var record = {};
  Object.keys(defaultCompanyProfile_()).forEach(function (k) {
    if (k === 'id') return;
    record[k] = String(input[k] === undefined || input[k] === null ? '' : input[k]).trim();
  });
  record.gstin = gstin;

  var existing = readTable_('CompanyProfile').filter(function (c) {
    return String(c.id) === COMPANY_ROW_ID;
  })[0];

  if (existing) {
    updateRowById_('CompanyProfile', 'id', COMPANY_ROW_ID, record, 'Company profile updated');
  } else {
    record.id = COMPANY_ROW_ID;
    appendRow_('CompanyProfile', record, 'Company profile created');
  }
  return getCompanyProfile();
}

/**
 * The brand this installation sells. Every record that stamps a brand asks here rather than
 * carrying the answer in the code, so a house selling a different make changes one field.
 */
function defaultBrand_() {
  try {
    var profile = readTable_('CompanyProfile').filter(function (c) {
      return String(c.id) === COMPANY_ROW_ID;
    })[0];
    return String((profile && profile.defaultBrand) || 'ELGI').trim() || 'ELGI';
  } catch (err) {
    // The tab arrives with setupSheet(); until then, saving a record should still work.
    return 'ELGI';
  }
}

// ------------------------------------------------------------------ standing quotation text

/**
 * The sections a quotation can carry. The first five are blocks of prose; the last three exist
 * so that none of the document's own wording is trapped in code — the heading it is titled
 * with, the paragraph it closes on, the note above the specification table, and `Labels`,
 * which overrides the short phrases (Ref No., Kind Attention, Total package price …) one
 * `key = value` per line.
 */
var QUOTE_SECTIONS = ['CoverLetter', 'WhyBrand', 'ScopeOfSupply', 'Terms', 'InstallationNotes',
  'DocumentTitle', 'Closing', 'SpecNote', 'Labels'];

function listQuoteTemplates(options) {
  getCurrentUser();
  var opts = options || {};
  return readTable_('QuoteTemplates')
    .filter(function (t) {
      if (opts.section && t.section !== opts.section) return false;
      if (opts.businessStream && t.businessStream && t.businessStream !== opts.businessStream) return false;
      if (!opts.includeInactive && String(t.active).toUpperCase() === 'FALSE') return false;
      return true;
    })
    .map(stripRow_)
    .sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0); });
}

function saveQuoteTemplate(input) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);

  if (QUOTE_SECTIONS.indexOf(input.section) === -1) {
    throw new Error('Unknown section. Expected one of: ' + QUOTE_SECTIONS.join(', '));
  }
  if (!String(input.body || '').trim()) throw new Error('The text cannot be empty.');

  var record = {
    section: input.section,
    brand: String(input.brand || 'ELGI').trim(),
    businessStream: String(input.businessStream || '').trim(),
    appliesTo: String(input.appliesTo || '').trim(),
    title: String(input.title || '').trim(),
    body: String(input.body).trim(),
    sortOrder: Number(input.sortOrder) || 0,
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  if (input.id) {
    updateRowById_('QuoteTemplates', 'id', input.id, record, 'Quotation text updated');
  } else {
    record.id = generateId_('QTPL-');
    appendRow_('QuoteTemplates', record, 'Quotation text added');
  }
  return listQuoteTemplates({ includeInactive: true });
}

/**
 * Installs the default quotation text, taken word-for-word from the client's own offers.
 * Called from setupSheet(); only ever adds sections that are not already present, so a
 * reworded clause is never overwritten by a later setup run.
 */
function installQuoteTemplates_(report) {
  var have = {};
  readTable_('QuoteTemplates').forEach(function (t) { have[String(t.id)] = true; });

  var defaults = defaultQuoteTemplates_();
  var added = 0;
  defaults.forEach(function (t) {
    if (have[t.id]) return;
    appendRow_('QuoteTemplates', t);
    added++;
  });
  if (added && report) report.seeded.push('QuoteTemplates (' + added + ' section(s))');
  return added;
}

function defaultQuoteTemplates_() {
  return [
    {
      id: 'QTPL-COMP-COVER', section: 'CoverLetter', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '',
      title: 'Submission of Budgetary Offer for ELGi Rotary Screw Air Compressor',
      sortOrder: 1, active: 'TRUE',
      body: 'With reference to the enquiry received, we are pleased to submit our offer for the ' +
        'ELGi Rotary screw air compressor with its technical specification.\n\n' +
        'ELGi Screw compressors are precision designed and carry the promise of reliable ' +
        'performance and ease of maintenance for each component in the unit. Our compressors ' +
        'meet the international CE standard, ASME and UL, and fulfil the performance and ' +
        'quality criteria of global companies.\n\n' +
        'The added values of this new generation compressor are its lower cost of ownership, ' +
        'energy efficiency, lower operating costs, compact design, high operator safety and ' +
        'minimal sound levels. In addition to the above, our EG series of screw compressors ' +
        'provide Report Generation options and remote monitoring.'
    },
    {
      id: 'QTPL-COMP-WHY', section: 'WhyBrand', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Why ELGi?',
      sortOrder: 2, active: 'TRUE',
      body: 'Single source for all your compressor needs.\n' +
        'A market leader and Asia’s largest manufacturer of air compressors, based out of ' +
        'Coimbatore, India with 50+ years of expertise in design, manufacturing, sales and ' +
        'service of a wide range of compressors and related accessories.\n' +
        'Over 2 million ELGi products are powering businesses in mining, defence, transport, ' +
        'pharmaceuticals, power, oil, railways, chemical, textile, printing, ship-building, ' +
        'paper, electronics, telecommunications, medical, food and beverage, and plastics.\n' +
        'Global footprint with off-shore manufacturing bases in Rotair SPA – Italy, Pattons ' +
        'Inc – USA, Pulford Air & Gas – Australia and sales presence in over 100 countries.\n' +
        'Quality assurance and reliability that come from being an ISO 9001:2015 company.\n' +
        'Dedicated toll-free Customer Care System, with 13 branches and over 70 dealers across India.'
    },
    {
      id: 'QTPL-COMP-TERMS', section: 'Terms', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Terms & Conditions',
      sortOrder: 3, active: 'TRUE',
      body: 'This sale will attract GST at the rates prevailing on the date of dispatch.\n' +
        'Freight shall be extra from Ex-works Coimbatore on the above price. Transit insurance ' +
        'shall be in the scope of the Purchaser.\n' +
        'Statutory information: Please advise the GSTIN information in your purchase order.\n' +
        'Terms of payment: 30% advance and 70% before dispatch against Proforma Invoice.\n' +
        'Delivery: 4–6 weeks, reckoned from the date of receipt of your clear and firm order ' +
        'with advance, or the date of approval of the GA drawing, whichever is applicable.\n' +
        'Consignee: The consignment will be dispatched on “selves” basis with special ' +
        'instruction to the transporter to door-deliver against the original copy of the L/R.\n' +
        'Supervision of erection and commissioning: We shall depute trained personnel on a ' +
        'chargeable basis as per standard norms, for which we will submit a formal quote later.\n' +
        'Validity: The offer is valid for a period of 30 days from the date of offer.\n' +
        'Warranty: All parts and equipment, unless explicitly mentioned in the UPTIME document, ' +
        'are warranted for 12 months from the date of start-up. Warranty is limited to repair or ' +
        'replacement of defective parts against manufacturing defects only. Exclusions: ' +
        'electricals (except motors and controller), rubber parts, seals, belts and consumables ' +
        'such as air filter, oil filter, separator element and lubricant.\n' +
        'Force majeure: We shall not be liable for any failure to perform where prevented by ' +
        'situations beyond our reasonable control or by acts or omissions of the purchaser.'
    },
    {
      id: 'QTPL-SPARE-COVER', section: 'CoverLetter', brand: 'ELGI',
      businessStream: STREAM_SPARE, appliesTo: '',
      title: 'Offer for spare parts of your ELGi make air compressors',
      sortOrder: 1, active: 'TRUE',
      body: 'We thank you very much for your enquiry.\n\n' +
        'We are pleased to submit our offer for the spare parts along with the commercial terms ' +
        'and conditions. We would like to highlight the advantages and benefits of using ELGi ' +
        'genuine spare parts.'
    },
    {
      id: 'QTPL-SPARE-WHY', section: 'WhyBrand', brand: 'ELGI',
      businessStream: STREAM_SPARE, appliesTo: '',
      title: 'Benefits of ELGi genuine spare parts', sortOrder: 2, active: 'TRUE',
      body: 'Assured life of consumables and parts as recommended in the operation and ' +
        'maintenance manual.\n' +
        'Compressor will operate at the maximum efficiency level.\n' +
        'Optimum energy consumption and maximum air output for energy cost savings.\n' +
        'Availability of the benefits of uptime warranty.\n' +
        'Optimum maintenance cost over the compressor’s lifecycle.\n' +
        'Reduced risk of unexpected breakdowns, thus minimising production loss.'
    },
    {
      id: 'QTPL-SPARE-TERMS', section: 'Terms', brand: 'ELGI',
      businessStream: STREAM_SPARE, appliesTo: '', title: 'Terms & Conditions',
      sortOrder: 3, active: 'TRUE',
      body: 'GST shall be extra on the basic value of the order.\n' +
        'Carting and freight shall be extra.\n' +
        'Transit insurance shall be arranged by the Purchaser.\n' +
        'Statutory information: Please advise the GSTIN information in your purchase order.\n' +
        'Terms of payment: 100% advance.\n' +
        'Delivery: as confirmed at the time of order.\n' +
        'Warranty: A three-month warranty applies to the Neuron Controller only if installed ' +
        'immediately after supply by our authorised service engineer. The warranty is void in ' +
        'cases of unauthorised installation, delay in installation, misuse, tampering, or repairs ' +
        'by unauthorised personnel. No warranty is applicable on spares.\n' +
        'Transit insurance: shall be to the ELGi/customer account.\n' +
        'Force majeure: We shall not be liable for any failure to perform where prevented by ' +
        'situations beyond our reasonable control or by acts or omissions of the purchaser.\n' +
        'Validity: The offer is valid for a period of 30 days from the date of offer.'
    },
    {
      id: 'QTPL-COMP-INSTALL', section: 'InstallationNotes', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '',
      title: 'Recommended compressor placement', sortOrder: 4, active: 'TRUE',
      body: 'The entrance to the compressor room should be high enough and wide enough to get ' +
        'the compressor in and out.\n' +
        'Leave a minimum of 1 m clearance for compressors under 75 kW, and 1.5 m for those over ' +
        '75 kW, for safe inspection, cleaning and maintenance.\n' +
        'Leave a minimum of 2 m above the compressor for hot air to flow away (air cooled).\n' +
        'Maintain the room temperature with proper ventilation. Higher suction temperatures ' +
        'reduce oil life through a higher discharge oil temperature.\n' +
        'Ensure the compressor is protected against direct sunlight and rain.\n' +
        'The compressor base should make full contact with the floor. Do not leave the ' +
        'compressor on the wooden pallet it was supplied on.\n' +
        'Installation and commissioning will be carried out only once the above is in place.'
    },

    // ---- the document's own wording, kept out of the code ----
    {
      id: 'QTPL-COMP-TITLE', section: 'DocumentTitle', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '',
      title: 'ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR',
      sortOrder: 5, active: 'TRUE',
      body: 'TECHNICAL OFFER'
    },
    {
      id: 'QTPL-SPARE-TITLE', section: 'DocumentTitle', brand: 'ELGI',
      businessStream: STREAM_SPARE, appliesTo: '',
      title: 'ELGi GENUINE SPARE PARTS',
      sortOrder: 5, active: 'TRUE',
      body: 'OFFER'
    },
    {
      id: 'QTPL-CLOSING', section: 'Closing', brand: 'ELGI',
      businessStream: '', appliesTo: '', title: '', sortOrder: 6, active: 'TRUE',
      body: 'We hope our offer is in line with your requirement. Should you need any further ' +
        'clarification, please feel free to contact the undersigned. We look forward to ' +
        'receiving your valuable order.'
    },
    {
      id: 'QTPL-SPECNOTE', section: 'SpecNote', brand: 'ELGI',
      businessStream: '', appliesTo: '', title: '', sortOrder: 7, active: 'TRUE',
      body: 'At normal working pressure, all data as per ISO 1217, Annex C.'
    },
    {
      id: 'QTPL-LABELS', section: 'Labels', brand: 'ELGI',
      businessStream: '', appliesTo: '', title: 'Wording used on the document',
      sortOrder: 8, active: 'TRUE',
      body: 'refNo = Ref No.\n' +
        'dated = Dated\n' +
        'gstNo = GST No\n' +
        'attention = Kind Attention\n' +
        'mobile = Mobile No\n' +
        'email = Email Id\n' +
        'subject = Subject\n' +
        'enclosures = Please find enclosed with this offer\n' +
        'specHeading = Technical specifications\n' +
        'scopeHeading = Scope of supply\n' +
        'priceHeading = Price schedule\n' +
        'colDescription = Description\n' +
        'colBasicPrice = Basic price\n' +
        'colQty = Qty\n' +
        'colUnit = Unit\n' +
        'colHsn = HSN code\n' +
        'colTaxRate = Tax rate\n' +
        'colSpecification = Specifications\n' +
        'packageTotal = Total package price\n' +
        'discountedTotal = Total discounted price\n' +
        'pf = P&F\n' +
        'freight = Freight\n' +
        'grandTotal = Total amount\n' +
        'taxExtra = EXTRA\n' +
        'termsHeading = Terms & conditions\n' +
        'enclSpecScope = Technical specifications and scope of supply\n' +
        'enclSpec = Technical specifications\n' +
        'enclPrice = Price schedule\n' +
        'enclTerms = Commercial terms and conditions\n' +
        'enclInstall = Installation guidelines'
    }
  ];
}
