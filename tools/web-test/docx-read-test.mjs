// 긴 docx 빠른 읽기(app/src/main/assets/viewer/docx-read.js) 단위 시험. 브라우저 없이 노드로 1초 안에 끝나 CI 빌드에서 돈다.
// 작은 docx를 그 자리에서 만들어, 검토·대조(tools/audit/docx-read/)에서 잡았던 결함이 되살아나지 않는지 본다.
// 사용: node tools/web-test/docx-read-test.mjs   (viewer-libs에서 npm ci를 해 둬야 한다: fflate)
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fflate = createRequire(path.join(root, 'viewer-libs/package.json'))('fflate');
const { readDocx } = await import(pathToFileURL(path.join(root, 'app/src/main/assets/viewer/docx-read.js')).href);

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));

// parts: { 'word/document.xml': 본문 안쪽(<w:body> 속), styles, numbering, footnotes, header, rels: [[id, 종류, 대상]], files }
function docx({ body, styles = '', numbering = '', footnotes = '', header = '', rels = [], files = {}, pages = 0 }) {
  const enc = (s) => fflate.strToU8(s);
  const relXml = (list) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const all = [...rels];
  const out = {
    '[Content_Types].xml': enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': enc(relXml([['rId1', 'officeDocument', 'word/document.xml']])),
    'word/document.xml': enc(`<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${body}</w:body></w:document>`),
    ...files,
  };
  if (styles) { out['word/styles.xml'] = enc(`<w:styles ${NS}>${styles}</w:styles>`); all.push(['rS', 'styles', 'styles.xml']); }
  if (numbering) { out['word/numbering.xml'] = enc(`<w:numbering ${NS}>${numbering}</w:numbering>`); all.push(['rN', 'numbering', 'numbering.xml']); }
  if (footnotes) { out['word/footnotes.xml'] = enc(`<w:footnotes ${NS}>${footnotes}</w:footnotes>`); all.push(['rF', 'footnotes', 'footnotes.xml']); }
  if (header) { out['word/header1.xml'] = enc(`<w:hdr ${NS}>${header}</w:hdr>`); all.push(['rH', 'header', 'header1.xml']); }
  if (pages) out['docProps/app.xml'] = enc(`<Properties><Pages>${pages}</Pages></Properties>`);
  out['word/_rels/document.xml.rels'] = enc(relXml(all));
  return fflate.zipSync(out);
}

const read = (spec) => readDocx(docx(spec), fflate.inflateSync);
const p = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
// 블록을 글로: 문단 "제목수준|글", 표 [칸(rowspan·colspan)…], 쪽 나눔 ⏎
const flat = (blocks) => blocks.map((b) => {
  if (b.t === 'p') return `${b.heading ? `h${b.heading}|` : ''}${b.runs.map((x) => (x.text != null ? x.text : `[img${x.img}]`)).join('')}`;
  if (b.t === 'table') return `T[${b.rows.map((row) => row.cells.map((c) => `${flat(c.blocks).join('/')}${c.rowspan > 1 ? `r${c.rowspan}` : ''}${c.colspan > 1 ? `c${c.colspan}` : ''}`).join(',')).join(';')}]`;
  return '⏎';
});

let failed = 0;
function check(name, fn) {
  try {
    const msg = fn();
    if (msg) { failed++; console.log(`실패  ${name}: ${msg}`); } else console.log(`통과  ${name}`);
  } catch (e) {
    failed++;
    console.log(`실패  ${name}: ${e && e.stack}`);
  }
}
const expect = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? '' : `기대 ${JSON.stringify(want)}\n      실제 ${JSON.stringify(got)}`);

check('지운 글·고치기 전 서식은 빼고 넣은 글은 둔다(빈 태그로 쓴 건너뛰기 표시가 뒤 글을 삼키지 않음)', () => {
  const res = read({
    body: p(`<w:r><w:rPr><w:rPrChange w:id="1"/></w:rPr><w:t>가</w:t></w:r><w:del w:id="2"><w:r><w:rPr><w:b/><w:i/></w:rPr><w:delText>지움</w:delText><w:t>w:t로 쓴 지운 글</w:t></w:r></w:del>`
      + `<w:ins w:id="3"><w:r><w:t>나</w:t></w:r></w:ins><w:del w:id="4"/>${r('다')}`),
  });
  return expect(flat(res.blocks), ['가나다']);
});

check('숨긴 글은 빼고, 숨긴 글 속 각주 참조는 번호를 매기지 않음', () => {
  const res = read({
    body: p(`${r('숨김', '<w:vanish/>')}<w:r><w:rPr><w:vanish/></w:rPr><w:footnoteReference w:id="1"/></w:r>${r('본문')}<w:r><w:footnoteReference w:id="2"/></w:r>`),
    footnotes: `<w:footnote w:id="1">${p(r('숨은 각주'))}</w:footnote><w:footnote w:id="2">${p(r('보이는 각주'))}</w:footnote>`,
  });
  return expect([flat(res.blocks), res.extras.footnotes], [['본문[1]'], ['보이는 각주']]);
});

check('끝 표시가 없는 깨진 필드가 뒤 문단을 숨기지 않음', () => {
  const res = read({ body: p(`${r('앞')}<w:r><w:fldChar w:fldCharType="begin"/></w:r>${r('코드처럼 보이는 글')}`) + p(r('다음 문단')) });
  return expect(flat(res.blocks), ['앞', '다음 문단']);
});

check('필드는 코드 대신 결과를 보여 줌', () => {
  const res = read({
    body: p(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('7')}<w:r><w:fldChar w:fldCharType="end"/></w:r>쪽`.replace('쪽', r('쪽'))),
  });
  return expect(flat(res.blocks), ['7쪽']);
});

check('제목은 스타일로만(제목 1·heading 2·개요 수준 스타일), 문단에 직접 준 개요 수준은 제목이 아님', () => {
  const res = read({
    styles: '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="제목 1"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Out"><w:name w:val="내 개요"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>',
    body: p(r('가'), '<w:pStyle w:val="1"/>') + p(r('나'), '<w:pStyle w:val="H2"/>') + p(r('다'), '<w:pStyle w:val="Out"/>')
      + p(r('라'), '<w:outlineLvl w:val="0"/>'),
  });
  return expect(flat(res.blocks), ['h1|가', 'h2|나', 'h3|다', '라']);
});

check('기본 문단 스타일은 id가 아니라 w:default로 찾음(한국어 Word의 바탕글 "a")', () => {
  const res = read({
    styles: '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
      + '<w:style w:type="character" w:styleId="Em"><w:rPr><w:i/><w:color w:val="FF0000"/></w:rPr></w:style>',
    body: p(r('굵게') + r('기울임', '<w:rStyle w:val="Em"/>') + r('직접', '<w:b w:val="0"/><w:sz w:val="40"/>')),
  });
  const runs = res.blocks[0].runs.map((x) => [x.text, x.b, x.i, x.size, x.color || null]);
  return expect(runs, [['굵게', true, false, 12, null], ['기울임', true, true, 12, '#FF0000'], ['직접', false, false, 20, null]]);
});

check('번호 매기기: 단계별 번호, 정의가 없는 단계는 엔진처럼 "%n."', () => {
  const res = read({
    numbering: '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'
      + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="ganada"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum>'
      + '<w:abstractNum w:abstractNumId="1"/>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
    body: ['0', '1', '1', '0'].map((l, i) => p(r(`항목${i}`), `<w:numPr><w:ilvl w:val="${l}"/><w:numId w:val="1"/></w:numPr>`)).join('')
      + p(r('빈 정의'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
  });
  return expect(flat(res.blocks), ['1. 항목0', '가) 항목1', '나) 항목2', '2. 항목3', '1. 빈 정의']);
});

check('표: 가로로 합친 칸, 세로로 합친 칸, 앞을 비운 줄(gridBefore), 표 속 표 깊이', () => {
  const tc = (text, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${p(r(text))}</w:tc>`;
  const inner = `<w:tbl><w:tr>${tc('안')}</w:tr></w:tbl>`;
  const res = read({
    body: `<w:tbl><w:tr>${tc('a', '<w:gridSpan w:val="2"/>')}${tc('b', '<w:vMerge w:val="restart"/>')}</w:tr>`
      + `<w:tr>${tc('c')}${tc('d')}${tc('', '<w:vMerge/>')}</w:tr>`
      + `<w:tr><w:trPr><w:gridBefore w:val="2"/></w:trPr>${tc('', '<w:vMerge/>')}</w:tr>`
      + `<w:tr><w:tc>${inner}${p('')}</w:tc></w:tr></w:tbl>`,
  });
  return expect([flat(res.blocks), res.counts.depth, res.counts.tableRows], [['T[ac2,br3;c,d;;T[안]/]'], 2, 5]);
});

check('쪽 나눔(문단 중간이면 문단을 나눔)·글상자(본문 뒤에, 분량에는 안 셈)·확인란·기호', () => {
  const res = read({
    body: p(`${r('앞')}<w:r><w:br w:type="page"/></w:r>${r('뒤')}<w:r><w:br w:type="page"/></w:r>`)
      + p(`${r('본문')}<w:r><w:drawing><mc:AlternateContent><mc:Choice><w:txbxContent>${p(r('글상자'))}</w:txbxContent></mc:Choice>`
        + `<mc:Fallback><w:pict><w:txbxContent>${p(r('글상자'))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:drawing></w:r>`)
      + p(`<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="1"/></w:checkBox></w:ffData></w:fldChar></w:r>`
        + `<w:r><w:instrText> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>${r(' 동의')}`)
      + p(`<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r><w:r><w:tab/></w:r>${r('끝')}`),
  });
  const want = ['앞', '⏎', '뒤', '⏎', '본문', '글상자', '☒ 동의'];
  const got = flat(res.blocks);
  const sym = got.pop();
  return expect(got, want) || (sym.endsWith('\t끝') && sym.length === 3 ? '' : `기호 문단 ${JSON.stringify(sym)}`)
    || (res.counts.chars === '앞뒤본문 동의끝'.length ? '' : `글자 수 ${res.counts.chars}`);
});

check('그림: PNG는 꺼내고 같은 그림은 한 번만, EMF는 빠진 그림으로 셈', () => {
  const pic = (id) => `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const res = read({
    body: p(pic('rP') + pic('rP')) + p(pic('rE')),
    rels: [['rP', 'image', 'media/a.png'], ['rE', 'image', 'media/b.emf']],
    files: { 'word/media/a.png': PNG, 'word/media/b.emf': new Uint8Array(8) },
  });
  return expect([flat(res.blocks), res.images.length, res.images[0].type, res.blocks[0].runs[0].w, res.omittedImages],
    [['[img0][img0]', ''], 1, 'image/png', 100, 1]);
});

check('머리말·저장된 쪽 수', () => {
  const res = read({
    body: p(r('본문')) + '<w:sectPr><w:headerReference w:type="first" r:id="rX"/><w:headerReference w:type="default" r:id="rH"/></w:sectPr>',
    header: p(r('머리말 글')),
    pages: 42,
  });
  return expect([res.extras.header, res.counts.storedPages], ['머리말 글', 42]);
});

check('잘린 문서(닫히지 않은 문단·표)도 던지지 않고 읽은 만큼 보여 줌', () => {
  const bytes = docx({ body: `${p(r('하나'))}<w:tbl><w:tr><w:tc>${p(r('둘'))}` });
  // 본문 끝을 강제로 잘라 본다(ZIP은 온전하게, XML만 덜 끝남)
  const files = fflate.unzipSync(bytes);
  const xml = fflate.strFromU8(files['word/document.xml']);
  files['word/document.xml'] = fflate.strToU8(`${xml.slice(0, xml.indexOf('둘') + 1)}`);
  const res = readDocx(fflate.zipSync(files), fflate.inflateSync);
  const got = flat(res.blocks);
  return expect(got, ['하나', 'T[둘]']);
});

check('UTF-16 본문과 문자 참조', () => {
  const xml = `﻿<w:document ${NS}><w:body>${p(r('&#xAC00;&amp;&lt;나&gt;'))}</w:body></w:document>`;
  const u16 = new Uint8Array(xml.length * 2);
  for (let i = 0; i < xml.length; i++) { u16[i * 2] = xml.charCodeAt(i) & 255; u16[i * 2 + 1] = xml.charCodeAt(i) >> 8; }
  const files = fflate.unzipSync(docx({ body: '' }));
  files['word/document.xml'] = u16;
  return expect(flat(readDocx(fflate.zipSync(files), fflate.inflateSync).blocks), ['가&<나>']);
});

check('ZIP이 아니거나 본문이 없으면 오류를 던짐(엔진으로 넘어가게)', () => {
  let a = '';
  let b = '';
  try { readDocx(new Uint8Array(100), fflate.inflateSync); } catch (e) { a = String(e.message); }
  const files = fflate.unzipSync(docx({ body: '' }));
  delete files['word/document.xml'];
  try { readDocx(fflate.zipSync(files), fflate.inflateSync); } catch (e) { b = String(e.message); }
  return a && b ? '' : `ZIP 아님: ${a || '안 던짐'}, 본문 없음: ${b || '안 던짐'}`;
});

console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
