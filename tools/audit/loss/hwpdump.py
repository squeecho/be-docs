#!/usr/bin/env python3
"""HWP 5.0 본문 레코드를 들여쓰기로 출력한다(진단용). python3 -I hwpdump.py <hwp> [찾을 글자]"""
import os, struct, sys, zlib
sys.path.insert(0, os.environ.get('PYLIB') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'pylib'))
import olefile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inventory import hwp_para_text
TAGS = {66: 'PARA_HEADER', 67: 'PARA_TEXT', 68: 'CHAR_SHAPE', 69: 'LINE_SEG', 70: 'RANGE_TAG', 71: 'CTRL_HEADER', 72: 'LIST_HEADER', 73: 'PAGE_DEF', 76: 'SHAPE_COMPONENT', 77: 'TABLE', 85: 'PICTURE', 87: 'CTRL_DATA', 88: 'EQEDIT', 91: 'FORM_OBJECT'}
ole = olefile.OleFileIO(sys.argv[1])
want = sys.argv[2] if len(sys.argv) > 2 else None
for e in sorted(x for x in ole.listdir() if x[0] == 'BodyText'):
    raw = zlib.decompress(ole.openstream(e).read(), -15)
    pos = 0
    lines = []
    while pos + 4 <= len(raw):
        h = struct.unpack_from('<I', raw, pos)[0]; pos += 4
        tag, level, size = h & 0x3FF, (h >> 10) & 0x3FF, (h >> 20) & 0xFFF
        if size == 0xFFF: size = struct.unpack_from('<I', raw, pos)[0]; pos += 4
        body = raw[pos:pos + size]; pos += size
        extra = ''
        if tag == 71: extra = struct.pack('>I', struct.unpack_from('<I', body, 0)[0]).decode('latin1')
        if tag == 67: extra = hwp_para_text(body)[:80].replace('\n', '/')
        if tag == 68: extra = str([struct.unpack_from('<II', body, i) for i in range(0, min(len(body), 40), 8)])
        if tag == 66: extra = 'chars=%d ctrlmask=%x' % (struct.unpack_from('<I', body, 0)[0] & 0x7fffffff, struct.unpack_from('<I', body, 4)[0])
        lines.append('  ' * level + f'{TAGS.get(tag, tag)} {extra}')
    for i, l in enumerate(lines):
        if want is None or want in l:
            print('\n'.join(lines[max(0, i - 8):i + 3])); print('-----')
