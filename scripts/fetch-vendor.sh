#!/usr/bin/env bash
# 뷰어 화면이 쓰는 외부 라이브러리를 받아 app/src/main/assets/viewer/vendor 에 넣는다.
# 용량이 커서(약 16MB) 저장소에는 넣지 않고, 빌드 전에 이 스크립트로 받는다.
#
# - rhwp: HWP·HWPX 파서/렌더러 (MIT)
# - @extend-ai/react-pptx + React: PPT·PPTX 렌더러 (MIT)
# - @extend-ai/react-docx: Word(docx·doc) 렌더러 (MIT)
# - fast-formula-parser + @formulajs/formulajs: 결과 없이 저장된 엑셀 수식 계산 (MIT)
# - pdf.js(pdfjs-dist): PDF 렌더러 (Apache-2.0)
# - @noble/hashes + @noble/ciphers: 비밀번호 걸린 xlsx·docx·pptx·xls 풀기(SHA·AES·MD5) (MIT)
# - fflate: 화면 쪽 ZIP 항목 풀기. 깨진 압축 데이터에서도 멈추지 않는다 (MIT)
# - LibreDWG(@mlightcad/libredwg-web): CAD 도면(DWG·DXF) 해석 (GPL-3.0). 이 엔진 때문에 앱 전체가 GPL-3.0이다(LICENSE)
#   (위 여덟은 viewer-libs/package-lock.json 의 무결성 해시로 검증된다. 두 react 뷰어는 esbuild로 묶으면서
#    React를 함께 쓰는 조각으로 나눈다)
# - SheetJS: 엑셀·CSV 파서 (Apache-2.0) — 공식 CDN.
#   npm에 올라온 마지막 판(0.18.5)은 보안 취약점(CVE-2023-30533, CVE-2024-22363)이 있어
#   패치된 판(0.20.2 이상)을 공식 CDN에서 받아 SHA-256으로 검증한다.
set -euo pipefail

SHEETJS_VERSION=0.20.3
SHEETJS_SHA256=cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41

cd "$(dirname "$0")/.."
dest=app/src/main/assets/viewer/vendor
libs=viewer-libs
mods="$libs/node_modules"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rm -rf "$dest"
mkdir -p "$dest"

echo "npm 패키지 설치 (lockfile 고정)"
npm ci --prefix "$libs" --no-audit --no-fund --loglevel=error

echo "react-docx 알려진 문제 고치기"
node "$libs/patch-react-docx.mjs"

echo "rhwp 복사"
cp "$mods/@rhwp/core/rhwp.js" "$mods/@rhwp/core/rhwp_bg.wasm" "$dest/"
cp "$mods/@rhwp/core/LICENSE" "$dest/rhwp.LICENSE.txt"

echo "PPT·PPTX·Word 뷰어 묶기"
pptx="$mods/@extend-ai/react-pptx/dist"
docx="$mods/@extend-ai/react-docx/dist"
"$mods/.bin/esbuild" pptx-view="$libs/pptx-entry.js" docx-view="$libs/docx-entry.js" \
  --bundle --format=esm --splitting --minify --target=es2022 --outdir="$dest" \
  --entry-names=[name] --chunk-names=chunk-[hash] \
  --define:process.env.NODE_ENV='"production"' --log-level=warning
# Word 문서 해석은 별도 작업 스레드에서 돈다. 그 스크립트는 따로 한 파일로 묶는다.
"$mods/.bin/esbuild" "$docx/docx-import-worker.js" --bundle --format=esm --minify --target=es2022 \
  --outfile="$dest/docx-import-worker.js" --log-level=warning
# 묶음 안의 new URL("./…", import.meta.url) 이 가리키는 파일을 같은 폴더에 둔다.
cp "$pptx/native-parser-worker.js" "$pptx/pptx_wasm_bg.wasm" "$docx/docx_wasm_bg.wasm" "$dest/"
cp "$pptx/index.css" "$dest/pptx-view.css"
cp "$mods/@extend-ai/react-pptx/LICENSE" "$dest/react-pptx.LICENSE.txt" 2>/dev/null \
  || echo "MIT — https://github.com/extend-hq/react-pptx" > "$dest/react-pptx.LICENSE.txt"
cp "$mods/@extend-ai/react-docx/LICENSE" "$dest/react-docx.LICENSE.txt"
cp "$mods/react/LICENSE" "$dest/react.LICENSE.txt"

echo "PDF 엔진(pdf.js) 복사"
# 기기 웹뷰가 오래된 경우도 있어 구형 브라우저용(legacy) 빌드를 쓴다.
pj="$mods/pdfjs-dist"
mkdir -p "$dest/pdfjs"
cp "$pj/legacy/build/pdf.min.mjs" "$dest/pdfjs/pdf.mjs"
cp "$pj/legacy/build/pdf.worker.min.mjs" "$dest/pdfjs/pdf.worker.mjs"
# 무거운 도면 PDF에서 화면이 몇 초씩 멈추던 문제를 고친다(viewer-libs/patch-pdfjs.mjs 설명).
node "$libs/patch-pdfjs.mjs" "$dest/pdfjs/pdf.mjs"
cp -r "$pj/cmaps" "$pj/standard_fonts" "$pj/wasm" "$dest/pdfjs/"
cp "$pj/LICENSE" "$dest/pdfjs.LICENSE.txt"

echo "엑셀 수식 계산기 묶기"
"$mods/.bin/esbuild" "$libs/formula-entry.js" --bundle --format=esm --minify --target=es2022 \
  --outfile="$dest/formula.js" --log-level=warning
cp "$mods/fast-formula-parser/LICENSE" "$dest/fast-formula-parser.LICENSE.txt"
cp "$mods/@formulajs/formulajs/LICENSE" "$dest/formulajs.LICENSE.txt"

echo "ZIP 항목 풀기(fflate) 묶기"
"$mods/.bin/esbuild" "$libs/inflate-entry.js" --bundle --format=esm --minify --target=es2022 \
  --outfile="$dest/inflate.js" --log-level=warning
cp "$mods/fflate/LICENSE" "$dest/fflate.LICENSE.txt"

echo "비밀번호 문서 풀기(xlsx·docx·pptx·xls·doc) 묶기"
"$mods/.bin/esbuild" "$libs/office-crypto-entry.js" --bundle --format=esm --minify --target=es2022 \
  --outfile="$dest/office-crypto.js" --log-level=warning
cp "$mods/@noble/hashes/LICENSE" "$dest/noble-hashes.LICENSE.txt"
cp "$mods/@noble/ciphers/LICENSE" "$dest/noble-ciphers.LICENSE.txt"

echo "CAD 도면 엔진(LibreDWG) 복사"
# 패키지 안의 상대 경로(dist → ../wasm)를 그대로 둔다. 도면을 열 때만 작업 스레드(cad-worker.js)가 불러온다.
mkdir -p "$dest/libredwg"
cp -r "$mods/@mlightcad/libredwg-web/dist" "$mods/@mlightcad/libredwg-web/wasm" "$dest/libredwg/"
rm -f "$dest/libredwg/dist/"*.umd.cjs "$dest/libredwg/wasm/"*.d.ts
# 패키지에 라이선스 파일이 없어 같은 GPL-3.0 전문(저장소 LICENSE)을 함께 둔다.
cp LICENSE "$dest/libredwg.LICENSE.txt"

echo "앱 화면 글꼴(Pretendard, OFL) 복사"
mkdir -p "$dest/fonts"
cp "$mods/pretendard/dist/web/variable/woff2/PretendardVariable.woff2" "$dest/fonts/"
cp "$libs/pretendard-LICENSE.txt" "$dest/pretendard.LICENSE.txt"

echo "SheetJS $SHEETJS_VERSION 받는 중"
base="https://cdn.sheetjs.com/xlsx-$SHEETJS_VERSION/package"
if curl -fsSL --retry 3 "$base/dist/xlsx.full.min.js" -o "$tmp/xlsx.full.min.js"; then
  curl -fsSL --retry 3 "$base/LICENSE" -o "$tmp/xlsx.LICENSE.txt"
else
  # 공식 CDN에 닿지 않으면(사내망·CDN 장애) 같은 파일을 다시 올린 npm 패키지에서 받는다.
  # 아래 SHA-256이 공식 CDN 파일과 같아야만 쓰므로 받는 곳이 달라도 내용은 같다.
  echo "SheetJS CDN에 닿지 않아 npm 사본(@e965/xlsx@$SHEETJS_VERSION)에서 받습니다."
  (cd "$tmp" && npm pack "@e965/xlsx@$SHEETJS_VERSION" --silent >/dev/null && tar -xzf e965-xlsx-*.tgz)
  cp "$tmp/package/dist/xlsx.full.min.js" "$tmp/xlsx.full.min.js"
  cp "$tmp/package/LICENSE" "$tmp/xlsx.LICENSE.txt"
fi
echo "$SHEETJS_SHA256  $tmp/xlsx.full.min.js" | sha256sum -c --quiet - \
  || { echo "SheetJS 체크섬이 맞지 않습니다." >&2; exit 1; }
cp "$tmp/xlsx.full.min.js" "$dest/"
cp "$tmp/xlsx.LICENSE.txt" "$dest/xlsx.LICENSE.txt"

ls -l "$dest"
