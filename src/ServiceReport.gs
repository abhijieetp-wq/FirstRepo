/**
 * The service report: what the engineer did, on paper.
 *
 * PIE's installation ends with a report that stands as proof the work is complete. It has to
 * carry the things somebody would ask about months later — which machine, which parts, who
 * went, what they found, what they did — and it has to leave room for the two signatures that
 * make it a record rather than a claim.
 *
 * The photographs are named on it rather than embedded. They live in Drive at full size, and a
 * page of thumbnails is not what makes a report evidence; the link is, and a photograph
 * squeezed into a PDF is usually unreadable anyway.
 *
 * It reuses the quotation's letterhead, because a customer who has seen one PIE document
 * should recognise the next.
 */

var SERVICE_REPORT_FOLDER = 'ERP Service Reports';

function buildServiceReportHtml(serviceJobId) {
  getCurrentUser();

  var job = findRowById_('ServiceJobs', serviceJobId);
  if (!job) throw new Error('Service job not found.');

  var co = getCompanyProfile();
  var customer = job.customerId ? findRowById_('Customers', job.customerId) : null;
  var address = job.siteAddressId ? findRowById_('CustomerAddresses', job.siteAddressId) : null;
  var items = findRowsByColumn_('ServiceJobItems', 'serviceJobId', [String(serviceJobId)])
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  var proofs = listServiceProofs(serviceJobId);
  var engineer = job.engineerEmail ? findRowsByColumn_('Users', 'email', [job.engineerEmail])[0]
    : null;

  var breakdown = String(job.jobType || 'Installation') === 'Breakdown';
  var out = [];
  var push = function (h) { out.push(h); };

  push('<!DOCTYPE html><html><head><meta charset="utf-8" />');
  push(quotationCss_(co));
  push(serviceReportCss_());
  push('</head><body>');
  push('<table class="page">');

  push('<thead><tr><td>' +
    '<table class="lh"><tr>' +
      '<td class="lh-l">' +
        (co.logoUrl ? '<img src="' + esc_(co.logoUrl) + '" class="logo" />' : '') + '</td>' +
      '<td class="lh-r">' +
        (co.partnerLogoUrl ? '<img src="' + esc_(co.partnerLogoUrl) + '" class="partner-logo" />' : '') +
      '</td>' +
    '</tr></table></td></tr></thead>');

  push('<tfoot><tr><td><div class="ft">' +
    (co.partnerLine ? '<div class="ft-partner">' + esc_(co.partnerLine).toUpperCase() + '</div>' : '') +
    (co.logoUrl && String(co.logoShowsName).toUpperCase() === 'TRUE'
      ? '' : '<div class="ft-name">' + esc_(co.legalName).toUpperCase() + '</div>') +
    '<div class="ft-line">Address: ' +
      esc_([co.addressLine1, co.addressLine2, co.city].filter(Boolean).join(' ')) +
      (co.pincode ? '-' + esc_(co.pincode) : '') + '</div>' +
    '<div class="ft-line">' +
      (co.email ? 'Email: ' + esc_(co.email) : '') +
      (co.phone ? ', Mobile: ' + esc_(co.phone) : '') + '</div>' +
    (co.gstin ? '<div class="ft-line">GST No: ' + esc_(co.gstin) + '</div>' : '') +
    '</div></td></tr></tfoot>');

  push('<tbody><tr><td>');

  push('<div class="doc-title">SERVICE REPORT</div>');
  push('<div class="doc-sub">' +
    esc_(breakdown ? 'Breakdown attendance' : 'Installation and commissioning of spares') +
    '</div>');

  push('<table class="srtab">');
  push(srRow_('Report No.', job.jobNo));
  push(srRow_('Date raised', job.date));
  push(srRow_('Completed on', job.completedDate || ''));
  push(srRow_('Customer', (customer && customer.name) || job.customerName));
  if (address) {
    push(srRow_('Site', [address.line1, address.line2, address.city, address.pincode]
      .filter(Boolean).join(', ')));
  }
  push(srRow_('Machine', job.machineModel));
  push(srRow_('Serial No.', job.serialNo));
  push(srRow_('Attended by', engineer ? (engineer.name + ' (' + engineer.email + ')')
    : job.engineerEmail));
  if (breakdown) {
    push(srRow_('Reported by', job.reportedBy));
    push(srRow_('Urgency', job.urgency));
  }
  push('</table>');

  push('<div class="sr-head">' + esc_(breakdown ? 'Fault reported' : 'Scope') + '</div>');
  push('<div class="sr-body">' + esc_(job.scopeText || '') + '</div>');

  if (items.length) {
    push('<div class="sr-head">Parts fitted</div>');
    push('<table class="srparts"><tr><th>#</th><th>Part No.</th><th>Description</th>' +
      '<th class="num">Qty</th></tr>');
    items.forEach(function (i) {
      push('<tr><td>' + esc_(i.lineNo) + '</td><td>' + esc_(i.itemCode) + '</td><td>' +
        esc_(i.description) + '</td><td class="num">' + esc_(i.qty) + '</td></tr>');
    });
    push('</table>');
  }

  push('<div class="sr-head">Work carried out</div>');
  push('<div class="sr-body">' + (String(job.notes || '').trim()
    ? esc_(job.notes) : '&nbsp;<br/>&nbsp;<br/>&nbsp;') + '</div>');

  if (proofs.length) {
    push('<div class="sr-head">Photographs on file</div>');
    push('<ol class="sr-photos">');
    proofs.forEach(function (p) {
      push('<li>' + esc_(p.fileName) + (p.caption ? ' — ' + esc_(p.caption) : '') + '</li>');
    });
    push('</ol>');
  }

  // Two signatures: the engineer says what was done, the customer says they accept it. A
  // report with only one of them is a claim.
  push('<table class="srsign"><tr>' +
    '<td><div class="sr-rule"></div><div class="sr-cap">Service Engineer</div>' +
      '<div class="sr-cap">' + esc_(engineer ? engineer.name : job.engineerEmail) + '</div></td>' +
    '<td><div class="sr-rule"></div><div class="sr-cap">Customer’s Seal &amp; Signature</div>' +
      '<div class="sr-cap">' + esc_((customer && customer.name) || job.customerName) + '</div></td>' +
    '</tr></table>');

  push('</td></tr></tbody></table></body></html>');
  return out.join('\n');
}

function srRow_(label, value) {
  return '<tr><td class="srk">' + esc_(label) + '</td><td class="srv">' +
    (String(value || '').trim() ? esc_(value) : '&nbsp;') + '</td></tr>';
}

function serviceReportCss_() {
  return '<style>' +
    '.srtab{width:100%;border-collapse:collapse;margin-bottom:14px;}' +
    '.srtab td{border:1px solid #999;padding:4px 7px;font-size:10pt;}' +
    '.srk{width:30%;background:#f2f2f2;font-weight:bold;}' +
    '.sr-head{font-weight:bold;font-size:10.5pt;margin:12px 0 4px;text-transform:uppercase;}' +
    '.sr-body{border:1px solid #999;padding:7px;min-height:46px;font-size:10pt;' +
      'white-space:pre-wrap;margin-bottom:6px;}' +
    '.srparts{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:10pt;}' +
    '.srparts th,.srparts td{border:1px solid #999;padding:4px 7px;}' +
    '.srparts th{background:#f2f2f2;text-align:left;}' +
    '.sr-photos{margin:0 0 8px 18px;font-size:9.5pt;}' +
    '.srsign{width:100%;border-collapse:collapse;margin-top:34px;}' +
    '.srsign td{width:50%;padding:0 18px;vertical-align:bottom;}' +
    '.sr-rule{border-bottom:1px solid #222;height:38px;}' +
    '.sr-cap{font-size:9pt;color:#333;padding-top:3px;}' +
    '</style>';
}

/** Saves the report to Drive and hands back the link. */
function createServiceReportPdf(serviceJobId) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);

  var job = findRowById_('ServiceJobs', serviceJobId);
  if (!job) throw new Error('Service job not found.');

  var html = buildServiceReportHtml(serviceJobId);
  var name = String(job.jobNo).replace(/[\/\\:*?"<>|]/g, '-') + ' Service Report.pdf';
  var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);

  var folders = DriveApp.getFoldersByName(SERVICE_REPORT_FOLDER);
  var folder = folders.hasNext() ? folders.next()
    : DriveApp.createFolder(SERVICE_REPORT_FOLDER);
  var file = folder.createFile(pdf);

  audit_('Print', 'ServiceJobs', serviceJobId, 'report', '', name, 'Service report generated');
  return { name: name, url: file.getUrl(), downloadUrl: file.getDownloadUrl() };
}
