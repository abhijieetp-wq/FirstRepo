/**
 * Spares master catalog. Read access is open to every role; write access (add/edit/delete,
 * and later bulk upload) is Manager-only, confirmed with no exception — Coordinators and
 * Warehouse cannot edit rates or stock counts.
 */

function listParts() {
  getCurrentUser();
  return readTable_('Parts').map(stripRow_);
}

function savePart(part) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var partNo = String(part.partNo || '').trim();
  var description = String(part.description || '').trim();
  var listRate = Number(part.listRate);
  if (!partNo || !description || isNaN(listRate)) {
    throw new Error('Part No., Description and List Rate are required.');
  }

  var record = {
    partNo: partNo,
    description: description,
    category: String(part.category || '').trim(),
    unit: String(part.unit || 'Nos').trim() || 'Nos',
    listRate: listRate,
    specialRate: part.specialRate !== '' && part.specialRate !== null && part.specialRate !== undefined ? Number(part.specialRate) : '',
    altPartNo: String(part.altPartNo || '').trim(),
    altDescription: String(part.altDescription || '').trim(),
    altRate: part.altRate !== '' && part.altRate !== null && part.altRate !== undefined ? Number(part.altRate) : '',
    systemStock: part.systemStock !== '' && part.systemStock !== null && part.systemStock !== undefined ? Number(part.systemStock) : 0
  };

  if (part.id) {
    updateRowById_('Parts', 'id', part.id, record);
    record.id = part.id;
  } else {
    record.id = generateId_('PT-');
    appendRow_('Parts', record);
  }
  return record;
}

function deletePart(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  deleteRowById_('Parts', 'id', id);
  return true;
}
