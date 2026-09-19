/**
 * Who may approve what, and why.
 *
 * PIE do not treat every customer the same, and the rules they work to are about trust earned
 * over time rather than about the size of the order:
 *
 *   - a regular customer's offer goes straight out; nobody signs it off
 *   - a new customer's offer needs Management, and only Management
 *   - an occasional buyer's offer needs Management or the sales coordinator in charge
 *
 * The same distinction governs money owed. A customer with an agreed credit limit who is
 * inside it on invoices already raised has not broken anything — the hold came from orders
 * still in the pipeline — so the coordinator can release it. A customer with no limit agreed
 * at all, or one who has genuinely run past the limit on billed money, is Management's call.
 *
 * Keeping these in one file is deliberate: they are the rules the business argues about, and
 * they should be readable in one place rather than inferred from four screens.
 */

var CUSTOMER_CATEGORIES = ['Regular', 'New', 'Occasional'];

/**
 * Whether a quotation needs signing off before it is sent, and by whom.
 *
 * An unclassified customer follows the general rule PIE stated first — Management or the
 * coordinator — rather than the most permissive one. Somebody forgetting to categorise a
 * customer must not be the way an offer escapes review.
 */
function quoteApprovalRule_(customer) {
  var category = customer ? String(customer.customerCategory || '').trim() : '';

  if (category === 'Regular') {
    return {
      category: category,
      required: false,
      approvers: [],
      why: 'A regular customer’s offer goes out without sign-off.'
    };
  }
  if (category === 'New') {
    return {
      category: category,
      required: true,
      approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN],
      why: 'A new customer’s offer needs Management approval before it is sent.'
    };
  }
  return {
    category: category || 'Unclassified',
    required: true,
    approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN, ROLES.SALES_COORDINATOR],
    why: category === 'Occasional'
      ? 'An occasional buyer’s offer needs Management or the sales coordinator in charge.'
      : 'This customer has no category set, so the general rule applies: Management or the ' +
        'sales coordinator in charge must approve before it is sent.'
  };
}

/**
 * Who may lift a credit hold on this order.
 *
 * The question is not how big the exposure is but whether the customer has broken an agreement.
 * Money already invoiced and unpaid is the agreement; orders not yet billed are forecast. So a
 * customer inside their limit on invoiced money is the coordinator's to release, and one who is
 * past it — or who was never given a limit — is Management's.
 */
function creditReleaseRule_(customer, check) {
  var limit = customer && customer.creditLimit !== '' && customer.creditLimit !== null
    ? Number(customer.creditLimit) : null;
  var outstanding = Number(check && check.outstandingAmt) || 0;

  if (limit === null || isNaN(limit) || limit <= 0) {
    return {
      approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN],
      why: 'No credit limit has been agreed for this customer, so the decision is Management’s.'
    };
  }
  if (outstanding > limit) {
    return {
      approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN],
      why: 'Invoiced and unpaid ' + inr_(outstanding) + ' is already past the agreed ' +
        'limit of ' + inr_(limit) + ', so the decision is Management’s.'
    };
  }
  // The advance is a term of this order rather than a standing agreement, so a shortfall on it
  // is not something the coordinator can waive.
  if (Number(check && check.advanceRequired) > Number(check && check.advanceReceived)) {
    return {
      approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN],
      why: 'The advance agreed for this order has not been received, so the decision is ' +
        'Management’s.'
    };
  }
  return {
    approvers: [ROLES.MANAGEMENT, ROLES.ERP_ADMIN, ROLES.SALES_COORDINATOR],
    why: 'Invoiced and unpaid ' + inr_(outstanding) + ' is within the agreed limit of ' +
      inr_(limit) + ' — the hold comes from orders not yet billed, so the sales ' +
      'coordinator can release it.'
  };
}

/** The credit check a hold was raised from, newest first. */
function openCreditCheckFor_(salesOrderId) {
  var checks = findRowsByColumn_('CreditChecks', 'salesOrderId', [String(salesOrderId)])
    .filter(function (c) { return c.result === 'Hold'; });
  return checks.sort(function (a, b) {
    return String(b.checkDate || '').localeCompare(String(a.checkDate || ''));
  })[0] || null;
}

/**
 * The people a lead or an enquiry can be handed to, by role.
 *
 * PIE run several sales engineers and several coordinators, so assignment is a choice from a
 * list rather than whoever happened to type the record in. Deactivated users are left out —
 * work assigned to somebody who has left is work nobody is doing.
 */
function listPeople() {
  getCurrentUser();
  var byRole = { salesEngineers: [], coordinators: [], management: [] };
  readTable_('Users').forEach(function (u) {
    if (String(u.active).toUpperCase() === 'FALSE') return;
    var person = {
      email: String(u.email || '').trim(),
      name: String(u.name || '').trim() || String(u.email || '').trim(),
      role: String(u.role || '').trim()
    };
    if (!person.email) return;
    if (person.role === ROLES.SALES_ENGINEER) byRole.salesEngineers.push(person);
    if (person.role === ROLES.SALES_COORDINATOR) byRole.coordinators.push(person);
    if (person.role === ROLES.MANAGEMENT) byRole.management.push(person);
  });
  var byName = function (a, b) { return a.name.localeCompare(b.name); };
  byRole.salesEngineers.sort(byName);
  byRole.coordinators.sort(byName);
  byRole.management.sort(byName);
  byRole.categories = CUSTOMER_CATEGORIES.slice();
  return byRole;
}
