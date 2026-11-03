"""ELGi 'Specification Database' workbook (sheet Variant_DB, one row per variant) -> the portal's
compressor upload.

usage: python3 -I migration/elgi-variant-db-to-upload.py <in.xlsx> <out.csv>

Then: Catalogue -> Compressors -> Import price list -> the .csv. The preview says how many are new
and how many update an existing code; nothing is written until it is confirmed.

Write the output outside git (the scratchpad, or imports/, which git ignores): ELGi marks these
spec sheets confidential. Needs openpyxl.

This is the later layout of ELGi's specs: field names on row 5 of Variant_DB, a Variant ID per
row, separate columns for length, width and height, and the VFD part-load figures on their own
sheet (VFD_PartLoad). The older one-sheet layout is elgi-specs-to-upload.py. Both make the same
codes, so a variant loaded from either updates the same product: EG 11-7.5 DM -> EG11-7.5,
EQ 11 7.5 V -> EQ11-7.5V, EG 55PM 8 V -> EG55PM-8V, EG 75SP 8 V on an IE4 motor ->
EG75SP-8V-IE4, and a VFD with an integrated dryer carries DV: EG 30PM 7.5 DV -> EG30PM-7.5DV.

Columns are found by their heading, not their position. Prices, HSN and GST are left blank:
a blank never overwrites what the catalogue already holds, and a quotation takes 18% GST when
a compressor has none.
"""
import csv, io, re, sys, openpyxl

COLUMNS = ['productCode', 'hsnCode', 'model', 'family', 'series', 'description', 'category',
           'hpRating', 'fad', 'workingPressure', 'capacityCfm', 'maxPressure', 'motorKw',
           'starterType', 'dimensionsMm', 'weightKg', 'spcKw100Cfm', 'gstPct', 'piePrice',
           'elgiPrice', 'warrantyMonths', 'leadTimeDays', 'uom', 'notes']

# The workbook's own field names (row 5 of Variant_DB).
F = {
    'id': 'Variant ID', 'model': 'Model', 'sheetName': 'Variant (as per spec sheet)',
    'tpl': 'TPL Number', 'kw': 'Main Motor (kW)', 'hp': 'Main Motor (hp)',
    'bar': 'Pressure Variant (bar)', 'cfm': 'FAD (cfm)', 'm3': 'FAD (m³/min)',
    'wp': 'Working Pressure (bar.g)', 'unload': 'Unload (Cut-out) Pressure (bar.g)',
    'pin': 'Package Input Power @ Full Load (kW)', 'pzero': 'Package Input Power @ Zero Flow (kW)',
    'spc': 'SPC @ Full Load (kW/100cfm)', 'control': 'Capacity Control',
    'mtype': 'Motor Type (Main & Fan)', 'eff': 'Main Motor Efficiency', 'effcls': 'Efficiency Class',
    'starter': 'Starter Type', 'amps': 'Max Package Current (A)', 'cool': 'Cooling Air Flow (cfm)',
    'oil': 'Oil Recommended', 'oilfill': 'Total Oil Fill (l)', 'noise': 'Noise Level (dB(A))',
    'port': 'Air Outlet Port', 'len': 'Unit Length (mm)', 'wid': 'Unit Width (mm)',
    'ht': 'Unit Height (mm)', 'weight': 'Net Weight (dry) (kg)', 'doc': 'Spec Sheet Doc No.',
    'rev': 'Revision', 'date0': 'Date (Original)', 'date1': 'Date (Revised)',
}


def norm(v):
    return re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''


def blank(v):
    return norm(v).lower() in ('', '-', 'not stated')


def n(x):
    """22.0 -> '22', 3.74 -> '3.74'."""
    f = float(x)
    return str(int(f)) if f == int(f) else ('%g' % f)


def header_row(rows, must):
    for i, r in enumerate(rows[:30]):
        vals = [norm(v) for v in r]
        if all(m in vals for m in must):
            return i, vals
    raise SystemExit('No header row with %s found.' % ', '.join(must))


def code_for(model, bar):
    """'EG75SPV-IE4' and 8 -> 'EG75SP-8V-IE4'; 'EQ11V' and 7.5 -> 'EQ11-7.5V'."""
    m = re.match(r'^([A-Z]+)(\d+)(PM|SP)?(DV|V)?(?:-(IE\d))?$', model)
    if not m:
        raise SystemExit('Cannot make a code from model "%s"' % model)
    fam, size, kind, drive, ie = m.groups()
    return '%s%s%s-%s%s%s' % (fam, size, kind or '', n(bar), drive or '', '-' + ie if ie else ''), fam, ie


def shown_name(sheet_name, ie):
    """ELGi's own name for the variant, with the sheets' two slips put right."""
    s = norm(sheet_name)
    s = re.sub(r'^\d+(?=[A-Z])', '', s)      # "6EG 37-8.5 V"
    s = re.sub(r'\s+-\s*', '-', s)            # "EG 11 -8.5 DM"
    return s + (' (%s motor)' % ie if ie else '')


def main():
    src, out_path = sys.argv[1], sys.argv[2]
    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    if 'Variant_DB' not in wb.sheetnames:
        raise SystemExit('No Variant_DB sheet: for the older one-sheet layout use elgi-specs-to-upload.py.')
    rows = list(wb['Variant_DB'].iter_rows(values_only=True))
    hr, H = header_row(rows, [F['id'], F['model'], F['cfm']])
    missing = [v for v in F.values() if v not in H]
    if missing:
        raise SystemExit('Column(s) not found: ' + ', '.join(missing))
    at = {k: H.index(v) for k, v in F.items()}

    part = {}
    if 'VFD_PartLoad' in wb.sheetnames:
        prow = list(wb['VFD_PartLoad'].iter_rows(values_only=True))
        ph, P = header_row(prow, ['Variant ID', 'Input Power', 'Capacity', 'Turn Down Ratio'])
        vi, kw, cap, tdr = P.index('Variant ID'), P.index('Input Power'), P.index('Capacity'), P.index('Turn Down Ratio')
        for r in prow[ph + 1:]:
            if blank(r[vi]):
                continue
            part.setdefault(norm(r[vi]), []).append('%s%% %s cfm %s kW' % (n(r[tdr]), n(r[cap]), n(r[kw])))

    out, seen = [], {}
    for r in rows[hr + 1:]:
        if blank(r[at['id']]):
            continue
        g = lambda k: r[at[k]]
        model = norm(g('model'))
        code, fam, ie = code_for(model, g('bar'))
        if code in seen:
            raise SystemExit('Two rows make code %s: %s and %s' % (code, seen[code], norm(g('id'))))
        seen[code] = norm(g('id'))
        shown = shown_name(g('sheetName'), ie)
        kw, hp, bar = n(g('kw')), n(g('hp')), n(g('bar'))

        vfd = 'variable' in norm(g('control')).lower()
        drive = 'variable speed (VFD)' if vfd else 'load/unload'
        if re.search(r'\d(PM|SP)?DV', model):
            drive += ' with integrated dryer'
        if 'PM' in model or 'permanent magnet' in norm(g('mtype')).lower():
            drive += ', permanent magnet motor'
        elif not ie and not blank(g('effcls')):
            drive += ', %s motor' % norm(g('effcls'))
        date = norm(g('date0')) if blank(g('date1')) else norm(g('date1'))

        eff = ''
        if not blank(g('eff')):
            e = float(g('eff'))                 # 0.914 in this workbook; 91.4 would mean the same
            eff = '%s%%' % n(round(e * 100, 1) if e <= 1 else e)
        notes = ['ELGi TPL %s. Spec sheet %s rev %s (%s).' % (norm(g('tpl')), norm(g('doc')), norm(g('rev')), date),
                 'Control: %s.' % norm(g('control')) + (
                     '' if norm(g('starter')).lower() == norm(g('control')).lower()
                     else ' Starter: %s.' % norm(g('starter'))),
                 'Input power %s kW at full load%s.' % (
                     n(g('pin')),
                     '' if blank(g('pzero')) or float(g('pzero')) == 0 else ', %s kW unloaded' % n(g('pzero'))),
                 'SPC %s kW/100cfm.' % n(g('spc'))]
        if eff:
            notes.append('Motor efficiency %s%s.' % (eff, '' if blank(g('effcls')) else ' ' + norm(g('effcls'))))
        notes.append('Max current %s A.' % n(g('amps')))
        if not blank(g('cool')):
            notes.append('Cooling air %s cfm.' % n(g('cool')))
        notes.append('Noise %s dB(A). Outlet %s.' % (n(g('noise')), norm(g('port'))))
        notes.append('Oil: %s, %s l fill.' % (norm(g('oil')), n(g('oilfill'))))
        pl = part.get(norm(g('id')))
        if pl:
            notes.append('Part load (VFD): ' + '; '.join(pl) + '.')

        out.append({
            'productCode': code,
            'hsnCode': '',
            'model': shown,
            'family': 'Lubricated screw',
            'series': fam,
            'description': 'ELGi %s lubricated screw air compressor, %s kW (%s hp), %s bar, 400V/50Hz, %s' %
                           (shown, kw, hp, bar, drive),
            'category': 'Screw',
            'hpRating': hp,
            'fad': '%s cfm' % n(g('cfm')),
            'workingPressure': '%s bar.g' % n(g('wp')),
            'capacityCfm': '%s cfm (%s m³/min)' % (n(g('cfm')), n(g('m3'))),
            'maxPressure': '%s bar.g' % n(g('unload')),
            'motorKw': '%s kW, %s hp' % (kw, hp),
            'starterType': norm(g('starter')),
            'dimensionsMm': '%s x %s x %s mm (L x W x H)' % (n(g('len')), n(g('wid')), n(g('ht'))),
            'weightKg': '%s kg (dry)' % n(g('weight')),
            'spcKw100Cfm': n(g('spc')),
            'gstPct': '', 'piePrice': '', 'elgiPrice': '', 'warrantyMonths': '', 'leadTimeDays': '',
            'uom': 'Nos',
            'notes': ' '.join(notes),
        })

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL)
    w.writeheader()
    w.writerows(out)
    with open(out_path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(buf.getvalue())
    print(len(out), 'variants written to', out_path, '| with part-load table:',
          sum(1 for o in out if 'Part load' in o['notes']))


if __name__ == '__main__':
    main()
