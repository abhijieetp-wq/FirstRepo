/**
 * ERP 2.0's sales visit plans: the customer visits a sales engineer plans for the week or the
 * month, and what each visit found — who they met, what the customer runs today, the
 * competition, interest and the probable purchase timeline. ERP 2's form and rules.
 *
 *   - A visit is planned with an engineer, a date, a company (a customer in the master or a
 *     prospect by name), an area and a purpose. Last week's plan can be copied forward.
 *   - Each area is Local or Outstation (ConfigLists, category VisitArea; ERP 2's list until
 *     Management changes it).
 *   - A visit is Planned, Visited, Not visited or Rescheduled. A visit dated ahead cannot be
 *     marked visited yet.
 *   - "Save & create enquiry" turns a visit into a compressor lead through ERP 1's own lead
 *     save (saveLead): its checks, its numbering, source Field Visit, with the next action
 *     date an open lead always needs. The visit keeps the lead it made.
 *
 * A sales engineer sees and plans their own visits; Sales Coordinators, Management and ERP
 * Admin see everybody's and plan for anybody. Sales work only: service sees none of it.
 *
 * ERP 1's site visit report (SiteVisits, under a compressor opportunity) is a different thing
 * and is unchanged. Shown on the 2.0 face only.
 */

var VISIT_STATUSES = ['Planned', 'Visited', 'Not visited', 'Rescheduled'];
var VISIT_INTEREST = ['Hot', 'Warm', 'Cold'];
var VISIT_PLANNERS = [ROLES.SALES_ENGINEER, ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var VISIT_SEE_ALL = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** ERP 2's lists, used unless the ConfigLists category named beside each has entries. */
var VISIT_LIST_DEFAULTS = {
  purposes: { category: 'VisitPurpose', items: ['New customer – prospecting', 'Follow-up on quotation', 'Technical presentation / demo',
    'Air audit / energy study', 'Existing customer – relationship', 'Payment follow-up'] },
  compTypes: { category: 'CompressorType', items: ['Reciprocating (piston)', 'Screw – oil-lubricated, fixed speed',
    'Screw – oil-lubricated, VFD', 'Screw – oil-free', 'Centrifugal', 'Portable / diesel', 'No compressor yet (new plant)'] },
  brands: { category: 'CompressorBrand', items: ['ELGI', 'Atlas Copco', 'Ingersoll Rand', 'Kaeser', 'Chicago Pneumatic',
    'Kirloskar Pneumatic', 'BOGE', 'Anest Iwata', 'Local / unbranded', 'Other'] },
  timelines: { category: 'PurchaseTimeline', items: ['Immediate (within 1 month)', '1–3 months', '3–6 months', '6–12 months',
    'More than 12 months / next budget', 'Not decided'] },
  // ERP 1's own Industry list, the one the customer and lead forms use, when it has entries.
  industries: { category: 'Industry', items: ['Textile', 'Pharma', 'Food & beverage', 'Foundry & forging', 'Auto components',
    'Plastics & packaging', 'Cement & mining', 'Steel & metals', 'Engineering / fabrication', 'Chemicals', 'Hospital', 'Other'] }
};

/** ERP 2's areas, Local or Outstation, until Management sets PIE's own. */
var VISIT_AREA_DEFAULTS = [
  ['Nagpur City', 'Local'], ['Hingna MIDC', 'Local'], ['Butibori MIDC', 'Local'], ['Kamptee', 'Local'], ['Kalmeshwar', 'Local'],
  ['Wardha', 'Outstation'], ['Chandrapur', 'Outstation'], ['Bhandara', 'Outstation'], ['Gondia', 'Outstation'],
  ['Amravati', 'Outstation'], ['Yavatmal', 'Outstation'], ['Akola', 'Outstation'], ['Gadchiroli', 'Outstation'],
  ['Chh. Sambhajinagar', 'Outstation'], ['Pune', 'Outstation'], ['Nashik', 'Outstation'], ['Mumbai', 'Outstation']
];

function visitConfig_() {
  try { return readTable_('ConfigLists'); } catch (err) { return []; }
}

function visitLists_(config) {
  var out = {};
  Object.keys(VISIT_LIST_DEFAULTS).forEach(function (k) {
    var spec = VISIT_LIST_DEFAULTS[k];
    var own = config.filter(function (r) { return String(r.category) === spec.category && String(r.active).toUpperCase() !== 'FALSE'; })
      .sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0); })
      .map(function (r) { return String(r.label || '').trim(); }).filter(Boolean);
    out[k] = own.length ? own : spec.items.slice();
  });
  return out;
}

/** [{ name, type: 'Local'|'Outstation' }] — Management's list once there is one, ERP 2's before. */
function visitAreas_(config) {
  var rows = config.filter(function (r) { return String(r.category) === 'VisitArea'; });
  if (!rows.length) return VISIT_AREA_DEFAULTS.map(function (a) { return { name: a[0], type: a[1] }; });
  return rows.filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE' && String(r.label || '').trim(); })
    .sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0); })
    .map(function (r) { return { name: String(r.label).trim(), type: String(r.code) === 'Local' ? 'Local' : 'Outstation' }; });
}

/** ERP 2's rule: an area not on the list counts as Outstation. */
function visitAreaType_(name, areas) {
  if (!name) return '';
  var a = areas.filter(function (x) { return x.name.toLowerCase() === String(name).toLowerCase(); })[0];
  return a ? a.type : 'Outstation';
}

function visitPeople_() {
  return readTable_('Users').filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && [ROLES.SALES_ENGINEER, ROLES.SALES_COORDINATOR].indexOf(String(u.role)) !== -1;
  }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email), role: String(u.role) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function visitSame_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function visitLive_(v) { return String(v.active).toUpperCase() !== 'FALSE'; }
function visitSeeAll_(user) { return VISIT_SEE_ALL.indexOf(String(user.role)) !== -1; }
function visitMine_(v, user) { return visitSeeAll_(user) || visitSame_(v.engineerEmail, user.email); }

function visitOut_(v, ctx) {
  var lead = v.leadId ? ctx.leads[String(v.leadId)] : null;
  var num = function (x) { return x === '' || x === null || x === undefined ? '' : Number(x); };
  return {
    id: String(v.id), engineerEmail: String(v.engineerEmail || ''), engineerName: personLine_(v.engineerEmail, ctx.people),
    visitDate: String(v.visitDate || '').slice(0, 10), customerId: String(v.customerId || ''), customerName: String(v.customerName || ''),
    area: String(v.area || ''), areaType: visitAreaType_(v.area, ctx.areas), purpose: String(v.purpose || ''),
    status: String(v.status || 'Planned'), contactMet: String(v.contactMet || ''), phone: String(v.phone || ''),
    industry: String(v.industry || ''), discussion: String(v.discussion || ''), compType: String(v.compType || ''),
    brand: String(v.brand || ''), capacity: String(v.capacity || ''), ageYears: String(v.ageYears || ''),
    considering: String(v.considering || ''), interest: String(v.interest || ''), requirement: String(v.requirement || ''),
    timeline: String(v.timeline || ''), potentialValue: num(v.potentialValue), nextAction: String(v.nextAction || ''),
    nextDate: String(v.nextDate || '').slice(0, 10),
    leadId: String(v.leadId || ''), leadNo: lead ? String(lead.leadNo || '') : '', leadStatus: lead ? String(lead.status || '') : '',
    canEdit: visitMine_(v, ctx.user)
  };
}

function visitCtx_(user, config) {
  var leads = {};
  try { readTable_('Leads').forEach(function (l) { leads[String(l.id)] = l; }); } catch (err) { /* the link is a courtesy */ }
  return { user: user, people: userNameMap_(), areas: visitAreas_(config), leads: leads };
}

function visitIsDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/**
 * The visits in a stretch of days, for the week or month on screen.
 *
 * @param options { from, to: 'yyyy-mm-dd' (at most 62 days), engineer: email or '' for all }
 */
function getVisitPlans(options) {
  var user = getCurrentUser();
  requireRole_(user, VISIT_PLANNERS);
  var o = options || {};
  var today = todayIso_();
  var from = visitIsDate_(o.from) ? String(o.from) : today;
  var to = visitIsDate_(o.to) ? String(o.to) : addDays_(from, 6);
  if (to < from) throw new Error('The range ends before it starts.');
  if (daysBetween_(from, to) > 62) throw new Error('Ask for two months at most.');
  var seeAll = visitSeeAll_(user);
  var engineer = seeAll ? String(o.engineer || '') : String(user.email);
  var config = visitConfig_();
  var ctx = visitCtx_(user, config);
  var rows = readTable_('SalesVisits').filter(function (v) {
    var d = String(v.visitDate || '').slice(0, 10);
    return visitLive_(v) && d >= from && d <= to && visitMine_(v, user) && (!engineer || visitSame_(v.engineerEmail, engineer));
  }).map(function (v) { return visitOut_(v, ctx); })
    .sort(function (a, b) { return a.visitDate.localeCompare(b.visitDate) || a.customerName.localeCompare(b.customerName); });
  var customers = readTable_('Customers').filter(function (c) { return String(c.active).toUpperCase() !== 'FALSE'; })
    .map(function (c) { return { id: String(c.id), name: String(c.name || '') }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  return {
    from: from, to: to, today: today, me: String(user.email), seeAll: seeAll, engineer: engineer,
    people: visitPeople_(), areas: ctx.areas, lists: visitLists_(config), statuses: VISIT_STATUSES, interest: VISIT_INTEREST,
    customers: customers, canEditAreas: MASTER_EDITORS.indexOf(String(user.role)) !== -1, visits: rows
  };
}

/**
 * Plans a visit, or saves what it found. Fields an edit does not send are kept.
 *
 * @param input { id?, engineerEmail, visitDate, customerId?, customerName, area, purpose, status,
 *        contactMet, phone, industry, discussion, compType, brand, capacity, ageYears, considering,
 *        interest, requirement, timeline, potentialValue, nextAction, nextDate }
 */
function saveVisit(input) {
  var user = getCurrentUser();
  requireRole_(user, VISIT_PLANNERS);
  var i = input || {};
  var id = String(i.id || '').trim();
  var existing = id ? findRowById_('SalesVisits', id) : null;
  if (id && (!existing || !visitLive_(existing) || !visitMine_(existing, user))) throw new Error('That visit is no longer there.');
  var keep = function (k) {
    return Object.prototype.hasOwnProperty.call(i, k) ? i[k] : existing ? existing[k] : '';
  };
  var text = function (k) { return String(keep(k) === null || keep(k) === undefined ? '' : keep(k)).trim(); };
  var config = visitConfig_();
  var lists = visitLists_(config);
  var areas = visitAreas_(config);

  var engineer;
  if (!visitSeeAll_(user)) {
    engineer = String(user.email);
  } else {
    var who = visitPeople_().filter(function (p) { return visitSame_(p.email, keep('engineerEmail')); })[0];
    if (!who) throw new Error('Pick the sales engineer or coordinator making the visit.');
    engineer = who.email;
  }
  var date = text('visitDate').slice(0, 10);
  if (!visitIsDate_(date)) throw new Error('Give the date of the visit.');
  var company = text('customerName');
  if (!company) throw new Error('Name the company to visit.');
  var customerId = text('customerId');
  var customers = readTable_('Customers');
  if (customerId && !customers.some(function (c) { return String(c.id) === customerId; })) customerId = '';
  // A company typed exactly as a customer in the master is that customer.
  if (!customerId) {
    var match = customers.filter(function (c) { return visitSame_(c.name, company); })[0];
    if (match) customerId = String(match.id);
  }
  var area = text('area');
  if (area && !areas.some(function (a) { return a.name.toLowerCase() === area.toLowerCase(); })) {
    throw new Error('Pick the area from the list. Management adds areas there.');
  }
  var status = text('status') || 'Planned';
  if (VISIT_STATUSES.indexOf(status) === -1) throw new Error('A visit is Planned, Visited, Not visited or Rescheduled.');
  var today = todayIso_();
  if (status === 'Visited' && date > today) throw new Error('A visit on ' + date + ' cannot be marked visited yet.');
  var interest = text('interest');
  if (interest && VISIT_INTEREST.indexOf(interest) === -1) throw new Error('Interest is Hot, Warm or Cold.');
  var potential = text('potentialValue');
  if (potential !== '' && (!isFinite(Number(potential)) || Number(potential) < 0)) throw new Error('Give the potential value in rupees.');
  var nextDate = text('nextDate').slice(0, 10);
  if (nextDate && !visitIsDate_(nextDate)) throw new Error('Give the next action date as a date.');

  var now = nowIso_();
  var record = {
    engineerEmail: engineer, visitDate: date, customerId: customerId, customerName: company, area: area,
    purpose: text('purpose') || (existing ? '' : lists.purposes[0]), status: status,
    contactMet: text('contactMet'), phone: text('phone'), industry: text('industry'), discussion: text('discussion'),
    compType: text('compType'), brand: text('brand'), capacity: text('capacity'), ageYears: text('ageYears'),
    considering: text('considering'), interest: interest, requirement: text('requirement'), timeline: text('timeline'),
    potentialValue: potential === '' ? '' : Number(potential), nextAction: text('nextAction'), nextDate: nextDate,
    updatedAt: now, updatedBy: user.email
  };
  if (status === 'Visited' && !(existing && existing.visitedAt)) record.visitedAt = now;
  if (existing) {
    updateRowById_('SalesVisits', 'id', id, record, 'Visit saved');
  } else {
    id = generateId_('VS-');
    record.id = id;
    record.active = 'TRUE';
    record.createdAt = now;
    record.createdBy = user.email;
    appendRow_('SalesVisits', record, 'Visit planned');
  }
  return visitOut_(findRowById_('SalesVisits', id), visitCtx_(user, config));
}

/** Takes a visit off the plan. It stays on record. */
function deleteVisit(id) {
  var user = getCurrentUser();
  requireRole_(user, VISIT_PLANNERS);
  var v = findRowById_('SalesVisits', id);
  if (!v || !visitLive_(v) || !visitMine_(v, user)) throw new Error('That visit is no longer there.');
  updateRowById_('SalesVisits', 'id', id, { active: 'FALSE', updatedAt: nowIso_(), updatedBy: user.email }, 'Visit removed');
  return { deleted: true, customerName: String(v.customerName || '') };
}

/**
 * Last week's plan, copied to the week starting `weekStart`: the same companies, areas and
 * purposes, a week later, Planned. A visit already on the plan that day is not copied twice.
 *
 * @param options { weekStart: 'yyyy-mm-dd' (a Monday), engineer: email or '' }
 */
function copyLastWeekVisits(options) {
  var user = getCurrentUser();
  requireRole_(user, VISIT_PLANNERS);
  var o = options || {};
  if (!visitIsDate_(o.weekStart)) throw new Error('Say which week to copy into.');
  var start = String(o.weekStart);
  var engineer = visitSeeAll_(user) ? String(o.engineer || '') : String(user.email);
  var all = readTable_('SalesVisits').filter(function (v) { return visitLive_(v) && visitMine_(v, user); });
  var lastWeek = all.filter(function (v) {
    var d = String(v.visitDate || '').slice(0, 10);
    return d >= addDays_(start, -7) && d < start && (!engineer || visitSame_(v.engineerEmail, engineer));
  });
  if (!lastWeek.length) throw new Error('Nothing was planned last week to copy.');
  var there = {};
  all.forEach(function (v) {
    there[String(v.engineerEmail).toLowerCase() + '|' + String(v.visitDate).slice(0, 10) + '|' + String(v.customerName).toLowerCase()] = true;
  });
  var now = nowIso_();
  var copied = 0;
  for (var v of lastWeek) {
    var date = addDays_(String(v.visitDate).slice(0, 10), 7);
    var key = String(v.engineerEmail).toLowerCase() + '|' + date + '|' + String(v.customerName).toLowerCase();
    if (there[key]) continue;
    there[key] = true;
    appendRow_('SalesVisits', {
      id: generateId_('VS-'), engineerEmail: v.engineerEmail, visitDate: date, customerId: v.customerId || '',
      customerName: v.customerName, area: v.area || '', purpose: v.purpose || '', status: 'Planned', active: 'TRUE',
      createdAt: now, createdBy: user.email, updatedAt: now, updatedBy: user.email
    }, 'Visit copied from the week before');
    copied++;
  }
  return { copied: copied, skipped: lastWeek.length - copied };
}

/**
 * A visit made into a compressor lead, through ERP 1's own lead save: source Field Visit,
 * the visit's company, contact, area, industry, requirement and potential, owned by a Sales
 * Coordinator on the compressor desk. The visit is marked visited and keeps the lead.
 */
function createVisitEnquiry(id) {
  var user = getCurrentUser();
  requireRole_(user, VISIT_PLANNERS);
  var v = findRowById_('SalesVisits', id);
  if (!v || !visitLive_(v) || !visitMine_(v, user)) throw new Error('That visit is no longer there.');
  if (String(v.leadId || '')) throw new Error('This visit has already made an enquiry.');
  var date = String(v.visitDate || '').slice(0, 10);
  var today = todayIso_();
  if (date > today) throw new Error('The visit is on ' + date + '. Make the enquiry once the visit has happened.');
  var next = String(v.nextDate || '').slice(0, 10);
  if (!next) throw new Error('Set the next action date first — ERP 1 needs one on every open lead.');
  var users = readTable_('Users');
  var engineer = users.filter(function (u) { return visitSame_(u.email, v.engineerEmail); })[0] || {};
  // The coordinator who will run the lead: the visit's own, when a coordinator made it;
  // otherwise the first coordinator on the compressor desk, as ERP 2 does.
  var owner = String(engineer.role) === ROLES.SALES_COORDINATOR ? String(engineer.email) : (users.filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && String(u.role) === ROLES.SALES_COORDINATOR &&
      ['All', STREAM_COMPRESSOR, ''].indexOf(String(u.businessStream || '')) !== -1;
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })[0] || {}).email || String(user.email);
  var inUse = [v.brand, v.compType, v.capacity].map(function (x) { return String(x || '').trim(); }).filter(Boolean).join(' · ');
  var lead = saveLead({
    date: today, customerId: String(v.customerId || ''), customerName: String(v.customerName || ''),
    contactName: String(v.contactMet || ''), contactPhone: String(v.phone || ''), prospectCity: String(v.area || ''),
    source: 'Field Visit', industry: String(v.industry || ''),
    // The visit's area, while it is still on the list.
    area: visitAreas_(visitConfig_()).some(function (a) { return a.name === String(v.area || ''); }) ? String(v.area || '') : '',
    requirementSummary: (String(v.requirement || '').trim() || String(v.discussion || '').trim() || 'From a customer visit') +
      (inUse ? ' (in use: ' + inUse + ')' : ''),
    budget: v.potentialValue === '' || v.potentialValue === null || v.potentialValue === undefined ? '' : Number(v.potentialValue),
    salesEngineerEmail: String(engineer.role) === ROLES.SALES_ENGINEER ? String(engineer.email) : '',
    ownerEmail: owner, status: 'Qualified', nextActionDate: next
  });
  var patch = { leadId: String(lead.id), updatedAt: nowIso_(), updatedBy: user.email };
  if (String(v.status || 'Planned') === 'Planned') { patch.status = 'Visited'; patch.visitedAt = nowIso_(); }
  updateRowById_('SalesVisits', 'id', id, patch, 'Enquiry ' + lead.leadNo + ' made from the visit');
  var config = visitConfig_();
  return { leadId: String(lead.id), leadNo: String(lead.leadNo || ''), visit: visitOut_(findRowById_('SalesVisits', id), visitCtx_(user, config)) };
}

/** The areas, each Local or Outstation. Management and ERP Admin. */
function saveVisitAreas(list) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var seen = {};
  var clean = (list || []).map(function (a) {
    var name = String((a && a.name) || '').trim();
    var type = String((a && a.type) || '');
    if (!name) throw new Error('Every area needs a name.');
    if (name.length > 60) throw new Error('Keep an area’s name under 60 characters.');
    if (['Local', 'Outstation'].indexOf(type) === -1) throw new Error(name + ' must be Local or Outstation.');
    if (seen[name.toLowerCase()]) throw new Error(name + ' is on the list twice.');
    seen[name.toLowerCase()] = true;
    return { name: name, type: type };
  });
  if (!clean.length) throw new Error('Keep at least one area.');
  var existing = visitConfig_().filter(function (r) { return String(r.category) === 'VisitArea'; });
  var byName = {};
  existing.forEach(function (r) { byName[String(r.label || '').trim().toLowerCase()] = r; });
  var order = 0;
  for (var a of clean) {
    order++;
    var row = byName[a.name.toLowerCase()];
    saveConfigListItem({ id: row ? String(row.id) : '', category: 'VisitArea', code: a.type, label: a.name, sortOrder: order });
  }
  for (var r of existing) {
    if (seen[String(r.label || '').trim().toLowerCase()] || String(r.active).toUpperCase() === 'FALSE') continue;
    saveConfigListItem({ id: String(r.id), category: 'VisitArea', code: String(r.code), label: String(r.label), sortOrder: r.sortOrder, active: false });
  }
  return visitAreas_(visitConfig_());
}

/** This week's visits for the person's dashboard, Monday to Sunday. Management: everybody's. */
function visitSummary_(email, everyone) {
  var today = todayIso_();
  var d = new Date(today + 'T00:00:00Z');
  var monday = addDays_(today, -((d.getUTCDay() + 6) % 7));
  var sunday = addDays_(monday, 6);
  var rows = [];
  try { rows = readTable_('SalesVisits'); } catch (err) { return null; }
  var week = rows.filter(function (v) {
    var day = String(v.visitDate || '').slice(0, 10);
    return visitLive_(v) && day >= monday && day <= sunday && (everyone || visitSame_(v.engineerEmail, email));
  });
  return {
    planned: week.length,
    visited: week.filter(function (v) { return String(v.status) === 'Visited'; }).length,
    today: week.filter(function (v) { return String(v.visitDate).slice(0, 10) === today && String(v.status || 'Planned') === 'Planned'; }).length,
    enquiries: week.filter(function (v) { return String(v.leadId || ''); }).length
  };
}

/** The areas, each Local or Outstation, for any form that asks for one. */
function getAreas() {
  getCurrentUser();
  return visitAreas_(visitConfig_());
}
