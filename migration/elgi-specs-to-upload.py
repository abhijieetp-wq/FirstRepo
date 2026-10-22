"""ELGi 'Specification Data' workbook (models down, specs across) -> the portal's compressor upload.

usage: python3 -I migration/elgi-specs-to-upload.py <in.xlsx> imports/<out.csv> [earlier-upload.csv ...]

Then: Catalog -> Products (Compressors) -> Bulk Upload -> the .csv. The preview says how many are new
and how many update an existing code; nothing is written until it is confirmed.

Write the output under imports/, which git ignores: ELGi marks these spec sheets confidential.
Needs openpyxl (pip install openpyxl).

Columns are found by their heading, not their position, so a later file with the columns in a
different order still converts. Codes follow the earlier upload: EG 11-7.5 DM -> EG11-7.5, and a
VFD model carries V: EQ 11 7.5 V -> EQ11-7.5V.
"""
import csv, io, re, sys, openpyxl

COLUMNS = ['productCode', 'hsnCode', 'model', 'family', 'series', 'description', 'category',
           'hpRating', 'fad', 'workingPressure', 'capacityCfm', 'maxPressure', 'motorKw',
           'starterType', 'dimensionsMm', 'weightKg', 'spcKw100Cfm', 'gstPct', 'piePrice',
           'elgiPrice', 'warrantyMonths', 'leadTimeDays', 'uom', 'notes']


def norm(v):
    return re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''


def blank(v):
    return norm(v) in ('', '-')


def n(x):
    """22.0 -> '22', 3.74 -> '3.74'."""
    f = float(x)
    return str(int(f)) if f == int(f) else ('%g' % f)


def find_header(ws):
    for r in range(1, 30):
        vals = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
        if 'Model' in vals and any(v.startswith('FAD') for v in vals):
            return r, vals
    raise SystemExit('No header row with "Model" and "FAD" found.')


def col(headers, *starts):
    for s in starts:
        for i, h in enumerate(headers):
            if h.lower().startswith(s.lower()):
                return i
    raise SystemExit('Column not found: ' + ' / '.join(starts))


def code_for(model, series):
    m = re.match(r'^([A-Z]+)\s*(\d+(?:PM|SP)?)\s*[- ]\s*(\d+(?:\.\d+)?)\s*(V|DM)?$', model)
    if not m:
        raise SystemExit('Cannot make a code from model "%s"' % model)
    fam, size, bar, suffix = m.groups()
    code = '%s%s-%s%s' % (fam, size, bar, 'V' if suffix == 'V' else '')
    ie = re.search(r'\bIE(\d)\b', series)
    if ie:
        code += '-IE' + ie.group(1)
    return code, fam, bar


def main():
    src, out_path = sys.argv[1], sys.argv[2]
    existing = {}
    for path in sys.argv[3:]:
        for r in csv.DictReader(open(path, encoding='utf-8-sig')):
            existing[r['productCode']] = r['model']

    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb.worksheets[0]
    hr, H = find_header(ws)
    c = {
        'series': col(H, 'Series'), 'model': col(H, 'Model'), 'doc': col(H, 'Document No'),
        'rev': col(H, 'Revision'), 'date0': col(H, 'Date (Original)'),
        'date1': col(H, 'Date (Revision)'), 'tpl': col(H, 'TPL Number'),
        'cfm': col(H, 'FAD - Free Air Delivery (cfm)'), 'm3': col(H, 'FAD - Free Air Delivery (m'),
        'wp': col(H, 'Working Pressure'), 'unload': col(H, 'Unload Pressure'),
        'pin': col(H, 'Package input power @ full load / 100% flow (kW)'),
        'pzero': col(H, 'Package input power @ zero flow (kW)'),
        'spc': col(H, 'Specific power consumption @ full load (kW/100cfm)'),
        'control': col(H, 'Capacity control'), 'supply': col(H, 'Nominal power supply'),
        'motor': col(H, 'Main motor rating'), 'mtype': col(H, 'Type of motors'),
        'eff': col(H, 'Efficiency of main motor'), 'starter': col(H, 'Type of starter'),
        'oil': col(H, 'Oil recommended'), 'oilfill': col(H, 'Total oil fill'),
        'noise': col(H, 'Noise level'), 'port': col(H, 'Air outlet port'),
        'dims': col(H, 'Overall dimensions of unit'), 'weight': col(H, 'Package nett weight'),
    }

    # The models block ends at the first empty row; the VFD part-load table, if any, follows.
    models, r = [], hr + 1
    while r <= ws.max_row and not blank(ws.cell(r, c['model'] + 1).value):
        models.append([ws.cell(r, k + 1).value for k in range(len(H))])
        r += 1
    part = {}
    for rr in range(r, ws.max_row + 1):
        if norm(ws.cell(rr, 1).value).startswith('VFD Part-Load'):
            ph = [norm(ws.cell(rr + 1, k).value) for k in range(1, ws.max_column + 1)]
            pi = {h: i for i, h in enumerate(ph)}
            for x in range(rr + 2, ws.max_row + 1):
                row = [ws.cell(x, k).value for k in range(1, ws.max_column + 1)]
                if blank(row[pi['Model']]):
                    break
                key = (norm(row[pi['Series']]), norm(row[pi['Model']]))
                part.setdefault(key, []).append(
                    '%s%% %s cfm %s kW' % (n(row[pi['Turn Down Ratio (%)']]),
                                          n(row[pi['Capacity (cfm)']]), n(row[pi['Input Power (kW)']])))
            break

    out, seen = [], {}
    for v in models:
        g = lambda k: v[c[k]]
        series, model = norm(g('series')), norm(g('model'))
        code, fam, bar = code_for(model, series)
        if code in seen:
            raise SystemExit('Two rows make code %s: %s and %s' % (code, seen[code], model))
        seen[code] = model
        ie = re.search(r'\bIE(\d)\b', series)
        shown = model + (' (IE%s motor)' % ie.group(1) if ie else '')

        mk = re.match(r'([\d.]+)\s*\(([\d.]+)\)', norm(g('motor')))
        kw, hp = n(mk.group(1)), n(mk.group(2))
        vfd = 'variable' in norm(g('control')).lower()
        pm = 'permanent magnet' in norm(g('mtype')).lower()
        effcls = re.search(r'\bIE\d\b', norm(g('eff')))
        drive = 'variable speed (VFD)' if vfd else 'load/unload'
        if pm:
            drive += ', permanent magnet motor'
        elif ie:
            pass                      # already in the model name
        elif effcls:
            drive += ', %s motor' % effcls.group(0)
        date = norm(g('date0')) if blank(g('date1')) else norm(g('date1'))

        notes = ['ELGi TPL %s. Spec sheet %s rev %s (%s).' % (norm(g('tpl')), norm(g('doc')), norm(g('rev')), date),
                 'Control: %s.' % norm(g('control')) + (
                     '' if norm(g('starter')).lower() == norm(g('control')).lower()
                     else ' Starter: %s.' % norm(g('starter'))),
                 'Input power %s kW at full load%s.' % (
                     n(g('pin')),
                     '' if blank(g('pzero')) or float(g('pzero')) == 0 else ', %s kW unloaded' % n(g('pzero'))),
                 'SPC %s kW/100cfm.' % n(g('spc')),
                 'Motor efficiency %s.' % norm(g('eff')),
                 'Noise %s dB(A). Outlet %s.' % (norm(g('noise')), norm(g('port'))),
                 'Oil: %s, %s l fill.' % (norm(g('oil')), n(g('oilfill')))]
        pl = part.get((series, model))
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
            'dimensionsMm': '%s mm (L x W x H)' % norm(g('dims')),
            'weightKg': '%s kg (dry)' % n(g('weight')),
            'spcKw100Cfm': n(g('spc')),
            'gstPct': '', 'piePrice': '', 'elgiPrice': '', 'warrantyMonths': '', 'leadTimeDays': '',
            'uom': 'Nos',
            'notes': ' '.join(notes),
        })

    clash = [o['productCode'] for o in out if o['productCode'] in existing]
    if clash:
        print('Already in the earlier upload (would update, not add):', clash)

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL)
    w.writeheader()
    w.writerows(out)
    with open(out_path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(buf.getvalue())
    print(len(out), 'models written to', out_path, '| with part-load table:',
          sum(1 for o in out if 'Part load' in o['notes']))


if __name__ == '__main__':
    main()
