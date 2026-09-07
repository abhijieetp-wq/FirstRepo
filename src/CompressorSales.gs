/**
 * Compressor sales front office — M02, M03, M04.
 *
 * The flow the blueprint describes:
 *   lead → qualification → site visit → technical requirement → compressor selection →
 *   opportunity funnel → quotation
 *
 * The pieces that matter as controls rather than record-keeping:
 *   - every open lead and opportunity must carry a next action, so nothing goes quiet
 *     unnoticed (FR-007) — overdue ones surface in the list;
 *   - a compressor quotation cannot be raised until the technical requirement is captured,
 *     because sizing a machine from guesswork is the expensive mistake on this side of the
 *     business (FR-009);
 *   - losing an opportunity requires a reason and, where known, the competitor (FR-013).
 */

var LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Converted', 'Disqualified'];
var LEAD_EDITORS = [ROLES.SALES_ENGINEER, ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Default win probability per funnel stage, used for the weighted pipeline (FR-012).
 * A user can override the figure on any individual opportunity.
 */
var STAGE_PROBABILITY = {
  'Requirement Identified': 10,
  'Technical Discussion': 25,
  'Quotation': 50,
  'Negotiation': 70,
  'PO Expected': 90,
  'Won': 100,
  'Lost': 0
};

// ------------------------------------------------------------------ leads

function listLeads(options) {
  var user = getCurrentUser();
  var opts = options || {};

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var rows = readTable_('Leads').map(function (l) {
    var row = stripRow_(l);
    row.customerName = customerNames[String(row.customerId)] || row.customerName || '';
    row.overdue = row.nextActionDate && String(row.nextActionDate) < todayIso_() &&
      ['Converted', 'Disqualified'].indexOf(row.status) === -1;
    return row;
  });

  if (opts.mineOnly) {
    rows = rows.filter(function (r) { return String(r.ownerEmail).toLowerCase() === user.email.toLowerCase(); });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (r) { return ['Converted', 'Disqualified'].indexOf(r.status) === -1; });
  }
  return rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
}

function saveLead(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);

  if (!input.customerId) throw new Error('Pick the customer this lead is from.');
  var status = String(input.status || 'New').trim();
  if (LEAD_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + LEAD_STATUSES.join(', ') + '.');
  }
  if (status === 'Disqualified' && !String(input.lostReasonId || '').trim()) {
    throw new Error('Pick a reason before disqualifying a lead.');
  }
  // FR-007: an open lead without a next action is how follow-ups get forgotten.
  if (['Converted', 'Disqualified'].indexOf(status) === -1 && !String(input.nextActionDate || '').trim()) {
    throw new Error('Set a next action date — an open lead must always have one.');
  }

  var record = {
    date: String(input.date || todayIso_()).slice(0, 10),
    customerId: String(input.customerId),
    customerName: String(input.customerName || '').trim(),
    contactName: String(input.contactName || '').trim(),
    contactPhone: String(input.contactPhone || '').trim(),
    source: String(input.source || '').trim(),
    requirementSummary: String(input.requirementSummary || '').trim(),
    industry: String(input.industry || '').trim(),
    application: String(input.application || '').trim(),
    urgency: String(input.urgency || 'Normal').trim(),
    budget: input.budget === '' || input.budget === undefined || input.budget === null ? '' : Number(input.budget),
    ownerEmail: String(input.ownerEmail || user.email).trim(),
    status: status,
    nextActionDate: String(input.nextActionDate || '').slice(0, 10),
    lostReasonId: String(input.lostReasonId || '').trim(),
    businessStream: STREAM_COMPRESSOR,
    brand: String(input.brand || 'ELGI').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('Leads', 'id', input.id, record, 'Lead updated');
  } else {
    record.id = generateId_('LD-');
    record.leadNo = nextSeriesNo_('Leads', 'leadNo', 'LD');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Leads', record, 'Lead captured');
  }
  return record;
}

/** Promotes a qualified lead into the funnel, carrying its context across. */
function convertLeadToOpportunity(leadId, input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);

  var lead = readTable_('Leads').filter(function (l) { return String(l.id) === String(leadId); })[0];
  if (!lead) throw new Error('That lead no longer exists.');
  if (lead.status === 'Converted') {
    throw new Error('This lead has already been converted. Open the opportunity from the Pipeline.');
  }

  var opts = input || {};
  var opportunity = saveOpportunity({
    customerId: lead.customerId,
    leadId: lead.id,
    title: String(opts.title || lead.requirementSummary || 'Compressor requirement').trim(),
    stage: 'Requirement Identified',
    expectedValue: opts.expectedValue !== undefined && opts.expectedValue !== '' ? opts.expectedValue : lead.budget,
    expectedCloseDate: opts.expectedCloseDate || addDays_(todayIso_(), 30),
    ownerEmail: lead.ownerEmail || user.email,
    nextActionDate: opts.nextActionDate || addDays_(todayIso_(), 7)
  });

  updateRowById_('Leads', 'id', leadId, { status: 'Converted' },
    'Converted to opportunity ' + opportunity.opportunityNo);
  return opportunity;
}

// ------------------------------------------------------------------ opportunities

function listOpportunities(options) {
  var user = getCurrentUser();
  var opts = options || {};

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var quotesByOpportunity = {};
  readTable_('Quotations').forEach(function (q) {
    if (!q.opportunityId) return;
    var key = String(q.opportunityId);
    (quotesByOpportunity[key] = quotesByOpportunity[key] || []).push({
      id: q.id, quoteNo: q.quoteNo, revision: q.revision, status: q.status, grand: Number(q.grand) || 0
    });
  });

  var techByOpportunity = {};
  readTable_('TechnicalRequirements').forEach(function (t) {
    if (t.opportunityId) techByOpportunity[String(t.opportunityId)] = stripRow_(t);
  });

  var rows = readTable_('Opportunities').map(function (o) {
    var row = stripRow_(o);
    row.customerName = customerNames[String(row.customerId)] || '';
    row.quotations = quotesByOpportunity[String(row.id)] || [];
    row.hasTechnicalRequirement = !!techByOpportunity[String(row.id)];
    var value = Number(row.expectedValue) || 0;
    var probability = row.probability === '' || row.probability === null || row.probability === undefined
      ? (STAGE_PROBABILITY[row.stage] || 0)
      : Number(row.probability);
    row.probability = probability;
    // Weighted pipeline (FR-012): value discounted by the chance of winning it.
    row.weightedValue = roundMoney_(value * probability / 100);
    row.overdue = row.nextActionDate && String(row.nextActionDate) < todayIso_() &&
      ['Won', 'Lost'].indexOf(row.stage) === -1;
    return row;
  });

  if (opts.mineOnly) {
    rows = rows.filter(function (r) { return String(r.ownerEmail).toLowerCase() === user.email.toLowerCase(); });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (r) { return ['Won', 'Lost'].indexOf(r.stage) === -1; });
  }
  return rows.sort(function (a, b) {
    return String(b.expectedCloseDate || '').localeCompare(String(a.expectedCloseDate || ''));
  });
}

function saveOpportunity(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);

  if (!input.customerId) throw new Error('An opportunity needs a customer.');
  var stage = String(input.stage || 'Requirement Identified').trim();
  if (OPPORTUNITY_STAGES.indexOf(stage) === -1) {
    throw new Error('Stage must be one of: ' + OPPORTUNITY_STAGES.join(', ') + '.');
  }
  // FR-013: a lost opportunity must record why, and the competitor where it is known.
  if (stage === 'Lost' && !String(input.lostReasonId || '').trim()) {
    throw new Error('Pick a lost reason before marking this opportunity Lost.');
  }
  if (['Won', 'Lost'].indexOf(stage) === -1 && !String(input.nextActionDate || '').trim()) {
    throw new Error('Set a next action date — an open opportunity must always have one.');
  }

  var probability = input.probability === '' || input.probability === undefined || input.probability === null
    ? (STAGE_PROBABILITY[stage] || 0)
    : Number(input.probability);
  if (isNaN(probability) || probability < 0 || probability > 100) {
    throw new Error('Probability must be between 0 and 100.');
  }

  var record = {
    date: String(input.date || todayIso_()).slice(0, 10),
    customerId: String(input.customerId),
    leadId: String(input.leadId || '').trim(),
    title: String(input.title || '').trim() || 'Compressor requirement',
    stage: stage,
    expectedValue: input.expectedValue === '' || input.expectedValue === undefined || input.expectedValue === null
      ? '' : Number(input.expectedValue),
    probability: probability,
    expectedCloseDate: String(input.expectedCloseDate || '').slice(0, 10),
    competitor: String(input.competitor || '').trim(),
    lostReasonId: String(input.lostReasonId || '').trim(),
    lostNotes: String(input.lostNotes || '').trim(),
    ownerEmail: String(input.ownerEmail || user.email).trim(),
    nextActionDate: String(input.nextActionDate || '').slice(0, 10),
    businessStream: STREAM_COMPRESSOR,
    brand: String(input.brand || 'ELGI').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('Opportunities', 'id', input.id, record, 'Opportunity updated');
  } else {
    record.id = generateId_('OP-');
    record.opportunityNo = nextSeriesNo_('Opportunities', 'opportunityNo', 'OP');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Opportunities', record, 'Opportunity created');
  }
  return getOpportunity(record.id);
}

function getOpportunity(id) {
  getCurrentUser();
  var o = readTable_('Opportunities').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!o) throw new Error('Opportunity not found.');
  var row = stripRow_(o);

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(row.customerId);
  })[0];
  row.customerName = customer ? customer.name : '';

  row.technicalRequirement = readTable_('TechnicalRequirements').filter(function (t) {
    return String(t.opportunityId) === String(id);
  }).map(stripRow_)[0] || null;

  row.selections = readTable_('CompressorSelections')
    .filter(function (s) { return String(s.opportunityId) === String(id); })
    .map(stripRow_);

  row.siteVisits = readTable_('SiteVisits')
    .filter(function (v) { return String(v.opportunityId) === String(id); })
    .map(stripRow_)
    .sort(function (a, b) { return String(b.visitDate).localeCompare(String(a.visitDate)); });

  row.activities = readTable_('Activities')
    .filter(function (a) { return a.relatedType === 'Opportunity' && String(a.relatedId) === String(id); })
    .map(stripRow_)
    .sort(function (a, b) { return String(b.activityDate).localeCompare(String(a.activityDate)); });

  row.quotations = readTable_('Quotations')
    .filter(function (q) { return String(q.opportunityId) === String(id); })
    .map(function (q) {
      return { id: q.id, quoteNo: q.quoteNo, revision: q.revision, status: q.status, grand: Number(q.grand) || 0 };
    });

  var probability = row.probability === '' || row.probability === null
    ? (STAGE_PROBABILITY[row.stage] || 0) : Number(row.probability);
  row.probability = probability;
  row.weightedValue = roundMoney_((Number(row.expectedValue) || 0) * probability / 100);
  return row;
}

// ------------------------------------------------------------------ technical work

/**
 * The technical requirement sheet (FR-009). This is what a compressor quotation is sized
 * from, so the fields that determine the machine are mandatory rather than advisory.
 */
function saveTechnicalRequirement(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);
  if (!input.opportunityId) throw new Error('A technical requirement belongs to an opportunity.');

  var application = String(input.application || '').trim();
  var requiredFad = String(input.requiredFad || '').trim();
  var workingPressure = String(input.workingPressure || '').trim();
  if (!application || !requiredFad || !workingPressure) {
    throw new Error('Application, required FAD and working pressure are needed — a compressor ' +
      'cannot be sized without them.');
  }

  var opportunity = readTable_('Opportunities').filter(function (o) {
    return String(o.id) === String(input.opportunityId);
  })[0];

  var record = {
    opportunityId: String(input.opportunityId),
    leadId: opportunity ? String(opportunity.leadId || '') : '',
    customerId: opportunity ? String(opportunity.customerId) : '',
    application: application,
    requiredFad: requiredFad,
    workingPressure: workingPressure,
    dutyCycle: String(input.dutyCycle || '').trim(),
    operatingHours: String(input.operatingHours || '').trim(),
    airQuality: String(input.airQuality || '').trim(),
    powerSupply: String(input.powerSupply || '').trim(),
    futureExpansion: String(input.futureExpansion || '').trim(),
    existingCompressor: String(input.existingCompressor || '').trim(),
    notes: String(input.notes || '').trim()
  };

  var existing = readTable_('TechnicalRequirements').filter(function (t) {
    return String(t.opportunityId) === String(input.opportunityId);
  })[0];

  if (existing) {
    record.id = existing.id;
    updateRowById_('TechnicalRequirements', 'id', existing.id, record, 'Technical requirement updated');
  } else {
    record.id = generateId_('TR-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('TechnicalRequirements', record, 'Technical requirement captured');
  }
  return getOpportunity(input.opportunityId);
}

/** Records the recommended machine and accessories against the requirement (FR-010). */
function saveCompressorSelection(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);
  if (!input.opportunityId) throw new Error('A selection belongs to an opportunity.');
  if (!input.productId) throw new Error('Pick the recommended compressor from the catalog.');

  var product = readTable_('Products').filter(function (p) {
    return String(p.id) === String(input.productId);
  })[0];
  if (!product) throw new Error('That product is no longer in the catalog.');

  var tech = readTable_('TechnicalRequirements').filter(function (t) {
    return String(t.opportunityId) === String(input.opportunityId);
  })[0];

  var record = {
    technicalRequirementId: tech ? tech.id : '',
    opportunityId: String(input.opportunityId),
    productId: String(input.productId),
    productCode: product.productCode,
    hpRating: product.hpRating,
    workingPressure: product.workingPressure,
    fad: product.fad,
    dryer: String(input.dryer || '').trim(),
    receiver: String(input.receiver || '').trim(),
    filters: String(input.filters || '').trim(),
    accessories: String(input.accessories || '').trim(),
    notes: String(input.notes || '').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('CompressorSelections', 'id', input.id, record, 'Selection updated');
  } else {
    record.id = generateId_('CS-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('CompressorSelections', record, 'Compressor selected');
  }
  return getOpportunity(input.opportunityId);
}

function deleteCompressorSelection(id) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);
  var row = readTable_('CompressorSelections').filter(function (s) { return String(s.id) === String(id); })[0];
  if (!row) throw new Error('That selection no longer exists.');
  deleteRowById_('CompressorSelections', 'id', id, 'Selection removed');
  return getOpportunity(row.opportunityId);
}

// ------------------------------------------------------------------ visits and activities

function saveSiteVisit(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);
  if (!input.opportunityId) throw new Error('A site visit belongs to an opportunity.');
  if (!String(input.visitDate || '').trim()) throw new Error('Enter the visit date.');

  var opportunity = readTable_('Opportunities').filter(function (o) {
    return String(o.id) === String(input.opportunityId);
  })[0];

  var record = {
    opportunityId: String(input.opportunityId),
    leadId: opportunity ? String(opportunity.leadId || '') : '',
    customerId: opportunity ? String(opportunity.customerId) : '',
    visitDate: String(input.visitDate).slice(0, 10),
    participants: String(input.participants || '').trim(),
    objective: String(input.objective || '').trim(),
    existingEquipment: String(input.existingEquipment || '').trim(),
    observations: String(input.observations || '').trim(),
    nextSteps: String(input.nextSteps || '').trim(),
    attachmentUrl: String(input.attachmentUrl || '').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('SiteVisits', 'id', input.id, record, 'Site visit updated');
  } else {
    record.id = generateId_('SV-');
    record.visitNo = nextSeriesNo_('SiteVisits', 'visitNo', 'SV');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('SiteVisits', record, 'Site visit logged');
  }
  return getOpportunity(input.opportunityId);
}

/** A dated note against a lead or opportunity, which can also move the next action (FR-007). */
function saveActivity(input) {
  var user = getCurrentUser();
  requireRole_(user, LEAD_EDITORS);
  var relatedType = String(input.relatedType || '').trim();
  if (['Lead', 'Opportunity', 'Quotation'].indexOf(relatedType) === -1) {
    throw new Error('relatedType must be Lead, Opportunity or Quotation.');
  }
  if (!input.relatedId) throw new Error('relatedId is required.');
  if (!String(input.notes || '').trim()) throw new Error('Write what happened.');

  var record = {
    id: generateId_('ACT-'),
    relatedType: relatedType,
    relatedId: String(input.relatedId),
    activityType: String(input.activityType || 'Call').trim(),
    activityDate: String(input.activityDate || todayIso_()).slice(0, 10),
    ownerEmail: user.email,
    contactPerson: String(input.contactPerson || '').trim(),
    notes: String(input.notes || '').trim(),
    outcome: String(input.outcome || '').trim(),
    nextActionDate: String(input.nextActionDate || '').slice(0, 10),
    status: 'Logged',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('Activities', record, 'Activity logged');

  // Logging an activity is the natural moment to move the follow-up date along.
  if (record.nextActionDate) {
    var tab = relatedType === 'Lead' ? 'Leads' : (relatedType === 'Opportunity' ? 'Opportunities' : null);
    if (tab) {
      updateRowById_(tab, 'id', record.relatedId, { nextActionDate: record.nextActionDate },
        'Next action moved by an activity');
    }
  }
  return record;
}

function listActivities(relatedType, relatedId) {
  getCurrentUser();
  return readTable_('Activities')
    .filter(function (a) {
      return a.relatedType === relatedType && String(a.relatedId) === String(relatedId);
    })
    .map(stripRow_)
    .sort(function (a, b) { return String(b.activityDate).localeCompare(String(a.activityDate)); });
}

// ------------------------------------------------------------------ helpers

/** Shared numbering: PREFIXyyMM-001, continuing from the highest already issued. */
function nextSeriesNo_(tabName, field, prefix) {
  var yy = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyMM');
  var full = prefix + yy + '-';
  var highest = 0;
  readTable_(tabName).forEach(function (r) {
    var m = new RegExp('^' + full + '(\\d+)$').exec(String(r[field] || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return full + String(highest + 1).padStart(3, '0');
}
