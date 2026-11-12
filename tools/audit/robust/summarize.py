#!/usr/bin/env python3
"""결과(jsonl) 요약. python3 -I summarize.py out/fuzz-1x.jsonl [out/matrix-cdp6.jsonl ...]
- 상태별 개수, 깃발(flags)별 개수와 파일, 가장 긴 화면 멈춤 상위, 오류 이유(reason)별 개수(시드·변형별)
"""
import json, os, sys
from collections import Counter, defaultdict

for f in sys.argv[1:]:
    rs = [json.loads(l) for l in open(f) if l.strip()]
    print(f'\n=== {f}  ({len(rs)}개)')
    print('상태:', dict(Counter(r.get('state') for r in rs)))
    fl = defaultdict(list)
    for r in rs:
        for x in r.get('flags') or []:
            fl[x.split('>')[0] if x.startswith(('FREEZE', 'SLOW')) else x].append(r)
    for k, v in sorted(fl.items(), key=lambda kv: -len(kv[1])):
        print(f'  {k}: {len(v)}')
        for r in sorted(v, key=lambda r: -(r.get('maxLT') or 0))[:12]:
            print(f"     maxLT={r.get('maxLT')} t={r.get('tTerminal')} {r.get('state')}/{r.get('reason') or r.get('kind')} {os.path.basename(r['file'])}")
    print('오류 이유:', dict(Counter(r.get('reason') for r in rs if r.get('state') == 'error')))
    top = sorted(rs, key=lambda r: -(r.get('maxLT') or 0))[:15]
    print('가장 긴 멈춤:')
    for r in top:
        print(f"   {r.get('maxLT'):>7} ms  tbt={r.get('tbt')} t={r.get('tTerminal')} {r.get('state')} {os.path.basename(r['file'])}")
