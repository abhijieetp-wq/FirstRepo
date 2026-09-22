/**
 * Who may decide what, and why.
 *
 * PIE's customers all buy the same way: when they need stock. There is no regular-versus-new
 * distinction to hang rules on, and an earlier attempt to build one was wrong.
 *
 * What the rules actually turn on is who is looking after the customer. Each customer has a
 * sales coordinator in charge, and that person makes the calls for them — approving the offer
 * before it goes out, releasing a credit hold. Management can always step in, but the point of
 * this is that they should not have to: an office where every decision waits for the owner is
 * an office that waits.
 *
 * So authority here is a question about a relationship, not a role list. `mayActForCustomer_`
 * is the whole idea in one function, and everything else is a wrapper that says which decision
 * is being made and puts it in words somebody can read on screen.
 */

/**
 * Whether this user may make a commercial decision about this customer.
 *
 * Management and the ERP admin always may. The coordinator in charge of the customer may.
 * A coordinator who is not in charge of anybody's customer in particular may too, when the
 * customer has nobody assigned — otherwise a customer nobody has been put in charge of would
 * be a customer nobody could act on, which is worse than the ambiguity.
 */
function mayActForCustomer_(user, customer) {
  if (!user) return false;
  if ([ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(user.role) !== -1) return true;
  if (user.role !== ROLES.SALES_COORDINATOR) return false;

  var incharge = customer ? String(customer.assignedSalesperson || '').trim() : '';
  if (!incharge) return true;
  return incharge.toLowerCase() === String(user.email || '').toLowerCase();
}

/** The person whose name is against this customer, for saying so in a message. */
function coordinatorInCharge_(customer) {
  return customer ? String(customer.assignedSalesperson || '').trim() : '';
}

/**
 * Puts a coordinator's name against a customer, from wherever the gap was noticed.
 *
 * The field has always existed on the customer record, three screens away from the quotation
 * whose banner complains that nobody is named. Anyone who may act for the customer may set
 * it: while nobody is named any coordinator can act, so any coordinator may claim it, and
 * once a name is there only that coordinator or Management may change it. Handing a customer
 * to somebody else is a decision, not a correction.
 */
function assignCustomerCoordinator(customerId, email) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Customers');

  var customer = findRowById_('Customers', customerId);
  if (!customer) throw new Error('Customer not found.');
  requireStream_(user, customer.businessStream, 'This customer');

  if (!mayActForCustomer_(user, customer)) {
    throw new Error(quoteApprovalRule_(customer).why +
      ' You are signed in as ' + user.email + '.');
  }

  var wanted = String(email || '').trim();
  if (wanted) {
    var person = readTable_('Users').filter(function (u) {
      return String(u.email).toLowerCase() === wanted.toLowerCase() &&
        String(u.active).toUpperCase() !== 'FALSE';
    })[0];
    if (!person) throw new Error('No active user with the address ' + wanted + '.');
    if (person.role !== ROLES.SALES_COORDINATOR) {
      throw new Error(person.name + ' is a ' + person.role + '. A customer is looked after ' +
        'by a Sales Coordinator.');
    }
    wanted = person.email;
  }

  updateRowById_('Customers', 'id', customerId, { assignedSalesperson: wanted },
    wanted ? 'Customer assigned to ' + wanted : 'Customer left unassigned');
  return { customerId: String(customerId), assignedSalesperson: wanted };
}

/**
 * Who may sign a quotation off before it is sent.
 *
 * Every offer is approved — that has not changed — but it is approved by the coordinator
 * looking after the customer rather than escalated to Management as a matter of course.
 */
function quoteApprovalRule_(customer) {
  var incharge = coordinatorInCharge_(customer);
  return {
    required: true,
    inCharge: incharge,
    why: incharge
      ? 'This customer is looked after by ' + incharge + '. They approve the offer before it ' +
        'is sent; Management can too, but does not have to.'
      : 'Nobody is named as looking after this customer yet, so any sales coordinator or ' +
        'Management can approve the offer before it is sent.'
  };
}

/**
 * Who may lift a credit hold on this order.
 *
 * A hold means unpaid invoices have gone past the customer's credit limit, and PIE's rule is
 * that the order waits until enough money comes in to bring them back under it. So lifting one
 * while the money is still outstanding is an override of the rule rather than a judgement
 * call, and that is Management's.
 *
 * The other case is a hold that has already been earned out of: the customer paid, the
 * outstanding is back inside the limit, and the hold is simply stale. Re-running the credit
 * check clears that on its own, and the coordinator looking after the customer can clear it
 * too.
 */
function creditReleaseRule_(customer, check) {
  var limit = customer && customer.creditLimit !== '' && customer.creditLimit !== null
    ? Number(customer.creditLimit) : null;
  var outstanding = Number(check && check.outstandingAmt) || 0;
  var incharge = coordinatorInCharge_(customer);

  if (limit === null || isNaN(limit) || limit <= 0) {
    return {
      managementOnly: true,
      inCharge: incharge,
      why: 'No credit limit has been agreed for this customer, so the decision is ' +
        'Management\u2019s.'
    };
  }
  if (outstanding > limit) {
    return {
      managementOnly: true,
      shortfall: roundMoney_(outstanding - limit),
      inCharge: incharge,
      why: 'Unpaid invoices of ' + inr_(outstanding) + ' are over the limit of ' + inr_(limit) +
        '. The order waits until ' + inr_(outstanding - limit) + ' comes in \u2014 releasing ' +
        'it before that overrides the rule, which is Management\u2019s call.'
    };
  }
  // The advance is a term of this order rather than a standing agreement, so a shortfall on it
  // is not something the coordinator can waive.
  if (Number(check && check.advanceRequired) > Number(check && check.advanceReceived)) {
    return {
      managementOnly: true,
      inCharge: incharge,
      why: 'The advance agreed for this order has not been received, so the decision is ' +
        'Management\u2019s.'
    };
  }
  return {
    managementOnly: false,
    inCharge: incharge,
    why: 'Unpaid invoices of ' + inr_(outstanding) + ' are back inside the limit of ' +
      inr_(limit) + ', so this hold is stale \u2014 ' +
      (incharge ? incharge + ', who looks after this customer, can clear it.'
                : 'the sales coordinator looking after this customer can clear it.')
  };
}

/** Whether this user may lift this particular hold. */
function mayReleaseCredit_(user, customer, rule) {
  if (!user) return false;
  if ([ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(user.role) !== -1) return true;
  if (rule && rule.managementOnly) return false;
  return mayActForCustomer_(user, customer);
}

/**
 * The people work can be handed to, by role.
 *
 * PIE run several of each, so assignment is a choice from a list rather than whoever happened
 * to type the record in. Deactivated users are left out — work assigned to somebody who has
 * left is work nobody is doing.
 */
function listPeople() {
  getCurrentUser();
  var byRole = {
    salesEngineers: [], coordinators: [], serviceCoordinators: [], serviceEngineers: [],
    management: []
  };
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
    if (person.role === ROLES.SERVICE_COORDINATOR) byRole.serviceCoordinators.push(person);
    if (person.role === ROLES.SERVICE_ENGINEER) byRole.serviceEngineers.push(person);
    if (person.role === ROLES.MANAGEMENT) byRole.management.push(person);
  });
  var byName = function (a, b) { return a.name.localeCompare(b.name); };
  ['salesEngineers', 'coordinators', 'serviceCoordinators', 'serviceEngineers', 'management']
    .forEach(function (k) { byRole[k].sort(byName); });
  byRole.serviceStatuses = SERVICE_JOB_STATUSES.slice();
  byRole.serviceUrgencies = SERVICE_URGENCIES.slice();
  return byRole;
}
