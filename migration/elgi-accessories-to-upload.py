"""ELGi accessories specification sheet (filters, dryers, receivers: one row per item) -> the
portal's spares upload, filling the specification table a compressor offer prints for each.

usage: python3 -I migration/elgi-accessories-to-upload.py <in.xlsx> <out.csv>

Then: Catalogue -> Spares -> Import price list -> the .csv. The preview says how many are new and
how many update an existing TPL code; nothing is written until it is confirmed.

Write the output outside git (the scratchpad, or imports/, which git ignores): the sheet is
ELGi's. Needs openpyxl.

Each row becomes one accessory, as the Add Accessory form makes it (Spares.gs, saveAccessory):
  partNo      the TPL number (spaces around it dropped), the accessory's code
  category    the type, in ordinary capitals: FINE FILTER -> Fine Filter
  specTitle   type + model, the heading the offer prints: "Pre Filter AF 0021P-3/8" BSP"
  description the same
  specModel / specCapacity / specMaxPressure / specWorkingPressure / specWeight / specDimensions
              from the sheet, with their unit when the sheet gives a bare number: 21 -> "21 cfm",
              20 -> "20 bar", 1.05 -> "1.05 kg"
Columns are found by their heading, not their position; a column the sheet does not have is left
blank, and a blank never overwrites what the catalogue already holds. Prices, HSN and GST are left
blank, to come from the accessories price list.
"""
import csv, re, sys, openpyxl

COLUMNS = ['partNo', 'hsnCode', 'description', 'productGroup', 'category', 'uom', 'gstPct',
           'piePrice', 'elgiPrice', 'reorderLevel', 'safetyStock', 'defaultBinId', 'notes',
           'specTitle', 'specModel', 'specCapacity', 'specMaxPressure', 'specWorkingPressure',
           'specDimensions', 'specWeight']

# The sheet's headings, matched loosely (case and spacing ignored), and the unit a bare number gets.
FIELDS = {
    'tpl': (['tpl no.', 'tpl no', 'tpl number', 'tpl code', 'tpl'], ''),
    'type': (['type of filter', 'type', 'type of accessory', 'accessory type'], ''),
    'model': (['model'], ''),
    'capacity': (['capacity in (cfm)', 'capacity (cfm)', 'capacity'], 'cfm'),
    'max': (['maximum pressure', 'maximum pressure (bar)', 'max pressure'], 'bar'),
    'work': (['normal working pressure', 'normal working pressure (bar)', 'working pressure'], 'bar'),
    'weight': (['weight of the package', 'weight of the package (kg)', 'weight (kg)', 'weight'], 'kg'),
    'dims': (['dimensions', 'dimensions (mm)'], 'mm'),
}


def norm(v):
    return re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''


def key(h):
    return norm(h).lower()


def with_unit(v, unit):
    """21 -> '21 cfm', 1.05 -> '1.05 kg'; text the sheet already wrote is kept as it is."""
    if v is None or norm(v) in ('', '-'):
        return ''
    if isinstance(v, (int, float)) and unit:
        f = float(v)
        return (str(int(f)) if f == int(f) else ('%g' % f)) + ' ' + unit
    return norm(v)


def type_name(t):
    """FINE FILTER -> Fine Filter; 'Pre Filter' stays."""
    t = norm(t)
    return t.title() if t.isupper() else t


def model_text(m):
    """Two apostrophes written for an inch mark become one: 3/8'' BSP -> 3/8" BSP."""
    return norm(m).replace("''", '"')


def main(src, dst):
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    head_i, cols = None, {}
    for i, r in enumerate(rows[:20]):
        heads = [key(v) for v in r]
        found = {}
        for f, (names, _) in FIELDS.items():
            for n in names:
                if n in heads:
                    found[f] = heads.index(n)
                    break
        if 'tpl' in found and 'model' in found:
            head_i, cols = i, found
            break
    if head_i is None:
        raise SystemExit('No heading row with a TPL number and a Model column found.')

    out, seen, problems = [], {}, []
    for r in rows[head_i + 1:]:
        get = lambda f: r[cols[f]] if f in cols and cols[f] < len(r) else None
        tpl = norm(get('tpl')).replace(' ', '').upper()
        model = model_text(get('model'))
        if not tpl and not model:
            continue
        if not tpl or not model:
            problems.append('a row with %s but no %s: %s' % ('a model' if model else 'a TPL number',
                                                              'TPL number' if model else 'model', tpl or model))
            continue
        if tpl in seen:
            problems.append('TPL %s twice (%s and %s)' % (tpl, seen[tpl], model))
            continue
        seen[tpl] = model
        typ = type_name(get('type'))
        title = (typ + ' ' if typ else '') + model
        row = {c: '' for c in COLUMNS}
        row.update({
            'partNo': tpl, 'description': title, 'productGroup': 'Accessories', 'category': typ,
            'uom': 'Nos', 'specTitle': title, 'specModel': model,
            'specCapacity': with_unit(get('capacity'), FIELDS['capacity'][1]),
            'specMaxPressure': with_unit(get('max'), FIELDS['max'][1]),
            'specWorkingPressure': with_unit(get('work'), FIELDS['work'][1]),
            'specDimensions': with_unit(get('dims'), FIELDS['dims'][1]),
            'specWeight': with_unit(get('weight'), FIELDS['weight'][1]),
        })
        out.append(row)

    with open(dst, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(out)
    types = {}
    for o in out:
        types[o['category']] = types.get(o['category'], 0) + 1
    print('%d accessories -> %s' % (len(out), dst))
    print('by type: ' + ', '.join('%s %d' % (t or '(none)', n) for t, n in types.items()))
    for p in problems:
        print('skipped: ' + p)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
