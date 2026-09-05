/**
 * Machine/unit master catalog (compressors etc.) — separate from the Parts (spares) catalog
 * per the v2 brief. Same access rule as Parts: read-only for everyone, write is Manager-only.
 * No stock tracking here — units are lead-time/made-to-order, not stocked inventory.
 */

function listUnits() {
  getCurrentUser();
  return readTable_('Units').map(stripRow_);
}

function saveUnit(unit) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGER, ROLES.ADMIN]);

  var modelCode = String(unit.modelCode || '').trim();
  var modelName = String(unit.modelName || '').trim();
  var listRate = Number(unit.listRate);
  if (!modelCode || !modelName || isNaN(listRate)) {
    throw new Error('Model Code, Model Name and List Rate are required.');
  }

  var record = {
    modelCode: modelCode,
    modelName: modelName,
    category: String(unit.category || '').trim(),
    hpRating: String(unit.hpRating || '').trim(),
    workingPressure: String(unit.workingPressure || '').trim(),
    fad: String(unit.fad || '').trim(),
    listRate: listRate,
    specialRate: unit.specialRate !== '' && unit.specialRate !== null && unit.specialRate !== undefined ? Number(unit.specialRate) : '',
    leadTimeDays: unit.leadTimeDays !== '' && unit.leadTimeDays !== null && unit.leadTimeDays !== undefined ? Number(unit.leadTimeDays) : '',
    warrantyPeriod: String(unit.warrantyPeriod || '').trim(),
    notes: String(unit.notes || '').trim()
  };

  if (unit.id) {
    updateRowById_('Units', 'id', unit.id, record);
    record.id = unit.id;
  } else {
    record.id = generateId_('UN-');
    appendRow_('Units', record);
  }
  return record;
}

function deleteUnit(id) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGER, ROLES.ADMIN]);
  deleteRowById_('Units', 'id', id);
  return true;
}
