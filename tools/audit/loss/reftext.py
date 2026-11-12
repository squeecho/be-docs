#!/usr/bin/env python3
"""완전성 오라클 2단계: LibreOffice·pdftotext로 '기준 글자'를 만든다(뷰어와 독립된 엔진).

사용법:
  LC_ALL=C.UTF-8 python3 -I reftext.py <목록> <ref 폴더> [--lo-profile DIR] [--batch 12]
  목록: capture.mjs와 같은 형식(절대경로[TAB비밀번호]). 비밀번호 파일은 건너뛴다.

결과: <ref>/<id>/
  writer.txt            워드류(doc·docx·rtf·odt …) → 텍스트
  calc-<시트>.csv       엑셀류 → 시트마다 CSV(보이는 서식 그대로, 숨긴 시트 포함)
  impress.pdf/.txt      파워포인트류 → PDF → pdftotext
  pdf.txt               PDF → pdftotext (쪽 사이 \\f)
  conv.docx|xlsx|pptx   옛 형식(doc·xls·ppt)을 OOXML로 바꾼 것(inventory.py가 구조를 읽는 데 씀)
LibreOffice는 같은 프로필로 동시에 돌리면 안 되므로 한 번에 하나씩, 여러 파일을 묶어서 돌린다.
"""
import hashlib, os, re, shutil, subprocess, sys, tempfile

WRITER = {'doc', 'docx', 'docm', 'dotx', 'dot', 'dotm', 'rtf', 'odt', 'xml'}
CALC = {'xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xlt', 'ods', 'csv', 'tsv'}
IMPRESS = {'ppt', 'pptx', 'pptm', 'ppsx', 'potx', 'pps', 'pot', 'odp'}
LEGACY = {'doc': 'docx', 'dot': 'docx', 'xls': 'xlsx', 'xlt': 'xlsx', 'xlsb': 'xlsx', 'ppt': 'pptx', 'pps': 'pptx', 'pot': 'pptx'}
CSV_FILTER = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,false,true,true,false,false,-1'
TARGETS = {
    'txt': 'txt:Text (encoded):UTF8',
    'csv': CSV_FILTER,
    'pdf': 'pdf',
    'docx': 'docx:MS Word 2007 XML',
    'xlsx': 'xlsx:Calc MS Excel 2007 XML',
    'pptx': 'pptx:Impress MS PowerPoint 2007 XML',
}


def file_id(path):
    base = f"{os.path.basename(os.path.dirname(path))}__{os.path.basename(path)}"
    base = re.sub(r'[^\w.\-가-힣]+', '_', base, flags=re.ASCII)
    return f"{base}.{hashlib.sha1(path.encode('utf-8')).hexdigest()[:6]}"


def ext_of(path):
    name = os.path.basename(path)
    m = re.search(r'\.([A-Za-z0-9]+)$', name)
    e = m.group(1).lower() if m else ''
    if not e:
        if 'docx' in name: return 'docx'
        if 'doc' in name: return 'doc'
    return e


def run_lo(profile, target, files, outdir, timeout):
    cmd = ['soffice', f'-env:UserInstallation=file://{profile}', '--headless', '--norestore',
           '--convert-to', TARGETS[target], '--outdir', outdir] + files
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
                       env={**os.environ, 'LC_ALL': 'C.UTF-8', 'LANG': 'C.UTF-8'})
        return True
    except subprocess.TimeoutExpired:
        subprocess.run(['pkill', '-9', '-f', f'UserInstallation=file://{profile}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return False


def main():
    lst, ref = sys.argv[1], sys.argv[2]
    profile = os.path.abspath(sys.argv[sys.argv.index('--lo-profile') + 1]) if '--lo-profile' in sys.argv else os.path.join(os.path.dirname(os.path.abspath(ref)), 'lo-profile')
    batch = int(sys.argv[sys.argv.index('--batch') + 1]) if '--batch' in sys.argv else 12
    os.makedirs(ref, exist_ok=True)
    jobs = {t: [] for t in TARGETS}
    for line in open(lst, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line: continue
        path, *pw = line.split('\t')
        if pw: continue  # 비밀번호 파일은 기준 글자를 만들 수 없다
        e, fid = ext_of(path), file_id(path)
        d = os.path.join(ref, fid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'source.txt'), 'w', encoding='utf-8') as f: f.write(path)
        if e == 'pdf':
            out = os.path.join(d, 'pdf.txt')
            if not os.path.exists(out):
                subprocess.run(['pdftotext', '-enc', 'UTF-8', path, out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            continue
        if e in WRITER: jobs['txt'].append((path, fid, e))
        elif e in CALC: jobs['csv'].append((path, fid, e))
        elif e in IMPRESS: jobs['pdf'].append((path, fid, e))
        if e in LEGACY: jobs[LEGACY[e]].append((path, fid, e))

    def done(fid, target):
        d = os.path.join(ref, fid)
        names = os.listdir(d)
        if target == 'txt': return 'writer.txt' in names
        if target == 'csv': return any(n.startswith('calc-') for n in names) or 'calc.none' in names
        if target == 'pdf': return 'impress.pdf' in names
        return f'conv.{target}' in names

    for target, items in jobs.items():
        todo = [it for it in items if not done(it[1], target)]
        print(f'{target}: {len(todo)} files', flush=True)
        for i in range(0, len(todo), batch):
            chunk = todo[i:i + batch]
            for attempt in ('batch', 'single'):
                pending = [it for it in chunk if not done(it[1], target)]
                if not pending: break
                groups = [pending] if attempt == 'batch' else [[it] for it in pending]
                for g in groups:
                    with tempfile.TemporaryDirectory(dir=ref) as tmp:
                        stage, outd = os.path.join(tmp, 'in'), os.path.join(tmp, 'out')
                        os.makedirs(stage); os.makedirs(outd)
                        files = []
                        for path, fid, e in g:
                            s = os.path.join(stage, f'{fid}.{e or "bin"}')
                            os.symlink(path, s)
                            files.append(s)
                        run_lo(profile, target, files, outd, 60 + 25 * len(g))
                        for path, fid, e in g:
                            d = os.path.join(ref, fid)
                            for n in os.listdir(outd):
                                if not n.startswith(fid): continue
                                rest = n[len(fid):]
                                src = os.path.join(outd, n)
                                if target == 'txt' and rest == '.txt': shutil.move(src, os.path.join(d, 'writer.txt'))
                                elif target == 'csv' and rest.endswith('.csv'):
                                    sheet = rest[1:-4] if rest.startswith('-') else ''
                                    shutil.move(src, os.path.join(d, f'calc-{sheet}.csv'))
                                elif target == 'pdf' and rest == '.pdf':
                                    shutil.move(src, os.path.join(d, 'impress.pdf'))
                                    subprocess.run(['pdftotext', '-enc', 'UTF-8', os.path.join(d, 'impress.pdf'), os.path.join(d, 'impress.txt')],
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
                                elif rest == f'.{target}': shutil.move(src, os.path.join(d, f'conv.{target}'))
                            if attempt == 'single' and not done(fid, target):
                                open(os.path.join(d, f'{target}.failed'), 'w').close()
                                if target == 'csv': open(os.path.join(d, 'calc.none'), 'w').close()
            print(f'  {target} {min(i + batch, len(todo))}/{len(todo)}', flush=True)


if __name__ == '__main__':
    main()
