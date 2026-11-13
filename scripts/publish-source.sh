#!/usr/bin/env bash
# 공개 소스 저장소(squeecho/be-docs)에 지금 커밋의 소스를 한 커밋으로 올린다(커밋 메시지 "be docs <판> 소스").
# 판 태그(v<판>)도 올려 보되, 권한이 없어 거절되면(예: 클로드 세션의 git 경로는 태그를 막는다) 경고만 하고 넘어간다.
# be docs는 GPL-3.0-or-later라 스토어에 올리는 판마다 그 판의 소스를 공개해야 한다(개발 이력은 필요 없다).
# 개발 저장소는 비공개로 두고, 여기서 이력·작성자 정보 없이 파일만 옮긴다.
#
# 사용: scripts/publish-source.sh <판 번호, 예: 0.2.95> [공개 저장소 주소]
#   판 번호는 그 판을 만든 CI 실행 번호(android #N → 0.2.N). 스토어에 올리기 전에 돌린다.
#   커밋 작성자: PUBLISH_AUTHOR="이름 <메일>"(기본: GitHub 비공개 메일 주소). 개인 메일이 공개 이력에 남지 않게 한다.
#   PUBLISH_TRAILERS: 커밋 메시지 끝에 붙일 줄(없으면 생략)
#
# 빼는 것: store/(출시 운영 문서: 사업자·D-U-N-S 절차, 등록정보 초안, 키 만드는 스크립트), app/debug.keystore(디버그 서명 키).
# 공개본은 디버그 키가 없으면 안드로이드 기본 디버그 키로 빌드된다(app/build.gradle.kts).
set -euo pipefail

version="${1:?판 번호를 주세요(예: 0.2.95)}"
remote="${2:-https://github.com/squeecho/be-docs.git}"
author="${PUBLISH_AUTHOR:-krayon studios <208177316+squeecho@users.noreply.github.com>}"
root="$(git rev-parse --show-toplevel)"
commit="$(git -C "$root" rev-parse --short HEAD)"

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "커밋하지 않은 변경이 있어요. 커밋한 판만 공개합니다." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"

# 공개 저장소가 비어 있으면(처음) 새로 시작하고, 아니면 마지막 판 위에 쌓는다
if git ls-remote --exit-code "$remote" HEAD >/dev/null 2>&1; then
  git clone -q --depth 100 "$remote" "$repo"
else
  git init -q -b main "$repo"
  git -C "$repo" remote add origin "$remote"
fi
if git ls-remote --exit-code --tags "$remote" "v$version" >/dev/null 2>&1 \
  || { git -C "$repo" rev-parse -q --verify HEAD >/dev/null && git -C "$repo" log --format=%s | grep -qxF "be docs $version 소스"; }; then
  echo "$version 판 소스가 이미 공개 저장소에 있어요." >&2
  exit 1
fi

# 지난 판 파일을 모두 지우고 이번 판으로 채운다(지운 파일도 반영되게)
find "$repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$root" archive HEAD | tar -x -C "$repo"
rm -rf "$repo/store" "$repo/app/debug.keystore"

# 공개본 README 머리에 안내를 붙인다
{
  printf '%s\n' \
    "> **be docs $version 공개 소스** (GPL-3.0-or-later, \`LICENSE\`). 스토어에 올리는 판마다 한 커밋으로 올린다(커밋 메시지 \"be docs <판> 소스\")." \
    "> 출시 운영 문서(\`store/\`)와 디버그 서명 키는 넣지 않았다. 디버그 빌드는 안드로이드 기본 디버그 키로 서명된다." \
    "> 빌드 전에 \`scripts/fetch-vendor.sh\`로 화면 라이브러리(\`app/src/main/assets/viewer/vendor/\`)를 받는다." \
    ""
  cat "$repo/README.md"
} > "$work/README.md"
mv "$work/README.md" "$repo/README.md"

# 공개되면 안 되는 것이 섞이지 않았는지 마지막으로 본다
if [ -e "$repo/store" ] || find "$repo" -name '*.keystore' -o -name '*.jks' -o -name 'local.properties' | grep -q .; then
  echo "공개하면 안 되는 파일이 남아 있어요." >&2
  exit 1
fi

name="${author% <*}"
email="${author##*<}"; email="${email%>}"
msg="be docs $version 소스

개발 저장소 $commit 기준. store/(출시 운영 문서)와 디버그 서명 키는 뺐다."
[ -n "${PUBLISH_TRAILERS:-}" ] && msg="$msg

$PUBLISH_TRAILERS"
git -C "$repo" add -A
git -C "$repo" -c user.name="$name" -c user.email="$email" commit -q -m "$msg"
git -C "$repo" -c user.name="$name" -c user.email="$email" tag -a "v$version" -m "be docs $version"
echo "올릴 파일 $(git -C "$repo" ls-files | wc -l)개, 태그 v$version"

if [ "${DRY_RUN:-}" = 1 ]; then
  cp -r "$repo" "${DRY_RUN_OUT:-$root/../be-docs-public}"
  echo "DRY_RUN: 올리지 않고 ${DRY_RUN_OUT:-$root/../be-docs-public}에 남겼어요."
  exit 0
fi
git -C "$repo" push -q origin HEAD:main
echo "공개 저장소에 올렸어요: $remote (be docs $version 소스)"
if git -C "$repo" push -q origin "refs/tags/v$version" 2>/dev/null; then
  echo "태그 v$version도 올렸어요."
else
  echo "태그 v$version은 올리지 못했어요(권한). 판 구분은 커밋 메시지로 된다. 필요하면 GitHub 화면 Releases에서 main에 v$version을 만든다." >&2
fi
