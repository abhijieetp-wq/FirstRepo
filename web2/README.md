# ERP 2.0

ERP 2.0 is the portal's only look, built screen by screen over ERP 1:

| layer | files |
|---|---|
| ERP 1's markup and behaviour | `src/Index.html`, `src/JavaScript.html`, the server |
| the design 2.0 is drawn over | `web/Stylesheet.html`, `web/Shell.html` |
| **2.0** | **`web2/Theme.html`**, **`web2/Shell.html`** |

The two looks before it — the new design on its own, and the classic look Apps Script served —
were retired once 2.0 had everything they had (`server/page.js` serves 2.0 whatever it is asked
for). Their layers stay because 2.0 is built on them; `src/Stylesheet.html` stays with the frozen
Apps Script project.

Same markup, same behaviour, same server. Every screen, rule, permission, bulk import and
printed or e-mailed quotation is ERP 1's own; 2.0 changes how it looks and, screen by screen
from here, how it is laid out. Nothing in `web2/` can reach Apps Script (`clasp` pushes `src/`).

## Switching it on

It is always on. `ERP_UI` and `?look=` no longer choose anything, and the cookie a browser kept
from the "Back to the current look" link is cleared on its next visit. Going back to an older
look now means redeploying an older commit.

## What is in each file

**`Theme.html`** — ERP 2's look as tokens over the new design's: the green rail, the lime
accent, greenish neutrals, Archivo and IBM Plex Sans (self-hosted, `assets/fonts/`), flatter
corners. A handful of rules re-colour the places `web/Stylesheet.html` wrote a colour out in
full. The nineteen custom-property names `JavaScript.html` reads keep their names.

**`Shell.html`** — runs after `web/Shell.html`, through the DOM only, like it. Today: names the
Service Due Calls screen **SDR** (menu, heading, breadcrumb, browser tab, command palette),
marks the app's name "2.0", and adds the way back.

**`src/JavaScript.html`, behind `FACE_V2`** — the few ways of working only 2.0 has, where
going through the DOM alone would not do. The server marks the page `<html data-face="v2">`
(`server/page.js`); Apps Script and the other faces carry no such mark and keep ERP 1's screen.
Today:

- **SDR rows worked in place.** Each open call's row has *What they said* (picking an answer
  logs the call, dated today unless it was already logged), a *Remark* (kept on its own, before
  or after the call) and *Quote…* with what the quotation is for: **Spares, AMC renewal or
  Service**. The call window asks the same. A closed call, or a user who may only look, sees
  text.
- **The enquiry form asks what the quotation will be for**, the same three.
- **The enquiry board** (`src/EnquiryBoard.gs`). Spare Sales and Compressor Sales open on ERP 2's
  ten stages — Enquiry received, Requirement understood, Quotation prepared, Quotation sent,
  In negotiation, Approved by customer, PO received, Sales order (WON), Material procurement,
  Dispatched — plus Rejected / Lost with its reason. A Board / List switch (Spare Sales) or a
  Board tab (Compressor Sales) brings ERP 1's lists back; each browser remembers its choice.
  - Every stage is read off ERP 1's own records: the enquiry or lead, its newest live
    quotation, the order that quotation became (credit hold → PO received; credit check passed →
    Sales order; material short or reserved → Material procurement), and the dispatch.
  - Three stages are set by hand, from the card, and each writes a field ERP 1 already has:
    Enquiry received ⇄ Requirement understood is the enquiry's status (New / Identifying) or the
    lead's (New / Qualified); In negotiation is the quotation's status Negotiating, which ERP 1
    shows as Sent, and needs a note on what is being discussed (kept against the quotation).
  - Cards: spare enquiries, leads, opportunities without a lead, and quotations raised with no
    enquiry behind them. Dispatched and closed cards stay for 90 days.
  - Management and ERP Admin can rename the stages (both desks; stored in ConfigLists as
    `BoardStage`). Stages cannot be added.
- **A dashboard per person** (`src/PersonDashboard.gs`). 2.0 opens everybody on the
  Dashboard, which starts with their own desk; ERP 1's control tower — the nine checks and the
  charts — is unchanged under it.
  - Sales Coordinator: open enquiries (their cards on the board), follow-ups due, offers
    waiting for the customer's answer, drafts to approve for customers they look after, their
    orders this month, SDR calls to make.
  - Sales Engineer: leads they found, follow-ups due, offers out, won this month.
  - Service Coordinator: open jobs, jobs to assign, visits today and tomorrow, breakdowns.
  - Service Engineer: visits today and tomorrow, open jobs, enquiries and leads they raised
    — counts only, no money, as everywhere for service.
  - Management and ERP Admin: the team, one row a person; a name, or the "Dashboard of" list,
    opens that person's desk exactly as they see it.
  - Every figure and line opens the ERP 1 screen or record it is about.
- **The service desk's statuses** (`src/ServiceDesk.gs`): New → Assigned → In progress →
  Report submitted → Closed, or Cancelled with a reason. ERP 1's status column keeps ERP 1's
  values (Unassigned, Assigned, Scheduled, In Progress, Completed, Cancelled), so its screens
  read every job as before; the 2.0 name is worked out from it, plus whether the engineer's
  report is in. On 2.0 the job window steps through them: Start work, the engineer's report
  (visit date, hours spent, running hours, work done, root cause — required on a breakdown —
  customer's remarks, handed over running), Close the job (coordinator, once the report and
  the customer's photograph are in), Cancel (coordinator, with a reason). The printed service
  report carries the engineer's report when there is one; a job without one prints as before.
  New columns on ServiceJobs, all added, none changed: reportSubmittedAt, reportSubmittedBy,
  visitDate, hoursSpent, runningHours, workDone, rootCause, customerRemarks,
  handedOverRunning, closedBy, cancelReason, cancelledAt, cancelledBy.

The type is stored on the spare enquiry (`enquiryType`). On the printed offer an AMC renewal or
a service takes its own heading and subject — rows with *Applies to* `AMC` or `SERVICE` in
Settings → Quotation text, default wording PIE can change there — and everything else is the
spares offer's, as before. An enquiry with no type reads as Spares.

- **AMC** (`src/Amc.gs`), a screen of its own under Orders, at `/amc` — only in a 2.0 menu.
  - A contract is one machine: type (Comprehensive, Non-comprehensive, Labour only, or a
    Service reminder with no contract), period (a year unless given), service every N months
    from the first visit (unless given, the end of the first period — a year of quarterly
    service is four visits, the last on the final day), running hours, contact, area, value a
    year. Saving lays out the visits; changing the schedule lays out again only the visits
    nobody has made a job of. Edit and delete; a contract with a visit made into a job stays.
  - Visits due in the next 45 days, and every overdue one, as the demo lists them (no window to
    pick and no search box). "Make service job" turns a
    visit into a job (type AMC visit) in the Service Jobs queue; the visit reads its state from
    that job — Call made, Done when the job is closed, Due again if it is cancelled.
  - Renewals: contracts ending within 60 days. "Prepare renewal quotation" logs an AMC renewal
    enquiry on the spares desk and raises its quotation, so it prints with the AMC renewal
    heading and subject.
  - Service sees no contract values, as everywhere. Two new tables, AmcContracts and
    AmcVisits; nothing in ERP 1 reads them.
  - The service coordinator's dashboard counts the AMC visits due this week.
- **Next-day plan** (`src/ServicePlan.gs`), under Orders, at `/next-day-plan` — only in a 2.0
  menu. Tomorrow unless another day is picked.
  - Each service engineer's visits for the day, read from the service jobs assigned to them
  (engineer and scheduled date, ERP 1's own fields), in time order. The coordinator can give a
  visit a time (`scheduledTime`, a new column on ServiceJobs); a visit opens its job.
  - The message for the engineers' WhatsApp group: the day, then each engineer with their
  visits — time, customer, town, type, scope, job number, contact. One message for the group
  or one per engineer, copied with a button. The ERP sends nothing by itself.
  - What is not on the plan yet: jobs nobody is going on (stopped machines first), jobs with
  an engineer but no day, and AMC visits due by then with no job — each put on the day from
  there, through ERP 1's assignment.
  - An engineer sees only their own day, and none of the planning lists.
- **Tasks** (`src/Tasks.gs`), at `/tasks`, next to the Dashboard — only in a 2.0 menu.
  - Anybody gives a task to anybody: what, details, who, due date, priority. "+ Task" on an
    enquiry board card or a service job gives one about that record, and the task opens it.
  - ERP 2's scoring: High 15 points, Normal 10, Low 5; done by the due day earns all of them,
    done later earns 50%, not done after the due day loses 50% until it is done. A person's
    score is points earned ÷ points possible over the tasks due in the period (this month, last
    month, this quarter, this financial year, or a range), never below 0%. Management changes
    the numbers (ConfigLists, category TaskScore). Points show as they are — 7.5, not 8.
  - The person doing a task marks it in progress, done or open again. Only whoever gave it, or
    Management, changes what it says, who does it, when it is due or its priority, or cancels or
    deletes it — so nobody moves their own due date or cancels their own overdue task. A new task
    cannot be due before today, nor a due date moved into the past.
  - Management sees everybody's tasks and the whole scorecard; everybody else the tasks given
    to them or by them, and their own line. Each person's dashboard has a tasks tile.
  - One new table, Tasks. Nothing in ERP 1 reads it.
- **Escalations** (`src/Escalations.gs`), at `/escalations`, after Tasks — only in a 2.0 menu.
  - "Escalate…" on an enquiry board card sends the deal to a Sales Coordinator or to Management,
    by name, with a note saying what needs deciding. One waits on a card at a time; the card shows
    "Escalated" and keeps the earlier ones.
  - Management answers: send back, approve, won or lost, with an instruction. A coordinator it was
    sent to replies and sends it back. Whoever raised it can withdraw it while it waits.
  - Left out of ERP 2 on purpose: moving a deal to "In negotiation" escalates nothing by itself and
    does not stop the coordinator closing it; and an answer changes no quotation — the coordinator
    still marks it won or lost, with ERP 1's own steps.
  - Sales work only; service sees none of it. A tile on Management's and the sales side's
    dashboards counts what waits. One new table, Escalations.
- **New customer approval** (`src/CustomerApproval.gs`).
  - Every new customer, added by hand or by Customers' bulk upload, is saved, usable at once and
    marked "Pending approval" until one person approves or rejects it. Rejected means deactivated.
  - Who approves is Settings → Users → New customer approvals, with the address their e-mail goes
    to (a Users address need not be a mailbox). Nobody chosen, or the one chosen has left:
    Management decide. The approver's own additions are approved as they are made.
  - The approver gets one e-mail per customer added by hand and ONE per bulk upload listing every
    customer it added, through Settings → Email. Its button opens `/customers?approve=<batch>`:
    those customers, each with a tick box, and Approve ticked / Reject ticked. Mail clients
    remove tick boxes from e-mails, so the ticking is in the ERP. A mailbox that fails never fails
    the save; the save says so and the audit trail keeps it.
  - A rejected customer is shown to whoever added it, on their own dashboard ("Customers not
    approved": who rejected it, when, why) until they dismiss it. Not by e-mail: PIE's staff have
    no mailboxes. One more Customers column, rejectionSeenAt.
  - The approver's e-mail goes only to an inbox given for it; their ERP ID is not one.
  - The same list heads the approver's dashboard and Customers. Other Management and ERP Admin
    see it on their dashboard as a notice. Five new Customers columns: approvalStatus,
    approvalBatch, approvedBy, approvedAt, approvalNote. Blank means from before, and approved.
- **The ERP ID** (Settings → Users; `Users.email`). Staff have no mailboxes of their own, so the
  address field is the ERP ID: how every record knows whose work it is, never a login and never
  sent to. A person added with none gets one made from their username at `pie.invalid` (a domain
  reserved never to receive mail), and a blank username comes from their first name. Each person
  needs their own; the shared office Gmail belongs in Letterhead and Settings → Email, not on a user.
  Users shows ERP Admin "Give them ERP IDs…" while anybody is still on an e-mail address: the list
  of who goes from what to what, then each moved with all their work as "Change ERP ID" does
  (`applyErpIdCleanup`, UserEmail.gs). The approver of new customers keeps their inbox.
- **Visit plans** (`src/VisitPlans.gs`), under Sales, at `/visit-plans` — only in a 2.0 menu.
  - Sales engineers plan customer visits by week (Monday to Sunday) or month: engineer, date,
    company (a customer in the master or a prospect by name), area, purpose. "+ Add" on a day,
    and "Copy last week's plan", which never copies a visit twice.
  - ERP 2's full visit form: status (Planned, Visited, Not visited, Rescheduled — not visited
    before the day), person met, phone, industry, discussion, compressor and brand in use,
    capacity, age, alternative considered, interest, requirement, timeline, potential, next
    action and date. ERP 2's lists, or ConfigLists VisitPurpose, CompressorType, CompressorBrand,
    PurchaseTimeline; industries from ERP 1's own Industry list.
  - Areas are Local or Outstation: ERP 2's list until Management sets PIE's own ("Areas…";
    ConfigLists VisitArea). An area not on the list reads as Outstation, as in ERP 2.
  - "Save & create enquiry" makes a compressor lead through ERP 1's own lead save — its checks
    and numbering, source Field Visit, run by a compressor coordinator, with the next action date
    ERP 1 needs — and the visit keeps it.
  - Figures, and the visit report per engineer: completion, enquiries, hot, potential, and what
    customers run and when they will buy. A tile on the dashboards for this week's visits.
  - A sales engineer sees and plans their own; coordinators and Management everybody's. Service
    sees none of it. ERP 1's site visit report under an opportunity is unchanged. One new table,
    SalesVisits.
- **Service calls** (`src/ServiceDesk.gs`, ERP 1's `createServiceJob`):
  - The log-a-call form on 2.0 takes ERP 2's call types — Breakdown, Regular service, Spare
    change, Commissioning, Installation (AMC visits come from AMC) — an area and an instruction
    to the engineer. ERP 1's form sends no type and still logs a breakdown.
  - Each call's area is Local or Outstation, from the same list as visit plans; Service Jobs
    filters by it. The coordinator sets the area and instruction later from the job window.
  - Reschedule moves an assigned visit to another day with one of ERP 2's reasons (and a note),
    kept as history on the job (table ServiceJobReschedules); the time of day is cleared. On 2.0
    the job window's date, once given, moves only this way.
  - The next-day plan's message carries the instruction.
- **Service engineers** report (`src/ServiceEngineerReport.gs`), under Reports, at
  `/reports/service-engineers` — only in a 2.0 menu. ERP 2's columns for a period: assigned (by
  the visit day, or the call's day when none; ERP 1 keeps no assigned-at time), attended (report
  in), closed, rescheduled and on how many calls, pending now, local / outstation / no area,
  hours on site by kind of area, average days from the call to the report, AMC visits done,
  spare enquiries and compressor leads passed on (with their value for those who see money).
  Download as CSV. A service engineer sees their own line.
- **Downloads**: the visit report and the task scorecard download as CSV too.
- **Board additions** (`src/EnquiryBoard.gs`): the totals add "won this month" (orders booked this
  month that cleared to a sales order); a stage filter shows one column, an owner filter one
  person's cards. A card's window shows ERP 2's order tab: the order with its date, the lorry
  (transporter, vehicle, LR) and the first invoice.
- **A compressor lead's area**, Local or Outstation, on the 2.0 lead form, on its card and in its
  window, saved through ERP 1's own lead save; ERP 1's form sends none and keeps the lead's. A
  lead made from a visit carries the visit's area.
- **Dashboard additions** (`src/PersonDashboard.gs`): a period selector — this month, last month,
  this quarter, this financial year or a range — behind every "this month" figure, named in the
  tile ("My orders last month"); the tasks tile follows it. A coordinator sees the spare enquiries
  a service engineer raised that are still waiting for them, nothing quoted, with the days
  waiting; a sales engineer's desk opens with today's visits.
- **The SDR page as the 2.0 demo has it**, and no more: a line saying which list ("List of … ·
  N machines · uploaded by …"), the count-then-label tiles by status (which filter), one toolbar —
  search, coordinator (a coordinator starts on Mine, Management on Everyone), Select all, and Give to
  coordinator once some are ticked — and the table. It shows the latest list, open and closed, and
  any older call still open (`view: 'current'`); a small picker opens an older week or every list.
  The totals strip, the open/closed and status dropdowns and the overdue / follow-up-due boxes were
  taken out; the reason a call ended is on its status, on hover, and in the call.
- **The enquiry board as the 2.0 demo draws it** (Compressor Sales and Spare Sales): the board's
  own toolbar (Board / List, search, owner, stage, Show lost with its count, the three rules), ten
  coloured stage columns with their totals, and cards with the flag, the town, the machine or
  source, the quotation or order, the value in lakhs, the follow-up and the owner. A card opens a
  drawer from the right: the stage strip, Add follow-up / Prepare quotation / Escalate to owner /
  + Task / Mark lost, and three tabs — Overview (the hand-set stage's button, the facts, and three
  dropdowns: Next follow-up, Flag, Owner, each saved as it changes), Follow-ups (logged with how and
  when next) and Quotations and orders (`src/BoardDetails.gs`). Everything writes ERP 1's own
  records: a lead's next-action date and owner, a spare enquiry's owner and its own follow-up date,
  follow-ups in Activities, lost as the record's Lost / Disqualified status with a reason. The flag
  is a new column on spare enquiries, leads and opportunities.
  Board / List switches inside the 2.0 page: List shows the same cards as a table (number, date,
  customer, need, stage, flag, value, follow-up, owner, quotation or order) with the same toolbar
  and dropdowns, a row opening the same drawer; the choice is kept per browser. ERP 1's own Leads,
  Pipeline and enquiry lists come up on 2.0 only from ERP 1's own steps (Convert to opportunity).
- **All Quotations and Quotation Progress as the 2.0 demo draws them**: six totals (drafts,
  approved not sent yet, sent with no answer, won and lost this month, past validity; a click
  filters), Both desks / Compressor / Spares, search, status and who prepared it, and a table with
  the short number, desk, who, customer, main item, value before GST, status, the ten steps and
  valid until; a row opens the quotation. Progress shows how far the quotations got step by step
  (last 30 days or all), then each one's ten steps, where it is, what is next and how many days
  it has waited; a row opens ERP 1's trail. ERP 1 has no "waiting for approval" flag, so the second
  total counts approved quotations not sent yet.
  New Quotation is not in 2.0's menu: All Quotations' "+ New quotation" opens a window with the
  same fields (customer and + New, business stream, machine model, serial no., validity) and
  Create Quotation opens the new offer. The quotation screen itself stays for every offer opened,
  and its address still works; its own "+ New Quotation" opens the same window.
- **The Catalogue as the 2.0 demo draws it**: Compressors, Accessories (the spares with a
  specification table: dryers, filters, receivers) and Spares (every spare) as tabs, opening on
  Compressors; "Pick by need" (air in cfm and pressure in bar, up to 45% headroom) beside ERP 1's
  Find by flow & pressure; and the demo's columns — model, kW, air, bar, the ELGi price (sell), the
  PIE price (cost, Management and the ERP Admin only), HSN, GST, stock, and whether a compressor's
  specification is in. ERP 1's search, compare, delete, bulk upload ("Import price list"), paging
  and item window work as before.
  - Accessories have their own form ("+ Add accessory", `saveAccessory` in Spares.gs): TPL Code,
    Type, Model and Capacity (TPL code, model and capacity required), normal working pressure,
    package weight, maximum pressure and dimensions, as ELGi's CDOC sheet gives them. The TPL code
    is the accessory's code (one per item; the list's first column); the type goes in `category`;
    the offer names it "ELGi make" + type + model. Price, HSN and GST are left to the accessories
    price list, still to come, matched by TPL code.
- **Customers as the 2.0 demo draws it**: search by name, code, GSTIN, a contact's phone or city;
  segment (ERP 1's Industry), salesperson and Has overdue dues; and a table of code, customer (city,
  segment, "no GSTIN yet"), machines, salesperson, what is owed (red when overdue; only for whoever
  Collections allows) and the open enquiries and service calls. getCustomerSummaries
  (Customers.gs) counts them in one read: machines from the installed base, ELGi's service due
  list and service jobs, each serial once; another desk's enquiries not counted. A row opens ERP
  1's customer window; + Add customer and Bulk upload are ERP 1's.
- **Inventory & Inward as the 2.0 demo draws it**: five totals that open what they count (spares in
  stock, GRNs to verify, compressors in stock and how many are free, below the reorder level,
  reserved), "+ Inward (GRN)" at the top (and "+ Add serial" on Serials), and ERP 1's four lists as
  tabs: stock (spares or compressors, by store, below reorder only; free stock and low parts
  marked; value at ELGi's selling price), reservations with Release, goods received with their
  verification, and serials. ERP 1's GRN, serial and reservation windows and rules as before.
- **The quotation page laid out as the 2.0 demo has it**: the kind of offer (Compressor / Spares
  offer) over the number in figures, the customer, date and machine under it; the ten-step progress
  in its own panel with where it is and what is next; who prepared, approved and looks after it;
  Customer (customer, GSTIN, machine, kind attention, addresses) and Offer details (date, validity,
  payment, delivery, warranty, GST, notes; "Printed on the offer" or "Locked. Revise to change.")
  side by side; the items; and Totals (package discount, P&F, the sums, a Save that uses ERP 1's
  Save details) beside what the customer receives. ERP 1's own fields and buttons are moved into
  these panels with their ids, so everything works as before; the breadcrumb names the quotation.
- **Collections as the 2.0 demo draws it**: six totals (outstanding, overdue and its share, over 90
  days, received this month, promised for today, broken promises), Import receipts and Record
  receipt, and ERP 1's four lists as tabs: ageing by customer (ERP 1's buckets by days past due,
  the total, a bar of how it is spread, credit days and limit, the last follow-up, Follow up and
  Statement), open invoices (still owed, how late, any promise, Overdue only, Follow up and
  Receipt), follow-ups as a timeline (Open, Promised, Broken, Closed) and receipts (mode,
  reference, Tally voucher, Reverse). ERP 1's figures, forms and rules as before.
- **Dispatch & Billing as the 2.0 demo draws it**: five totals (ready to dispatch and its value,
  waiting for the delivery photo with the oldest, dispatched and not invoiced in red with its value,
  invoiced this month, the Tally queue and how many failed; each opens its tab), the orders ready to
  go with a Dispatch button that opens the new dispatch on that order, and ERP 1's four lists as
  tabs: dispatches (how it went, LR, proof of delivery, invoice, Add photo / Make invoice), invoices
  (amount, still owed or paid, due, status, Tally), dispatched and not invoiced, and the Tally queue.
  Rows open ERP 1's dispatch and invoice windows; + New Dispatch and + Raise Invoice are ERP 1's.
- **Sales Orders as the 2.0 demo draws them**: five totals that filter (open orders and their value,
  credit holds in red, material pending, ready for dispatch and its value, past the promised date in
  amber with the oldest), search, status and Only mine, and one table — the order and its desk, the
  customer and what was ordered, the PO and any variance, the value before GST, the status, how much
  is in stock (from ERP 1's reserved quantities on the lines) and the promised date. A row opens
  ERP 1's order window; "+ Create from an accepted quotation" is ERP 1's own.
- **AMC & Dues as the 2.0 demo draws it**: the four totals (active AMCs and their value a year,
  visits due this month, visits overdue in red, renewals in 60 days and their value), Visits due /
  Contracts / Renewals, the due window and search, chips for where each visit and contract stands,
  how far off or late each visit is, and Make call / Open call. Under the Service Desk's tabs.
- **The Service Desk as the 2.0 demo draws it**: four tabs — Calls, Engineer reports, AMC and dues,
  Next-day plan — with the same strip under the AMC and next-day screens' headings, so the three read
  as one page; Tomorrow's plan and + Service call; five totals (open calls, breakdowns open with those
  over 24 hours, installations to do, reports in and not closed, closed this month with the average
  days to close); the six call types, engineer, status and search, as the demo has them; and every
  call in one table (call, type, customer and area, machine and what is wrong, opened, engineer,
  visit, status); how often a visit moved, and why, is in the job window. A row opens it. Engineer reports is the
  calls whose report is in, waiting for the coordinator. A service engineer sees their own calls.
- **The menu as the 2.0 demo lays it out**: Dashboard; Sales (Compressor Sales, Spare Sales, SDR,
  Visit Plans); Quotations (All Quotations, Quotation Progress); Service (Service Desk, AMC & Dues —
  the next-day plan is a tab of the Service Desk, as in the demo, and its address still works); Orders & money (Sales Orders, Dispatch & Billing, Collections, Inventory);
  Management (Tasks, Escalations, Leads by Engineer, Service Engineers); Setup (Customers,
  Catalogue, Form Fields, Settings). Same screens and the same rules for who sees them.
- **Form fields** (`src/FormFields.gs`), Masters → Form fields, for Management: fields of PIE's
  own on a form — text, number, date, dropdown, long text, yes / no — each optionally required and
  a list column, in the order set, with a preview. The forms: spare enquiries, compressor leads,
  service jobs (and the log-a-call form), customers, AMC contracts, visits and tasks. They show
  under "More details" on the form; a required one left empty stops the save before anything is
  written; the values are saved after the record, in their own table (`FormFieldValues`), so
  nothing ERP 1 reads or prints changes. A list-column field is a column in the record's list (a
  line on an enquiry-board card). Who sees and fills them follows the record. Taking a field off
  keeps its values; adding one back under the same name brings them back. A choice since taken off
  a dropdown, or a value from before a field's type changed, stays on the records that had it.
- **Ask** (`src/AiCommands.gs`, `server/ai.js`), in the top bar: a request typed, or spoken through
  the browser's microphone, read by Claude (Anthropic's current Opus) into actions — give a task,
  plan a visit, log a compressor lead, log a spare enquiry, log a service call, open a screen. Each
  is shown with a tick box; nothing happens until Do, and then each goes through its own form's
  save, with that form's checks and the person's permissions — so the bar can do nothing the person
  could not do by hand. Names are matched to staff and customers on PIE's server; one that matches
  nobody, or more than one, is shown and cannot be ticked. Claude is sent the words, who is asking,
  today's date and the ERP's short lists — never the customer list or any record. Needs
  `ANTHROPIC_API_KEY` on the server (never stored in the database or the browser); without it the
  bar is off, and Management is told why. Speech uses the browser's own recognition (Chrome sends
  the audio to Google to turn it into text).
- **The Dashboard as the 2.0 demo draws it**: a green hero with the greeting, what the desk is for
  and the day's buttons (Management: + Compressor enquiry, + Spare enquiry, + Service call,
  Quotations; a coordinator: their desk's enquiry and the SDR list; a sales engineer: + Plan a visit;
  service: + Service call and Tomorrow's plan, or My calls), with "Dashboard of" and "Figures for"
  beside it. Management's desk: Money — the control tower's four figures, with its Combined /
  Compressor / Spares switch — then Work this month, eight tiles (enquiries received, quotations
  sent and declined, orders won and lost, escalated and open, service calls, AMC dues in the next
  7 days, sales visits this week, task score), then the demo's panels: Waiting for your decision,
  Needs attention (ERP 1's nine checks), Follow-ups due across the team, Overdue and due today
  (tasks, with + Task), AMC and service dues, Installations coming up and Receivables ageing; the
  team; and the rest of the control tower under "More figures". Everybody else gets their own desk
  in the same tiles and panels, now with a tasks panel, and ERP 1's control tower under it as
  before. Every tile and row opens where it is worked.
- **Compressor Sales' pipeline**, above the board in Board and List: what ERP 1's Pipeline and Leads
  tabs summed — open opportunities, pipeline value, weighted pipeline (value × the chance of winning
  each), needs follow-up, open leads by status, and the count and value at each of ERP 1's
  opportunity stages. It follows the board's owner filter.
- **Light and dark** (`web2/Theme.html`, `web2/Shell.html`): a sun / moon switch in the top bar.
  Dark redefines the same tokens (the demo's dark palette), so every screen follows; it is each
  person's own choice, kept on their browser and applied in the page's head so it never flashes.
  Light unless they choose dark. Printed and PDF documents are not affected.

## The rule for each screen that moves to 2.0

A screen takes ERP 2's layout only when it keeps everything ERP 1's version of it does — the
ERP 1 column of the gap audit is the checklist. The quotation that is printed or sent stays
`QuotationDocument.gs`'s, unchanged.

## Tests

- `tests/v2-ui-test.js` — what 2.0 adds, and that the bulk imports and every screen survive it.
- `tests/sdr-rows-ui-test.js` — the SDR rows on 2.0, and ERP 1's row unchanged on the others.
- `tests/enquiry-board-ui-test.js`, `tests/enquiry-board-sql-test.js` — the board on 2.0 (and
  the lists unchanged on the others), and every stage read correctly from the records.
- `tests/person-dashboard-ui-test.js`, `tests/person-dashboard-sql-test.js` — each position's
  desk, Management's team and view of anybody's, and ERP 1's Dashboard unchanged elsewhere; the
  demo's hero and buttons, Management's Money and Work tiles and its panels (the nine checks, the
  ageing, decisions, follow-ups across the team, tasks, AMC dues, installations), each opening
  where it is worked, and the control tower's switch in the Money row.
- `tests/compressor-pipeline-v2-ui-test.js` — the pipeline's figures, the owner filter, the List
  view, and ERP 1's own tabs on the other faces.
- `tests/theme-v2-ui-test.js` — the light/dark switch: light by default, the page following,
  kept on the browser and back before the page is drawn, and not on the other faces.
- `tests/service-desk-ui-test.js`, `tests/service-desk-sql-test.js` — the statuses read from
  ERP 1's, the report, closing, cancelling, and ERP 1's job window unchanged elsewhere.
- `tests/amc-ui-test.js`, `tests/amc-sql-test.js` — contracts, the visit schedule, visits made
  into jobs, renewals, no money for service, and no AMC on the other faces.
- `tests/next-day-plan-ui-test.js`, `tests/next-day-plan-sql-test.js` — each engineer's day in
  time order, the time, the message, the jobs put on the day, an engineer's own view, and no
  plan on the other faces.
- `tests/tasks-ui-test.js`, `tests/tasks-sql-test.js` — giving and changing tasks and who may,
  the scoring and its rules, the periods, the dashboard tile, tasks about a service job and an
  enquiry, and no tasks on the other faces.
- `tests/escalations-ui-test.js`, `tests/escalations-sql-test.js` — escalating a card, who answers
  and how, withdrawing, who sees what, the board and dashboard, nothing escalating by itself, no
  quotation changed, and no escalations on the other faces.
- `tests/customer-approval-ui-test.js`, `tests/customer-approval-sql-test.js` — who decides, the
  one e-mail per save and per upload, the batch link, approving and rejecting, the dashboard and
  Customers lists, a mailbox that fails, and an approver renamed or gone.
- `tests/users-erp-id-sql-test.js` — ERP IDs and usernames made for a person left blank, each
  person's own, checked when typed, kept on an edit; and everybody moved onto one at once.
- `tests/visit-plans-ui-test.js`, `tests/visit-plans-sql-test.js` — planning, who sees whose, the
  visit report, areas, copying last week, a visit made into a lead through ERP 1's lead save, the
  dashboard tile, and no visit plans on the other faces.
- `tests/service-calls-ui-test.js`, `tests/service-calls-sql-test.js` — call types, areas, the
  instruction, reschedules with reasons, and ERP 1's breakdown form unchanged on the other faces.
- `tests/service-engineer-report-ui-test.js`, `tests/service-engineer-report-sql-test.js` — each
  column for a period, who sees what and money, the CSV, and no report on the other faces.
- `tests/board-extras-ui-test.js`, `tests/board-extras-sql-test.js` — the totals and filters, the
  order tab, a lead's area, and ERP 1's lead form unchanged on the other faces.
- `tests/dashboard-extras-ui-test.js`, `tests/dashboard-extras-sql-test.js` — the period, the
  enquiries raised by service engineers, today's visits, and the SDR totals.
- `tests/ai-commands-ui-test.js`, `tests/ai-commands-sql-test.js`, `tests/ai-service-test.js`,
  `tests/ai-server-test.js` (end to end through the server) — the
  Ask bar and its window, speech, the proposal and its tick boxes, only the ticked actions done,
  each through its own save; what each role may ask; what is and is not sent to Claude; names
  matched here; the request to Claude, its fallback and its errors; off without the key.
- `tests/board-drawer-ui-test.js`, `tests/board-drawer-sql-test.js` — the cards, the drawer, its
  dropdowns written to ERP 1's records, follow-ups in Activities, marking lost, who may do which.
- `tests/catalog-v2-ui-test.js` — the three tabs and their columns, Pick by need, ERP 1's search
  and item window underneath; ERP 1's two buttons on the other faces.
- `tests/customers-v2-ui-test.js`, `tests/customer-summaries-sql-test.js` — the list, its search and
  filters, a row opening the record; and on the server the machines, dues and open items per
  customer, by desk and by who may see money.
- `tests/inventory-v2-ui-test.js` — the five totals and what each opens, the stock filters, the
  four tabs, and the buttons opening ERP 1's windows; ERP 1's lists on the other faces.
- `tests/quote-builder-v2-ui-test.js` — the heading, the panels in the demo's order with ERP 1's
  fields in them, saving through ERP 1's button, a locked and a compressor offer; ERP 1's page elsewhere.
- `tests/collections-v2-ui-test.js` — the six totals, the four tabs and their tables, Overdue only,
  and each button opening ERP 1's forms; ERP 1's lists on the other faces.
- `tests/dispatch-v2-ui-test.js` — the five totals, Ready to go, the four tabs and their tables, and
  each button and row opening ERP 1's forms; ERP 1's lists on the other faces.
- `tests/orders-v2-ui-test.js` — the five totals and their filters, status, Only mine, search, the
  table and a row opening the order, and ERP 1's list on the other faces.
- `tests/service-desk-v2-ui-test.js` — the Service Desk's four tabs on its three screens, the five
  totals, each filter, the table, Engineer reports, a row opening the job, and ERP 1's list on the other faces.
- `tests/quotations-v2-ui-test.js` — the six totals, the desk, search, status and who filters,
  the table and its steps, Progress's step totals, rows and trail, and ERP 1's lists on the other faces.
- `tests/form-fields-ui-test.js`, `tests/form-fields-sql-test.js` — building a form's fields,
  each type and its checks, required fields stopping the save, values after the record, list
  columns, who sees and fills them, removing and adding back, and none of it on the other faces.
- `tests/service-due-sql-test.js`, `tests/offer-kind-sql-test.js` — the remark, the type, and
  the AMC renewal and service headings on the printed offer.
- `tests/run.sh` runs every screen suite against the 2.0 face as well as the other two.
- `tests/server-test.js` — 2.0 served to everyone whatever `ERP_UI` or `?look=` say, and the old look cookies cleared.
