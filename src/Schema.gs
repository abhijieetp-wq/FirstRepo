/**
 * SINGLE SOURCE OF TRUTH for the Sheet schema.
 *
 * Every tab and every column the ERP uses is declared here, aligned to
 * ELGI_PMT_ERP_Detailed_Blueprint.xlsx (the authoritative spec). `Setup.gs` reads this
 * declaration to create/upgrade the spreadsheet, so the Sheet is never hand-edited into
 * shape and headers can never drift from what the code expects.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 *  - every table has a surrogate `id`; nothing is addressed by row number outside SheetService
 *  - foreign keys are ids (`customerId`), never names
 *  - money/qty are numbers, dates are yyyy-MM-dd strings, flags are TRUE/FALSE
 *  - ledgers (StockMovements, AuditLog, Receipts) are append-only; current state is derived
 *  - `brand` defaults to ELGI (D5: Cumi/Champion follow) and `businessStream` to the
 *    transaction's stream (D2: Compressor / Spare share one backbone)
 *
 * Adding a column: append it here and re-run setupSheet(). Existing data is preserved —
 * Setup only ever adds missing tabs and appends missing columns.
 */

var AUDIT_TAB = 'AuditLog';

var SCHEMA = {

  // ---------------------------------------------------------------- Foundation / admin
  Users: {
    label: 'People who can sign in, and what they may do (FR-062)',
    columns: ['id', 'email', 'name', 'role', 'businessStream', 'active', 'createdAt', 'createdBy']
  },
  BusinessStreams: {
    label: 'Compressor vs Spare — the discriminator on every transaction (D2)',
    columns: ['id', 'name', 'active'],
    seed: [
      { id: 'BS-COMP', name: 'Compressor Sales', active: 'TRUE' },
      { id: 'BS-SPARE', name: 'Spare Sales', active: 'TRUE' }
    ]
  },
  Brands: {
    label: 'ELGI first; Cumi/Champion follow the same pattern (D5)',
    columns: ['id', 'name', 'accentColor', 'active'],
    seed: [
      { id: 'BR-ELGI', name: 'ELGI', accentColor: '#E8871E', active: 'TRUE' },
      { id: 'BR-CUMI', name: 'Cumi', accentColor: '#2E8B8B', active: 'FALSE' },
      { id: 'BR-CHAMP', name: 'Champion', accentColor: '#8B3A62', active: 'FALSE' }
    ]
  },
  ConfigLists: {
    label: 'Admin-maintainable dropdowns — no developer change needed (FR-074)',
    columns: ['id', 'category', 'code', 'label', 'sortOrder', 'active'],
    seed: [
      { id: 'CL-001', category: 'LeadSource', code: 'ELGI', label: 'ELGI Lead', sortOrder: 1, active: 'TRUE' },
      { id: 'CL-002', category: 'LeadSource', code: 'REFERENCE', label: 'Reference', sortOrder: 2, active: 'TRUE' },
      { id: 'CL-003', category: 'LeadSource', code: 'FIELD_VISIT', label: 'Field Visit', sortOrder: 3, active: 'TRUE' },
      { id: 'CL-004', category: 'LeadSource', code: 'EXISTING', label: 'Existing Customer', sortOrder: 4, active: 'TRUE' },
      { id: 'CL-005', category: 'LeadSource', code: 'WHATSAPP', label: 'WhatsApp', sortOrder: 5, active: 'TRUE' },
      { id: 'CL-006', category: 'LeadSource', code: 'PHONE', label: 'Phone', sortOrder: 6, active: 'TRUE' },
      { id: 'CL-007', category: 'LeadSource', code: 'EMAIL', label: 'Email', sortOrder: 7, active: 'TRUE' },
      { id: 'CL-008', category: 'LeadSource', code: 'WEBSITE', label: 'Website', sortOrder: 8, active: 'TRUE' },
      { id: 'CL-009', category: 'LeadSource', code: 'OTHER', label: 'Other', sortOrder: 9, active: 'TRUE' },
      { id: 'CL-020', category: 'PaymentTerms', code: 'ADV100', label: '100% Advance', sortOrder: 1, active: 'TRUE' },
      { id: 'CL-021', category: 'PaymentTerms', code: 'ADV_PART', label: 'Part Advance, Balance Before Dispatch', sortOrder: 2, active: 'TRUE' },
      { id: 'CL-022', category: 'PaymentTerms', code: 'NET30', label: '30 Days Credit', sortOrder: 3, active: 'TRUE' },
      { id: 'CL-023', category: 'PaymentTerms', code: 'NET45', label: '45 Days Credit', sortOrder: 4, active: 'TRUE' },
      { id: 'CL-030', category: 'Urgency', code: 'NORMAL', label: 'Normal', sortOrder: 1, active: 'TRUE' },
      { id: 'CL-031', category: 'Urgency', code: 'URGENT', label: 'Urgent', sortOrder: 2, active: 'TRUE' },
      { id: 'CL-032', category: 'Urgency', code: 'BREAKDOWN', label: 'Breakdown', sortOrder: 3, active: 'TRUE' },
      { id: 'CL-050', category: 'CompressorType', code: 'SCREW', label: 'Rotary Screw', sortOrder: 1, active: 'TRUE' },
      { id: 'CL-051', category: 'CompressorType', code: 'PISTON', label: 'Reciprocating (Piston)', sortOrder: 2, active: 'TRUE' },
      { id: 'CL-040', category: 'Industry', code: 'ENGINEERING', label: 'Engineering', sortOrder: 1, active: 'TRUE' },
      { id: 'CL-041', category: 'Industry', code: 'PHARMA', label: 'Pharma', sortOrder: 2, active: 'TRUE' },
      { id: 'CL-042', category: 'Industry', code: 'TEXTILE', label: 'Textile', sortOrder: 3, active: 'TRUE' },
      { id: 'CL-043', category: 'Industry', code: 'AUTOMOTIVE', label: 'Automotive', sortOrder: 4, active: 'TRUE' },
      { id: 'CL-044', category: 'Industry', code: 'OTHER', label: 'Other', sortOrder: 5, active: 'TRUE' }
    ]
  },
  LostReasons: {
    label: 'Managed dropdown replacing free-text lost reasons (FR-013)',
    columns: ['id', 'reasonText', 'appliesTo', 'active'],
    seed: [
      { id: 'LR-001', reasonText: 'Price too high', appliesTo: 'All', active: 'TRUE' },
      { id: 'LR-002', reasonText: 'Competitor selected', appliesTo: 'All', active: 'TRUE' },
      { id: 'LR-003', reasonText: 'Delivery time too long', appliesTo: 'All', active: 'TRUE' },
      { id: 'LR-004', reasonText: 'Requirement dropped/postponed', appliesTo: 'All', active: 'TRUE' },
      { id: 'LR-005', reasonText: 'No response from customer', appliesTo: 'All', active: 'TRUE' },
      { id: 'LR-006', reasonText: 'Part not available in time', appliesTo: 'Spare', active: 'TRUE' }
    ]
  },
  AuditLog: {
    label: 'Every critical field change: who, when, old value, new value (FR-061)',
    columns: ['id', 'timestamp', 'userEmail', 'action', 'tableName', 'recordId', 'fieldName', 'oldValue', 'newValue', 'reason']
  },

  // ---------------------------------------------------------------- Customer master
  Customers: {
    label: 'One customer code used across both streams (FR-001, FR-003)',
    columns: ['id', 'customerCode', 'name', 'legalName', 'gstin', 'pan', 'industry', 'segment',
      'assignedSalesperson', 'territory', 'paymentTerms', 'creditLimit', 'creditDays',
      'advanceRule', 'riskStatus', 'brand', 'lastOrderDate', 'notes', 'active', 'createdAt', 'createdBy']
  },
  CustomerContacts: {
    label: 'Purchase / maintenance / accounts / owner contacts (FR-002)',
    columns: ['id', 'customerId', 'name', 'contactRole', 'designation', 'phone', 'email', 'isPrimary', 'active']
  },
  CustomerAddresses: {
    label: 'Multiple billing and shipping addresses (FR-002)',
    columns: ['id', 'customerId', 'addressType', 'label', 'line1', 'line2', 'city', 'state',
      'pincode', 'gstin', 'isDefault', 'active']
  },

  // ---------------------------------------------------------------- Product / spare masters
  Products: {
    label: 'Compressor product hierarchy (FR-014) — replaces the old Units tab',
    columns: ['id', 'productCode', 'hsnCode', 'brand', 'family', 'series', 'model', 'description',
      'category', 'hpRating', 'fad', 'workingPressure', 'gstPct', 'warrantyMonths',
      'standardAccessories', 'leadTimeDays', 'uom', 'notes', 'active', 'createdAt', 'createdBy']
  },
  Spares: {
    label: 'ELGI spare master (FR-015) — replaces the old Parts tab',
    columns: ['id', 'partNo', 'hsnCode', 'description', 'category', 'brand', 'uom', 'gstPct',
      'purchasePrice', 'reorderLevel', 'safetyStock', 'defaultWarehouseId', 'defaultBinId',
      'notes', 'active', 'createdAt', 'createdBy']
  },
  SpareCompatibility: {
    label: 'Many-to-many spare ↔ compressor model mapping (FR-023)',
    columns: ['id', 'spareId', 'productModel', 'productId', 'isServiceKit', 'notes', 'active']
  },
  SpareAlternates: {
    label: 'Substitute/equivalent parts — distinct from model compatibility. Feeds the ' +
      'List/Special/Alternate rate-comparison chips carried over from the reference UI.',
    columns: ['id', 'spareId', 'alternateSpareId', 'altPartNo', 'altDescription', 'altSource',
      'notes', 'active']
  },
  PriceList: {
    label: 'Effective-dated prices; old quotes keep old prices (FR-016, FR-017). Two levels: ' +
      'PIE is the buying/cost price, ELGI is the selling price. Quotations use ELGI, shown ' +
      'simply as "Price". `purchasePrice` on Spares is superseded by the PIE level and unused.',
    columns: ['id', 'itemType', 'itemId', 'itemCode', 'priceLevel', 'price', 'minPrice',
      'maxDiscountPct', 'currency', 'effectiveFrom', 'effectiveTo', 'approvedBy', 'active',
      'createdAt', 'createdBy']
  },
  Warehouses: {
    label: 'Warehouse and bin locations for picking (FR-039)',
    columns: ['id', 'code', 'name', 'type', 'parentId', 'address', 'active'],
    seed: [
      { id: 'WH-MAIN', code: 'MAIN', name: 'Main Store', type: 'Warehouse', parentId: '', address: '', active: 'TRUE' }
    ]
  },

  // ---------------------------------------------------------------- Compressor front office
  Leads: {
    label: 'Compressor lead capture with source and ownership (FR-005, FR-006)',
    columns: ['id', 'leadNo', 'date', 'customerId', 'customerName', 'contactName', 'contactPhone',
      'contactEmail', 'prospectCity',
      'source', 'requirementSummary', 'industry', 'application', 'urgency', 'budget',
      'ownerEmail', 'status', 'nextActionDate', 'lostReasonId', 'businessStream', 'brand',
      'createdAt', 'createdBy']
  },
  LeadRequirements: {
    label: 'What the prospect wants, per compressor type — a lead may want both',
    columns: ['id', 'leadId', 'lineNo', 'compressorType', 'quantity', 'capacityHint', 'notes']
  },
  Activities: {
    label: 'Follow-ups against any record; drives overdue alerts (FR-007, N01, N02)',
    columns: ['id', 'relatedType', 'relatedId', 'activityType', 'activityDate', 'ownerEmail',
      'contactPerson', 'notes', 'outcome', 'nextActionDate', 'status', 'createdAt', 'createdBy']
  },
  SiteVisits: {
    label: 'Site visit report linked to the opportunity (FR-008, D002)',
    columns: ['id', 'visitNo', 'leadId', 'opportunityId', 'customerId', 'visitDate', 'participants',
      'objective', 'existingEquipment', 'observations', 'nextSteps', 'attachmentUrl',
      'createdAt', 'createdBy']
  },
  TechnicalRequirements: {
    label: 'Technical requirement sheet gating the quote (FR-009, D003)',
    columns: ['id', 'opportunityId', 'leadId', 'customerId', 'application', 'requiredFad',
      'workingPressure', 'dutyCycle', 'operatingHours', 'airQuality', 'powerSupply',
      'futureExpansion', 'existingCompressor', 'notes', 'createdAt', 'createdBy']
  },
  CompressorSelections: {
    label: 'Recommended solution that flows into the quotation (FR-010, D004)',
    columns: ['id', 'technicalRequirementId', 'opportunityId', 'productId', 'productCode', 'hpRating',
      'workingPressure', 'fad', 'dryer', 'receiver', 'filters', 'accessories', 'notes',
      'createdAt', 'createdBy']
  },
  Opportunities: {
    label: 'Compressor funnel: 7 stages, weighted pipeline (FR-011, FR-012, FR-013)',
    columns: ['id', 'opportunityNo', 'date', 'customerId', 'leadId', 'title', 'stage',
      'expectedValue', 'probability', 'expectedCloseDate', 'competitor', 'lostReasonId',
      'lostNotes', 'ownerEmail', 'nextActionDate', 'businessStream', 'brand',
      'createdAt', 'createdBy']
  },

  // ---------------------------------------------------------------- Spare front office
  SpareEnquiries: {
    label: 'Spare enquiry by machine/serial with urgency (FR-022)',
    columns: ['id', 'enquiryNo', 'date', 'customerId', 'customerName', 'contactName', 'productModel',
      'serialNo', 'installedBaseId', 'requirementText', 'urgency', 'source', 'ownerEmail',
      'status', 'nextActionDate', 'lostReasonId', 'businessStream', 'brand',
      'createdAt', 'createdBy']
  },
  SpareEnquiryItems: {
    label: 'Identified parts against an enquiry (FR-023, D011)',
    columns: ['id', 'spareEnquiryId', 'lineNo', 'spareId', 'partNo', 'description', 'qty',
      'identifiedBy', 'compatibilityConfirmed', 'availabilityNote', 'notes']
  },

  // ---------------------------------------------------------------- Quotation (shared)
  Quotations: {
    label: 'Shared across both streams; revision-controlled (FR-018, FR-019, FR-020)',
    columns: ['id', 'quoteNo', 'revision', 'parentQuotationId', 'date', 'businessStream', 'brand',
      'customerId', 'contactId', 'billingAddressId', 'shippingAddressId', 'opportunityId',
      'spareEnquiryId', 'machineModel', 'serialNo', 'preparedBy', 'validityDays', 'validUntil',
      'status', 'subtotal', 'discountAmt', 'taxAmt', 'freight', 'grand', 'paymentTerms',
      'deliveryTerms', 'warrantyTerms', 'notes', 'approvedBy', 'approvalDate', 'submittedDate',
      'emailSentDate', 'lostReasonId', 'locked', 'createdAt', 'createdBy']
  },
  QuotationItems: {
    label: 'Quote lines from either catalog (Product or Spare)',
    columns: ['id', 'quotationId', 'lineNo', 'itemType', 'itemId', 'itemCode', 'description',
      'qty', 'uom', 'listPrice', 'rateType', 'unitPrice', 'discountPct', 'taxPct', 'lineTotal',
      'availabilityNote', 'leadTimeDays']
  },

  // ---------------------------------------------------------------- Order & commercial control
  SalesOrders: {
    label: '8-state order lifecycle (FR-031); PO validated against quote (FR-030)',
    columns: ['id', 'orderNo', 'date', 'businessStream', 'brand', 'customerId', 'quotationId',
      'poNo', 'poDate', 'poValue', 'poAttachmentUrl', 'poVerified', 'poVarianceNotes',
      'billingAddressId', 'shippingAddressId', 'orderStatus', 'paymentTerms', 'advanceRequired',
      'advanceReceived', 'promisedDispatchDate', 'subtotal', 'discountAmt', 'taxAmt', 'freight',
      'grand', 'creditHold', 'creditHoldReason', 'ownerEmail', 'closedDate', 'notes',
      'createdAt', 'createdBy']
  },
  SalesOrderItems: {
    label: 'Order lines carrying reserved/dispatched/invoiced quantities',
    columns: ['id', 'salesOrderId', 'lineNo', 'itemType', 'itemId', 'itemCode', 'description',
      'qty', 'uom', 'unitPrice', 'discountPct', 'taxPct', 'lineTotal', 'qtyReserved',
      'qtyDispatched', 'qtyInvoiced']
  },
  Approvals: {
    label: 'Approval register for A01–A11; immutable audit record (M20, D035)',
    columns: ['id', 'approvalType', 'relatedType', 'relatedId', 'requestedBy', 'requestDate',
      'requestReason', 'contextSummary', 'level1Approver', 'level1Status', 'level1Date',
      'level1Notes', 'level2Approver', 'level2Status', 'level2Date', 'level2Notes',
      'status', 'closedDate']
  },
  CreditChecks: {
    label: 'Exposure calculation and hold/release trail (FR-033, FR-034, FR-035)',
    columns: ['id', 'salesOrderId', 'customerId', 'checkDate', 'creditLimit', 'outstandingAmt',
      'openOrderExposure', 'currentOrderValue', 'totalExposure', 'availableCredit',
      'advanceRequired', 'advanceReceived', 'result', 'holdReason', 'releasedBy',
      'releaseDate', 'releaseNotes']
  },

  // ---------------------------------------------------------------- Inventory & inward
  StockMovements: {
    label: 'Append-only stock ledger; on-hand is derived, never overwritten (FR-036)',
    columns: ['id', 'timestamp', 'movementDate', 'itemType', 'itemId', 'itemCode', 'movementType',
      'qty', 'warehouseId', 'binId', 'serialNo', 'referenceType', 'referenceId', 'enteredBy',
      'notes']
  },
  StockReservations: {
    label: 'Stock reserved against a sales order so it cannot be promised twice (FR-037)',
    columns: ['id', 'salesOrderId', 'salesOrderItemId', 'itemType', 'itemId', 'itemCode',
      'qtyReserved', 'warehouseId', 'status', 'reservedBy', 'reservedDate', 'releasedDate',
      'releaseReason']
  },
  SerialNumbers: {
    label: 'Compressor serial lifecycle: inward → dispatch → install → warranty (FR-038)',
    columns: ['id', 'productId', 'productCode', 'serialNo', 'status', 'warehouseId', 'grnId',
      'salesOrderId', 'dispatchId', 'invoiceNo', 'installedBaseId', 'notes', 'createdAt']
  },
  GRNs: {
    label: 'Goods receipt with checker/verifier before stock updates (FR-043, D015/D016)',
    columns: ['id', 'grnNo', 'grnDate', 'poRef', 'supplierName', 'invoiceRef', 'receivedBy',
      'checkedBy', 'verifiedBy', 'verificationStatus', 'verificationDate', 'notes',
      'createdAt', 'createdBy']
  },
  GRNItems: {
    label: 'Received lines with accepted/rejected quantity and condition',
    columns: ['id', 'grnId', 'lineNo', 'itemType', 'itemId', 'itemCode', 'description',
      'qtyReceived', 'qtyAccepted', 'qtyRejected', 'condition', 'serialNos', 'warehouseId',
      'binId', 'notes']
  },

  // ---------------------------------------------------------------- Dispatch & billing
  Dispatches: {
    label: 'Readiness checklist, documents and transporter details (FR-045, FR-046)',
    columns: ['id', 'dispatchNo', 'salesOrderId', 'dispatchDate', 'checklistComplete',
      'checklistNotes', 'transporterName', 'lrNumber', 'lrDate', 'ewayBillNo', 'packingListRef',
      'certificatesRef', 'deliveryChallanNo', 'dispatchedBy', 'podRef', 'podDate',
      'deliveryConfirmed', 'deliveryConfirmedDate', 'serviceNotified', 'status',
      'createdAt', 'createdBy']
  },
  DispatchItems: {
    label: 'Actually dispatched quantities — the basis for the invoice (FR-048)',
    columns: ['id', 'dispatchId', 'salesOrderItemId', 'lineNo', 'itemType', 'itemId', 'itemCode',
      'description', 'qtyDispatched', 'serialNos', 'binId', 'notes']
  },
  Invoices: {
    label: 'Invoice from order + actual dispatch, with Tally sync status (FR-048, FR-050)',
    columns: ['id', 'invoiceNo', 'invoiceDate', 'salesOrderId', 'dispatchId', 'customerId',
      'billingAddressId', 'businessStream', 'brand', 'subtotal', 'discountAmt', 'taxAmt',
      'freight', 'grand', 'amountReceived', 'paymentTerms', 'dueDate', 'warrantyTerms',
      'status', 'tallySyncStatus', 'tallySyncDate', 'tallySyncError', 'notes',
      'createdAt', 'createdBy']
  },
  InvoiceItems: {
    label: 'Invoice lines mirroring the dispatch',
    columns: ['id', 'invoiceId', 'lineNo', 'itemType', 'itemId', 'itemCode', 'description',
      'qty', 'uom', 'unitPrice', 'discountPct', 'taxPct', 'lineTotal']
  },

  // ---------------------------------------------------------------- Collections
  Receipts: {
    label: 'Payments, primarily imported from Tally (FR-055, I02)',
    columns: ['id', 'receiptNo', 'receiptDate', 'customerId', 'invoiceId', 'amount', 'mode',
      'reference', 'tallyRef', 'importedDate', 'notes', 'createdAt', 'createdBy']
  },
  CollectionFollowups: {
    label: 'Follow-ups, commitments and next actions on receivables (FR-052)',
    columns: ['id', 'invoiceId', 'customerId', 'contactDate', 'contactPerson', 'discussion',
      'commitmentAmount', 'commitmentDate', 'commitmentMet', 'nextFollowupDate', 'ownerEmail',
      'status', 'createdAt', 'createdBy']
  },

  // ---------------------------------------------------------------- Phase 2 placeholder
  InstalledBase: {
    label: 'Machine registry created after dispatch/commissioning (FR-056, Phase 2)',
    columns: ['id', 'customerId', 'productId', 'productModel', 'serialNo', 'siteAddress',
      'dispatchDate', 'installDate', 'warrantyStart', 'warrantyEnd', 'responsibleEngineer',
      'invoiceNo', 'status', 'notes', 'createdAt', 'createdBy']
  }
};

/**
 * The two business streams (D2), spelled exactly as they are stored.
 *
 * These strings are written into every transaction and compared against on the way out, so
 * they have to be one value, not two spellings of the same idea. Filtering for 'Spare' against
 * rows stored as 'Spare Sales' matches nothing and reports zero — which reads as "no business"
 * rather than "wrong filter", and is the worst kind of wrong.
 */
var STREAM_COMPRESSOR = 'Compressor Sales';
var STREAM_SPARE = 'Spare Sales';
var BUSINESS_STREAMS = [STREAM_COMPRESSOR, STREAM_SPARE];

/** Tabs whose rows carry a businessStream value. */
var STREAMED_TABS = ['Leads', 'Opportunities', 'SpareEnquiries', 'Quotations', 'SalesOrders', 'Invoices'];

/** Order lifecycle for SalesOrders.orderStatus (FR-031). */
var ORDER_STATUSES = ['Draft', 'Approval Pending', 'Credit Hold', 'Material Pending',
  'Ready for Dispatch', 'Dispatched', 'Invoiced', 'Closed'];

/** Quotation statuses (FR-020). */
var QUOTATION_STATUSES = ['Draft', 'Approved', 'Submitted', 'Revised', 'Won', 'Lost', 'Expired'];

/** Compressor funnel stages (FR-011). */
var OPPORTUNITY_STAGES = ['Requirement Identified', 'Technical Discussion', 'Quotation',
  'Negotiation', 'PO Expected', 'Won', 'Lost'];
