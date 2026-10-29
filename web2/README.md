# ERP 2.0

ERP 2.0 is a third face of the same portal, built screen by screen over ERP 1:

| face | files |
|---|---|
| **2.0** (`v2`) | `web/Stylesheet.html` + **`web2/Theme.html`**, `src/JavaScript.html`, `web/Shell.html` + **`web2/Shell.html`** |
| new design (`web`, the default) | `web/Stylesheet.html`, `src/JavaScript.html`, `web/Shell.html` |
| classic | `src/` only — what Apps Script serves |

Same markup, same behaviour, same server. Every screen, rule, permission, bulk import and
printed or e-mailed quotation is ERP 1's own; 2.0 changes how it looks and, screen by screen
from here, how it is laid out. Nothing in `web2/` can reach Apps Script (`clasp` pushes `src/`).

## Switching it on

- **One browser:** add `?look=2` to any address. That browser keeps 2.0 until `?look=web`
  (back to the new design) or `?look=default` (whatever the server serves everyone). Nobody
  else's screen changes. The menu has a "Back to the current look" link at its foot.
- **Everyone:** `ERP_UI=v2`. Unset it to go back. No deployment of code either way.

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
  - Visits due within 7, 15, 30 or 60 days, and every overdue one. "Make service job" turns a
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
- **SDR totals** on 2.0, above ERP 1's count by status: customers in the list, called, quotations
  raised (with their value), converted (with the PO value).

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
  desk, Management's team and view of anybody's, and ERP 1's Dashboard unchanged elsewhere.
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
- `tests/service-due-sql-test.js`, `tests/offer-kind-sql-test.js` — the remark, the type, and
  the AMC renewal and service headings on the printed offer.
- `tests/run.sh` runs every screen suite against the 2.0 face as well as the other two.
- `tests/server-test.js` — `ERP_UI=v2`, `?look=`, and the cookie.
