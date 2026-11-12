// 문서 엔진이 화면에 그리지 않는 것들을 파일에서 직접 세고 꺼낸다(조용히 빠지지 않게).
// - 읽을 수 있는 것(메모·검토 의견·발표자 노트)은 글을 꺼내 "보기"로 보여 준다.
// - 그리지 못하는 것(삽입 개체·EMF/WMF 그림·수식·끼워 넣은 문서·워터마크·숨긴 슬라이드)은 개수를 알린다.
// 모두 화면 스레드에서 한 번만 읽고, 실패해도 문서 표시는 그대로 둔다.

const dec = new TextDecoder();
const text = (parts, name) => {
  const b = parts.get(name.toLowerCase());
  return b ? dec.decode(b) : '';
};
const count = (s, re) => (s.match(re) || []).length;
const unescape = (t) => t.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  if (k === 'amp') return '&';
  return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
});
// XML 조각의 글자(<x:t>…</x:t>)를 이어 붙인다. 문단(<x:p>)마다 줄을 바꾼다.
function xmlText(xml, tTag = 't', pTag = 'p') {
  const out = [];
  for (const p of xml.split(new RegExp(`<(?:\\w+:)?${pTag}[\\s>/]`))) {
    const line = [...p.matchAll(new RegExp(`<(?:\\w+:)?${tTag}(?:\\s[^>]*)?>([^<]*)<\\/(?:\\w+:)?${tTag}>`, 'g'))].map((m) => unescape(m[1])).join('');
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n');
}
const attr = (s, k) => {
  const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s);
  return m ? unescape(m[1]) : null;
};

// ---------------------------------------------------------------- 워드(docx)

export function docxExtras(parts) {
  const body = text(parts, 'word/document.xml');
  const comments = [];
  for (const m of text(parts, 'word/comments.xml').matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const t = xmlText(m[2]);
    if (t) comments.push({ who: attr(m[1], 'w:author') || '', text: t });
  }
  // 워터마크는 머리말 속 글자 그림(VML textpath)이다. 본문의 워드아트도 같은 방식이라 엔진이 그리지 못한다.
  let watermark = false;
  for (const name of [...parts.keys()].filter((n) => /^word\/header\d*\.xml$/.test(n))) {
    if (/PowerPlusWaterMarkObject|<v:textpath\b/.test(text(parts, name))) watermark = true;
  }
  const media = [...parts.keys()].filter((n) => /^word\/media\/.+\.(emf|wmf)$/.test(n)).length;
  const objects = count(body, /<o:OLEObject\b/g);
  return {
    comments,
    tracked: count(body, /<w:(ins|del)\b/g),
    objects,
    // 개체 미리보기도 대개 EMF라서 개체 수만큼은 빼고 센다.
    metafiles: Math.max(0, media - objects),
    equations: count(body, /<m:oMath\b/g),
    altChunks: count(body, /<w:altChunk\b/g),
    wordArt: count(body, /<v:textpath\b/g),
    watermark,
  };
}

// 옛 워드(doc): 삽입 개체는 ObjectPool 아래 "_숫자" 저장소로 들어 있다. OLE 해석기(SheetJS, 약 1MB)를 불러 풀면
// 느린 휴대폰에서 문서가 보인 직후 1초 넘게 멈춰서, 128바이트 단위 디렉터리 항목만 훑어 센다
// (이름이 "_"+숫자이고 종류가 저장소(1)인 항목. 워드 문서 159개에서 해석기로 센 값과 같았다).
export function docObjects(bytes) {
  let n = 0;
  for (let i = 512; i + 128 <= bytes.length; i += 128) {
    const len = bytes[i + 64] | (bytes[i + 65] << 8);
    if (bytes[i + 66] !== 1 || len < 6 || len > 64 || len & 1) continue;
    if (bytes[i] !== 0x5f || bytes[i + 1] !== 0 || bytes[i + len - 2] !== 0 || bytes[i + len - 1] !== 0) continue;
    let digits = true;
    for (let j = 2; j < len - 2 && digits; j += 2) digits = bytes[i + j + 1] === 0 && bytes[i + j] >= 0x30 && bytes[i + j] <= 0x39;
    if (digits) n++;
  }
  return n;
}

// ---------------------------------------------------------------- 파워포인트(pptx)

export function pptxExtras(parts) {
  const pres = text(parts, 'ppt/presentation.xml');
  const presRels = text(parts, 'ppt/_rels/presentation.xml.rels');
  const relTarget = new Map([...presRels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const slides = [...pres.matchAll(/<p:sldId\b([^>]*)\/?>/g)].map((m) => {
    const t = relTarget.get(attr(m[1], 'r:id')) || '';
    return t.startsWith('/') ? t.slice(1) : `ppt/${t.replace(/^\.\//, '')}`;
  });
  const notes = [];
  const comments = [];
  const hidden = [];
  let objects = 0;
  const authors = new Map([...text(parts, 'ppt/commentAuthors.xml').matchAll(/<p:cmAuthor\b([^>]*)>/g)].map((m) => [attr(m[1], 'id'), attr(m[1], 'name') || '']));
  slides.forEach((path, i) => {
    const xml = text(parts, path);
    if (/<p:sld\b[^>]*\bshow="(0|false)"/.test(xml)) hidden.push(i + 1);
    objects += count(xml, /<p:oleObj\b/g);
    const rels = text(parts, path.replace(/([^/]+)$/, '_rels/$1.rels'));
    for (const r of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const type = attr(r[1], 'Type') || '';
      const target = (attr(r[1], 'Target') || '').replace(/^\.\.\//, 'ppt/');
      if (/notesSlide$/.test(type)) {
        // 노트 쪽의 본문 자리(ph type="body")에 적힌 글만 노트로 본다(슬라이드 그림·번호 자리는 뺀다).
        const nx = text(parts, target);
        const t = [...nx.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)]
          .filter((sp) => /<p:ph\b[^>]*type="body"/.test(sp[1]))
          .map((sp) => xmlText(sp[1])).join('\n').trim();
        if (t) notes.push({ slide: i + 1, text: t });
      } else if (/\/comments$/.test(type)) {
        // 옛 메모(<p:cm>…<p:text>)와 2018년 이후 메모(<p188:cm>…<a:t>) 모두
        const cx = text(parts, target);
        let found = 0;
        for (const c of cx.matchAll(/<p:cm\b([^>]*)>([\s\S]*?)<\/p:cm>/g)) {
          const t = /<p:text>([\s\S]*?)<\/p:text>/.exec(c[2]);
          if (t && t[1].trim()) {
            comments.push({ slide: i + 1, who: authors.get(attr(c[1], 'authorId')) || '', text: unescape(t[1].trim()) });
            found++;
          }
        }
        if (!found) {
          for (const c of cx.matchAll(/<(\w+:)?cm\b[^>]*>([\s\S]*?)<\/\1cm>/g)) {
            const t = xmlText(c[2]);
            if (t) comments.push({ slide: i + 1, who: '', text: t });
          }
        }
      }
    }
  });
  return { notes, comments, hidden, objects };
}

// ---------------------------------------------------------------- 한글 메모(HWP 5.0·HWPX)

// PARA_TEXT(UTF-16LE)에서 조판 부호를 빼고 글자만 꺼낸다(HWP 5.0 문서 형식 4.3.2).
function paraText(b) {
  let out = '';
  const n = b.length >> 1;
  for (let i = 0; i < n;) {
    const ch = b[2 * i] | (b[2 * i + 1] << 8);
    if (ch >= 32) {
      out += String.fromCharCode(ch);
      i++;
    } else if (ch === 10 || ch === 13) {
      out += '\n';
      i++;
    } else if (ch === 24) {
      out += '-';
      i++;
    } else if (ch === 30 || ch === 31) {
      out += ' ';
      i++;
    } else if (ch === 9) {
      out += '\t';
      i += 8;
    } else if (ch === 0 || (ch >= 25 && ch <= 29)) {
      i++;
    } else {
      i += 8;
    }
  }
  return out;
}

// HWP 5.0: 본문 기록 중 메모 목록(MEMO_LIST, 93) 뒤에 같은 수준으로 이어지는 문단이 메모 글이다.
export function hwp5Memos(XLSX, bytes) {
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const header = XLSX.CFB.find(cfb, 'FileHeader');
  if (!header || !header.content) return [];
  const h = header.content;
  const props = h[36] | (h[37] << 8) | (h[38] << 16) | (h[39] << 24);
  if (props & 6) return []; // 비밀번호·배포용 문서는 본문이 암호화돼 있다
  const compressed = !!(props & 1);
  // 문서 정보(DocInfo)의 ID 매핑(17)에 메모 모양 수가 있다(5.0.2.1 이후). 0이면 메모가 없으니 본문을 풀지 않는다.
  const info = XLSX.CFB.find(cfb, 'DocInfo');
  if (info && info.content) {
    let d = info.content instanceof Uint8Array ? info.content : Uint8Array.from(info.content);
    if (compressed) d = Uint8Array.from(XLSX.CFB.utils._inflateRaw(d, 0));
    for (let pos = 0; pos + 4 <= d.length;) {
      const hd = (d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24)) >>> 0;
      pos += 4;
      let size = hd >>> 20;
      if (size === 0xfff) {
        size = (d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24)) >>> 0;
        pos += 4;
      }
      if ((hd & 0x3ff) === 17) {
        if (size >= 64) {
          const at = pos + 15 * 4;
          if ((d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) === 0) return [];
        }
        break;
      }
      pos += size;
    }
  }
  const sections = cfb.FullPaths
    .map((p, i) => [p, cfb.FileIndex[i]])
    .filter(([p, e]) => /BodyText\/Section\d+$/i.test(p) && e && e.content)
    .sort((a, b) => Number(/(\d+)$/.exec(a[0])[1]) - Number(/(\d+)$/.exec(b[0])[1]));
  const memos = [];
  for (const [, e] of sections) {
    let raw = e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content);
    if (compressed) raw = Uint8Array.from(XLSX.CFB.utils._inflateRaw(raw, 0));
    let memoLevel = -1;
    let current = null;
    for (let pos = 0; pos + 4 <= raw.length;) {
      const hd = (raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16) | (raw[pos + 3] << 24)) >>> 0;
      pos += 4;
      const tag = hd & 0x3ff;
      const level = (hd >>> 10) & 0x3ff;
      let size = hd >>> 20;
      if (size === 0xfff) {
        size = (raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16) | (raw[pos + 3] << 24)) >>> 0;
        pos += 4;
      }
      if (pos + size > raw.length) break;
      if (memoLevel >= 0 && level < memoLevel) {
        memoLevel = -1;
        current = null;
      }
      if (tag === 93) { // MEMO_LIST
        memoLevel = level;
        current = { who: '', text: '' };
        memos.push(current);
      } else if (tag === 67 && current) { // PARA_TEXT
        const t = paraText(raw.subarray(pos, pos + size)).trim();
        if (t) current.text = current.text ? `${current.text}\n${t}` : t;
      }
      pos += size;
    }
  }
  return memos.filter((m) => m.text);
}

// HWPX: <hp:fieldBegin type="MEMO"> 안의 subList 문단이 메모 글이다.
export function hwpxMemos(parts) {
  const memos = [];
  const names = [...parts.keys()].filter((n) => /^contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  for (const n of names) {
    for (const m of text(parts, n).matchAll(/<(?:\w+:)?fieldBegin\b[^>]*type="MEMO"[^>]*>([\s\S]*?)<\/(?:\w+:)?fieldBegin>/g)) {
      const who = (/<(?:\w+:)?stringParam name="Author">([^<]*)</.exec(m[1]) || [])[1] || '';
      const sub = /<(?:\w+:)?subList\b[\s\S]*?<\/(?:\w+:)?subList>/.exec(m[1]);
      const t = sub ? xmlText(sub[0]) : '';
      if (t) memos.push({ who: unescape(who), text: t });
    }
  }
  return memos;
}
