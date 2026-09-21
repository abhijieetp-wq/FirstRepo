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
    // The number under the signature. Not necessarily the letterhead number: the letterhead is
    // the office, this is who the customer rings about the offer. It carried the old Hingna
    // Road number long after PIE corrected the letterhead, so every offer went out signed with
    // a number that no longer reaches them.
    signOffPhone: '+91-7767014004',
    salutation: 'Dear Sir/Madam,',
    signOffLine: 'Yours sincerely,',
    // Drives the quotation numbering and the default on new records, so a house selling a
    // different make does not need the code opened.
    defaultBrand: 'ELGI',
    // Not "Spares" — one installation serves both streams, and a compressor offer printed
    // under a spares banner invites the obvious question.
    appName: 'ELGi Sales ERP',
    appSubtitle: 'Compressor & Spare Sales',
    // Most logos are a wordmark — the company name is already drawn into the image — and
    // printing the text name underneath it says the name twice. Tick this and the letterhead
    // lets the logo speak for itself.
    logoShowsName: 'FALSE',
    // The principal's mark, printed opposite our own. For a channel partner this is half the
    // point of the letterhead, so it is a field rather than something only we can add.
    partnerLogoUrl: '',
    // Their documents set headings and the partner line in red.
    docAccentColor: '#C00000'
  };
}

/**
 * A Sheets cell holds 50,000 characters. An uploaded logo is stored as a data URI in one, so
 * an oversized image fails at the moment of saving rather than silently truncating into a
 * broken picture on every future quotation.
 */
var MAX_CELL_CHARS = 48000;

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
  record.logoShowsName = input.logoShowsName ? 'TRUE' : 'FALSE';

  ['logoUrl', 'sealUrl', 'partnerLogoUrl'].forEach(function (k) {
    if (record[k].length > MAX_CELL_CHARS) {
      throw new Error('That image is too large to store (' +
        Math.round(record[k].length / 1024) + ' KB, and the limit is ' +
        Math.round(MAX_CELL_CHARS / 1024) + ' KB). Upload a smaller one, or host it and paste ' +
        'the link instead.');
    }
  });

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
  'UptimeWarranty', 'ExtraEnclosures', 'DocumentTitle', 'Closing', 'ClosingFinal', 'SpecNote',
  'Labels'];

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
 * Puts the standard wording back, overwriting whatever those sections currently say.
 *
 * installQuoteTemplates_ only ever adds sections that are absent, so that a reworded clause is
 * never silently reverted by a later setup run. That is the right default and it is also why a
 * correction to the standard text can never reach a Sheet that has already been set up. This is
 * the deliberate way to take it: it touches only the sections that ship with the system, leaves
 * anything the business added alone, and says how many it changed.
 */
function restoreQuoteTemplates() {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);

  var existing = {};
  readTable_('QuoteTemplates').forEach(function (t) { existing[String(t.id)] = t; });

  var restored = [], added = [];
  defaultQuoteTemplates_().forEach(function (t) {
    if (!existing[t.id]) {
      appendRow_('QuoteTemplates', t, 'Standard quotation text installed');
      added.push(t.section);
      return;
    }
    if (String(existing[t.id].body).trim() === String(t.body).trim() &&
        String(existing[t.id].title).trim() === String(t.title).trim()) {
      return;   // already identical — no write, no audit noise
    }
    var patch = {};
    Object.keys(t).forEach(function (k) { if (k !== 'id') patch[k] = t[k]; });
    updateRowById_('QuoteTemplates', 'id', t.id, patch, 'Standard quotation text restored');
    restored.push(t.section);
  });

  return { restored: restored, added: added, unchanged: !restored.length && !added.length };
}

/**
 * Installs the default quotation text, taken word-for-word from the client's own offers.
 * Called from setupSheet(); only ever adds sections that are not already present, so a
 * reworded clause is never overwritten by a later setup run.
 */
function installQuoteTemplates_(report) {
  var added = installMissingQuoteTemplates_();
  if (added.length && report) {
    report.seeded.push('QuoteTemplates (' + added.length + ' section(s))');
  }
  return added.length;
}

/** Adds the standard sections that are absent and returns their names. Never touches a row
 * that is already there — an edited clause stays edited. */
function installMissingQuoteTemplates_(auditReason) {
  var have = {};
  readTable_('QuoteTemplates').forEach(function (t) { have[String(t.id)] = true; });

  var added = [];
  defaultQuoteTemplates_().forEach(function (t) {
    if (have[t.id]) return;
    appendRow_('QuoteTemplates', t, auditReason);
    added.push(t.section);
  });
  return added;
}

var BUILD_STAMP_KEY_ = 'installedBuild';

/**
 * Standard text that ships with a build reaches a Sheet that was set up earlier only if
 * somebody thinks to press Restore in Settings. That is how the UPTIME annexure could ship in
 * one build and still be missing from the printed offer: the renderer prints the section when
 * the row is there and silently skips it when it is not, so the page simply never appeared.
 *
 * So on the first load after a deployment, the standard sections that are absent are
 * installed. Sections already present are left exactly as they are, including any the business
 * has reworded. The stamp lives in document properties rather than a column, so this asks
 * nothing of a Sheet already in use.
 */
function applyBuildUpdates_() {
  var props = PropertiesService.getDocumentProperties();
  if (!props || props.getProperty(BUILD_STAMP_KEY_) === APP_BUILD) return null;

  // Two people opening the portal at the same moment must not both install the same section.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    if (props.getProperty(BUILD_STAMP_KEY_) === APP_BUILD) return null;
    // A build that adds a column has the same problem as one that adds standard text: the
    // code writes a field the sheet has no home for until somebody runs Setup. On its own
    // failure the text still installs — one repair going wrong must not take the other with
    // it, nor the load.
    try {
      addMissingColumnsEverywhere_();
    } catch (err) {
      console.warn('Could not add missing columns: ' + err.message);
    }
    var added = installMissingQuoteTemplates_('Standard quotation text installed with build ' +
      APP_BUILD);
    props.setProperty(BUILD_STAMP_KEY_, APP_BUILD);
    return added.length ? added : null;
  } finally {
    lock.releaseLock();
  }
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
        'provide Report Generation options and remote monitoring.\n\n' +
        'The compressor comes in aesthetically appealing packaging and is easy to install.\n\n' +
        'ELGi Screw compressors belong to a highly successful range of screw compressors from ' +
        'ELGi with a large customer base across the world for a wide variety of applications.'
    },
    {
      id: 'QTPL-COMP-WHY', section: 'WhyBrand', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Why ELGi?',
      sortOrder: 2, active: 'TRUE',
      body: 'Single source for all your compressor needs.\n' +
        '- A market leader and Asia\u2019s largest manufacturer of air compressors, based out of ' +
        'Coimbatore, India with 50+ years of expertise in design, manufacturing, sales and ' +
        'service of a wide range of compressors and related accessories like air dryers, ' +
        'variable speed drives, down-stream filters and air receivers.\n' +
        '- Over 2 million ELGi products are powering businesses in industries such as mining, ' +
        'defence, transport, pharmaceuticals, power, oil, railways, chemical, textile, ' +
        'printing, ship-building, paper manufacturing, electronics, telecommunications, ' +
        'medical, food and beverage, and plastics.\n' +
        '- Global footprint with off-shore manufacturing bases in Rotair SPA \u2013 Italy, Pattons ' +
        'Inc \u2013 USA, Pulford Air & Gas \u2013 Australia and sales presence in over 100 countries.\n' +
        '- We design and install a complete system that meets the requirement of different ' +
        'applications across industries. We offer the complete compressed air system of air ' +
        'compressors, air dryers, variable speed drives, down-stream filters and air receivers.\n' +
        'Quality assurance and reliability that come from being an ISO 9001:2015 company.\n' +
        '- Each component in ELGi products passes through stringent quality tests and is 100% ' +
        'tested for performance in the manufacturing line.\n' +
        '- Each product comes with ELGi\u2019s UPTIME Assurance.\n' +
        'Dedicated toll-free Customer Care System.\n' +
        '- After sales service through our service organisation, which consists of 13 branches, ' +
        'over 70 dealers across India and over 200 distributors in 100+ countries across the globe.'
    },
    {
      id: 'QTPL-COMP-TERMS', section: 'Terms', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Terms & Conditions',
      sortOrder: 3, active: 'TRUE',
      body: 'This sale will attract GST at the rates prevailing on the date of dispatch.\n' +
        'Freight condition shall be extra from Ex-works Coimbatore on the above price. Transit ' +
        'insurance shall be in the scope of the Purchaser.\n' +
        'Statutory information: Please advise the GSTIN information in your purchase order.\n' +
        'Terms of payment: 30% advance and 70% before dispatch against Proforma Invoice.\n' +
        'Delivery: 4-6 weeks. This delivery shall reckon from the date of receipt of your clear ' +
        'and firm order with advance, or the date of approval of the GA drawing, whichever is ' +
        'applicable.\n' +
        'Consignee: The consignment will be dispatched on \u201cselves\u201d basis with special ' +
        'instruction to the transporter to door-deliver the consignment against the original ' +
        'copy of the L/R.\n' +
        'Supervision of erection and commissioning: We shall depute trained personnel for ' +
        'supervision of erection and commissioning on a chargeable basis as per standard norms ' +
        'and conditions, for which we will submit a formal quote at a later stage. Taxes shall ' +
        'be extra as applicable.\n' +
        'Validity: The offer is valid for a period of 30 days from the date of offer.\n' +
        'Warranty:\n' +
        '- All parts and equipment, unless explicitly mentioned in the UPTIME document, are ' +
        'warranted for a period of 12 months from the date of start-up.\n' +
        '- Warranty is limited to repair or replacement of defective parts against ' +
        'manufacturing defects only, and does not extend to any consequential liability thereof.\n' +
        '- Exclusions: electricals (except motors and controller), rubber parts, seals, belts ' +
        'and consumables like air filter, oil filter, separator element, lubricant and similar ' +
        'wear and tear parts.\n' +
        '- UPTIME Warranty clause as per the attached UPTIME document.\n' +
        'Force majeure: We shall not be under any liability to the purchaser for any failure to ' +
        'perform any of the obligations under the contract where it is prevented by i) ' +
        'situations beyond its reasonable control, or ii) acts or omissions of the purchaser. ' +
        'If the performance of the contract is prevented by this clause for more than 120 days, ' +
        'then either party (except where the delay is caused by the purchaser, in which event ' +
        'only the company) upon 30 days\u2019 written notice may terminate the contract with ' +
        'respect to the unexecuted portion, whereupon the purchaser shall promptly pay the ' +
        'company its termination charges determined in accordance with the company\u2019s standard ' +
        'accounting practices upon submission of invoices thereof.'
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
    // Their scope of supply, word for word off PIE/ELGI/QUOT/26-27/383. The section existed
    // and the document has always known how to print it — a line ending in a colon is a
    // heading, the rest are lines beneath it — but nothing was ever seeded, so two pages of
    // every compressor offer came out blank.
    {
      id: 'QTPL-COMP-SCOPE', section: 'ScopeOfSupply', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Scope of supply',
      sortOrder: 2, active: 'TRUE',
      body: 'Base & Enclosure:\n' +
        'Rigid frame\n' +
        'Powder-coated panels with two service doors at the front and two at the sides\n' +
        'Latches on each door\n' +
        'Ducts for drive motor\n' +
        'Drive System:\n' +
        'Main motor \u2013 high efficiency IE3 TEFC motor with \u201cclass-F\u201d insulation\n' +
        'Flexible coupling with elastic element\n' +
        'Rigid connection of motor and the airend flange\n' +
        'CE certified control panel with wye-delta reduced voltage starter for the main motor\n' +
        'DOL starter with contactor for cooling motors\n' +
        'High amp protection electric motors\n' +
        'Air Inlet System:\n' +
        'Pre-filter: to ensure clean air is supplied to the inlet system\n' +
        'Air duct: to get clean and cool air to the air filter\n' +
        'Air filter housing\n' +
        'Twin paper element, each of 3 microns with an efficiency of 99%\n' +
        'Pre-cleaning on the air cleaner to separate heavy particles and avoid clogging of the ' +
        'paper element\n' +
        'Service indicator \u2013 indicating filter service need\n' +
        'Rubber coupling connecting air filter to the intake valve\n' +
        'Normally closed type intake valve with integrated blow down and solenoid control valve\n' +
        'Load/unload type capacity control for EQ 11 to EQ 45\n' +
        'Compression System:\n' +
        'Highly efficient axis airend with n-v profile rotors\n' +
        'ELGi Demand=Match technology:\n' +
        'This ELGi exclusive technology is a breakthrough system that automatically adjusts ' +
        'compressor delivery to match plant demand from 100% to 40%. It works by recirculating ' +
        'air flow within the compressor system, ensuring delivery based on demand \u2014 energy ' +
        'saving and increased reliability.\n' +
        'The system has 2 valves of operating progressive and on-off type, controlled by the ' +
        'N IV controller on a special algorithm based on plant demand.\n' +
        'Air/Oil Separation System:\n' +
        'Receiver tank incorporating OSBIC principle mounted on the base frame\n' +
        'Oil filling port\n' +
        'Oil drain with valve\n' +
        'Pressure relief valve\n' +
        'Oil sight glass\n' +
        'Spin-on air-oil separator element (EQ 11 to EQ 22) or cartridge type air-oil separator ' +
        'element (EQ 30 to EQ 45)\n' +
        'Minimum pressure valve\n' +
        'Cooling System:\n' +
        'Thermal zones for hot and cool air for maximised cooling\n' +
        'High ambient oil cooler for low operating temperature\n' +
        'High efficiency after-cooler for low approach temperature\n' +
        'Cooler mounted in an insulated compartment for easy cleaning\n' +
        'Cooling fan with integrated motor\n' +
        'Lubrication System:\n' +
        'High-capacity spin-on oil-filter element with 10-micron rating\n' +
        'Return oil line from separator tank to air-end\n' +
        'Rigid pipe connections for long life and leak-free operation\n' +
        'Controls System:\n' +
        'Neuron XT controller\n' +
        'Pressure transducer\n' +
        'Temperature sensor\n' +
        'Safety Features:\n' +
        'CE certified package\n' +
        'Optional Features:\n' +
        'Integrated dryer, Air Alert (IoT device) and VFD moisture separator with zero loss ' +
        'drain valve'
    },

    // ELGi's UPTIME Assurance annexure, off PIE/ELGI/QUOT/26-27/383 word for word.
    //
    // I argued for leaving this as an attached PDF: it is ELGi's legal document, and a copy
    // kept here goes stale silently the day ELGi revises a warranty period. PIE's answer
    // settles it — the page exists to be filled in by hand and signed by both sides, and an
    // attachment nobody can sign is worth nothing. So it prints, with its blanks intact.
    //
    // The staleness risk is real and is now PIE's to manage: when ELGi revises the annexure,
    // this text is edited in Settings → Quotation Text. Lines ending in a colon are headings;
    // a line starting with "# " is a field to be completed by hand and prints with a rule.
    {
      id: 'QTPL-COMP-UPTIME', section: 'UptimeWarranty', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', sortOrder: 6, active: 'TRUE',
      title: 'ELGi\u2019s UPTIME Assurance is all about giving customers peace of mind by ' +
        'offering industry\u2019s leading warranty',
      body: 'ELGi warrants that its product and the components for its products will perform ' +
        'the purpose and function for which they are designed and intended for the periods of ' +
        'time indicated below when used, serviced and maintained in accordance with ELGi\u2019s ' +
        'instructions and specification.\n' +
        'To avail this warranty please register with the ELGi Customer Care System (CCS) ' +
        'within 15 days after receipt of the compressor package or within 3 days of ' +
        'commissioning whichever occurs earlier.\n' +
        'EG SERIES:\n' +
        'AIREND \u2014 72 months from the date of start-up (not exceeding 30000 hours) or 78 ' +
        'months from the date of shipment from ELGi factory/warehouse, whichever occurs first.\n' +
        'MAIN MOTOR / COOLER / SEPARATOR TANK \u2014 36 months from the date of start-up or 42 ' +
        'months from the date of shipment from ELGi factory/warehouse, whichever occurs first.\n' +
        'ENCAP SERIES:\n' +
        'AIREND \u2014 36 months from the date of start-up (not to exceed 15000 hrs) or 42 ' +
        'months from the date of shipment from ELGi factory/warehouse, whichever occurs first.\n' +
        'OF SERIES:\n' +
        'AIREND \u2014 48 months from the date of commissioning (not exceeding 30000 hours) or ' +
        '54 months from the date of shipment from the ELGi factory/warehouse, whichever occurs ' +
        'first.\n' +
        'MOTORS (MAIN & OIL) / COOLERS / CAPACITY CONTROL VALVE \u2014 24 months from the date ' +
        'of commissioning or 30 months from the date of shipment from the ELGi ' +
        'factory/warehouse, whichever occurs first.\n' +
        'OTHER COMPRESSOR PARTS:\n' +
        'All other parts, unless explicitly mentioned other than the above, are warranted for ' +
        'a period of 12 months from the date of start-up or 18 months from the date of ' +
        'shipment from ELGi factory/warehouse, whichever occurs first.\n' +
        'WARRANTY COVERAGE:\n' +
        '1st year \u2014 parts, labour and transportation of parts.\n' +
        '2nd year onwards \u2014 parts (ex-works basis) and labour.\n' +
        'If an ELGi product or component of an ELGi product fails to perform as warranted, ' +
        'ELGi will, at its option, repair or replace the product or component of the product ' +
        'as indicated, and upon the terms and provisions set forth below.\n' +
        'WARRANTY CONDITIONS:\n' +
        '1. Compressors shall be installed, operated and maintained as per the ELGi Operation ' +
        '& Maintenance Manual.\n' +
        '2. Commissioning shall be done by ELGi authorised personnel/distributor.\n' +
        '3. Genuine consumables, lubricants and spares shall be used.\n' +
        '4. Compressor shall be preserved if kept idle as per the preservation procedure ' +
        'detailed in the ELGi Operation & Maintenance Manual.\n' +
        '5. ELGi\u2019s free oil sampling programme participation is required as below: ' +
        '(a) if ELGi Airlube UT Syn Fluid is used \u2014 every 4000 hrs/6 months whichever ' +
        'occurs first, or as per the oil sampling report; (b) if ELGi Airlube XD is used ' +
        '\u2014 as recommended by ELGi authorised service personnel.\n' +
        '6. All warranty complaints must be registered with ELGi CCS within 24 hrs.\n' +
        '7. Customer shall maintain water sampling quality as per ELGi\u2019s recommendations ' +
        'given in the OMM with a frequency of every 6 months (OF SERIES).\n' +
        '8. Customer agrees to periodic and sporadic inspection, giving one week\u2019s prior ' +
        'notice, to conduct periodic compressor and its maintenance routine audits (OF SERIES).\n' +
        '9. The customer shall maintain the below documents and produce them if requested ' +
        'prior to any warranty claim: (a) copy of the signed warranty document; (b) proof of ' +
        'purchase of consumables, lubricant and spares; (c) maintenance log.\n' +
        '10. In case the customer wants to take services of ELGi or its dealer\u2019s personnel ' +
        'for carrying out regular maintenance work, the applicable service charges are to be ' +
        'paid by the customer.\n' +
        '11. Warranty on factory repaired/replaced parts shall expire along with this warranty.\n' +
        '12. The benefits of this warranty shall be to the first owner or commercial user only ' +
        'and cannot be transferred.\n' +
        'EXCLUSIONS:\n' +
        '1. Electricals (except motors and controller), rubber parts, seals, and consumables ' +
        'like air filter, oil filter, separator element, lubricant and similar wear and tear ' +
        'parts.\n' +
        '2. Air travel, boarding and lodging expense of service personnel to attend any kind ' +
        'of service or maintenance.\n' +
        'CONDITIONS THAT WILL VOID AND INVALIDATE WARRANTY:\n' +
        '1. Failure to abide by the warranty conditions, unless otherwise given in writing by ' +
        'ELGi, will make the warranty void.\n' +
        '2. Repairs carried out on the package without the prior authorisation by ELGi.\n' +
        '3. Usage of non-genuine spare parts.\n' +
        '4. Nonconformity to ELGi\u2019s operating instructions, specifications, guidelines, ' +
        'maintenance and service instructions.\n' +
        '5. Equipment conditions as a result of normal wear and tear, abnormal and unusually ' +
        'harsh operating conditions, wilful misuse and negligent use of equipment, accidents ' +
        'and shipping damage.\n' +
        '6. Customisation of ELGi supplied compressor package without written consent from ELGi.\n' +
        '7. Re-installation of compressors from one location to another unless otherwise ' +
        'recertified by ELGi authorised personnel.\n' +
        '8. If the compressor is not commissioned within 6 months of receipt unless otherwise ' +
        'recertified by ELGi authorised personnel.\n' +
        '9. If there are any dues in payment towards purchase of equipment, service and spares ' +
        'beyond the agreed payment schedule.\n' +
        'LIMITATION OF LIABILITY:\n' +
        '1. ELGi shall not be liable for any loss of profit, loss of production, loss of income ' +
        'or contract, loss of goodwill, or for indirect or consequential or incidental loss or ' +
        'damage of any kind whatsoever.\n' +
        '2. In no event shall ELGi be liable for any claims or loss having a value higher than ' +
        'the original purchase price of the product.\n' +
        '3. ELGi reserves the right to alter or terminate the warranty programme for any part ' +
        'or units not already covered under this policy.\n' +
        'FORCE MAJEURE:\n' +
        'ELGi is not liable for failure to perform the company\u2019s obligations if such ' +
        'failure is as a result of acts of God (including but not limited to fire, flood, ' +
        'earthquake, storm, hurricane or other natural disaster), war, invasion, act of ' +
        'foreign enemies, hostilities (regardless of whether war is declared), civil war, ' +
        'rebellion, revolution, insurrection, military or usurped power or confiscation, ' +
        'terrorist activities, nationalisation, government sanction, blockage, embargo, labour ' +
        'dispute, strike, lockout or interruption or failure of electricity or telephone ' +
        'service.\n' +
        'USER INFORMATION:\n' +
        '# Company Name\n' +
        '# Address\n' +
        '# Contact Person\n' +
        '# Contact Details\n' +
        'COMPRESSOR DETAILS (to be entered by ELGi authorised personnel):\n' +
        '# Compressor Fab No\n' +
        '# Airend Serial No\n' +
        '# Start-up Date\n' +
        '# Commissioned by\n' +
        '# Place & Date\n' +
        'I have read and accepted all the Terms and Conditions of this agreement completely.\n' +
        '# Customer Seal & Signature\n' +
        '# ELGi Authorised Signatory\n' +
        'DISCLAIMER:\n' +
        'The warranty expressly set forth herein is the only warranty provided by ELGi with ' +
        'respect to its products, and ELGi expressly denies and disclaims all other ' +
        'warranties, either express or implied, and specifically disclaims any implied ' +
        'warranty of merchantability or fitness for a particular purpose.'
    },

    // Things stapled to the offer rather than generated by it. The UPTIME Assurance annexure
    // is ELGi's own legal document, with its own signature block; retyping warranty periods
    // and liability wording into a template is how transcription errors reach a contract. So
    // it is named in the enclosure list and attached as it comes.
    {
      id: 'QTPL-COMP-ENCL', section: 'ExtraEnclosures', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: 'Attached separately',
      sortOrder: 5, active: 'TRUE',
      body: 'UPTIME Warranty'
    },

    {
      id: 'QTPL-COMP-INSTALL', section: 'InstallationNotes', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '',
      title: 'Recommended compressor placement', sortOrder: 4, active: 'TRUE',
      body: 'The entrance to the compressor room should be high enough and wide enough to get ' +
        'the compressor in and out.\n' +
        'Leave a minimum of 1 m space for compressors under 75 kW and 1.5 m for those over ' +
        '75 kW, around the compressor, for safe and proper inspection, cleaning and ' +
        'maintenance activities.\n' +
        'Leave a minimum of 2 m space above the compressor for the hot air to flow away from ' +
        'the compressor (air cooled).\n' +
        'Maintain the room temperature with proper ventilation \u2014 the compressor room ' +
        'temperature should stay within 50\u00b0C (122\u00b0F). Higher suction temperatures result in ' +
        'reduced oil life through a higher discharge oil temperature, so ventilation must be ' +
        'fitted properly.\n' +
        'Ensure the compressor is protected against direct sunlight and rain.\n' +
        'The compressor base should make 100% contact directly with the floor. Do not place the ' +
        'compressor on the wooden pallet supplied with it.\n' +
        'Note: installation and commissioning will be done only after the above recommendations ' +
        'are met.'
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
      body: 'We hope our offer is in line with your requirement and, in case you need any other ' +
        'clarifications, please feel free to contact the undersigned. We look forward to ' +
        'receiving your valuable order.\n\n' +
        'Thanking and assuring you of our utmost attention always,'
    },
    {
      id: 'QTPL-CLOSING-FINAL', section: 'ClosingFinal', brand: 'ELGI',
      businessStream: STREAM_COMPRESSOR, appliesTo: '', title: '', sortOrder: 6, active: 'TRUE',
      body: 'We appreciate your interest in our product and are confident that we will be able ' +
        'to satisfy your requirement. As the next step, I request your time for a ' +
        'techno-commercial discussion on the offer as per your convenience.'
    },
    {
      id: 'QTPL-SPECNOTE', section: 'SpecNote', brand: 'ELGI',
      businessStream: '', appliesTo: '', title: '', sortOrder: 7, active: 'TRUE',
      body: 'At normal working pressure, all data as per ISO 1217, Annex C.'
    },
    {
      id: 'QTPL-SPARE-LABELS', section: 'Labels', brand: 'ELGI',
      businessStream: STREAM_SPARE, appliesTo: '',
      title: 'Wording used on a spares offer', sortOrder: 8, active: 'TRUE',
      // Their spares offer adds the tax in and calls the pre-tax figure "Pre Freight Amount";
      // their compressor offer quotes before tax and calls it "Total package price". Same
      // document, two vocabularies, so the stream picks the one it needs.
      body: 'priceHeading = Annexure-A\n' +
        'packageTotal = Pre Freight Amount\n' +
        'grandTotal = Total Amount\n' +
        'taxRow = Total Tax {rate}%\n' +
        'termsHeading = Terms & Conditions — Annexure B'
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
        // The freight condition, which is standing wording rather than something typed per
        // quotation — theirs reads the same on every compressor offer they send.
        'freightNote = Extra from Ex-works Coimbatore\n' +
        'colDescription = Description\n' +
        'colBasicPrice = Basic price\n' +
        'colQty = Qty\n' +
        'colUnit = Unit\n' +
        'colHsn = HSN code\n' +
        'colTaxRate = Tax rate\n' +
        'colPartNo = Part Number\n' +
        'colPricePer = Price Per\n' +
        'colQuantity = Quantity\n' +
        'colTotalAmount = Total Amount\n' +
        'fabNo = FAB No\n' +
        'modelNo = MODEL No\n' +
        'colSpecification = Specifications\n' +
        'packageTotal = Total package price\n' +
        'discountedTotal = Total discounted price\n' +
        'pf = P&F\n' +
        'freight = Freight\n' +
        'grandTotal = Total amount\n' +
        'taxExtra = EXTRA\n' +
        'taxRow = {rate}% GST\n' +
        'termsHeading = Terms & conditions\n' +
        'enclSpecScope = Technical specifications and scope of supply\n' +
        'enclSpec = Technical specifications\n' +
        'enclPrice = Price schedule\n' +
        'enclTerms = Commercial terms and conditions\n' +
        'enclInstall = Installation guidelines'
    }
  ];
}
