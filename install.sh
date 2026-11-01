#!/usr/bin/env bash
# 플랫폼트리 Claude 스킬 설치 (Mac)
# 사용법: 터미널에 아래 한 줄 붙여넣기
#   curl -fsSL https://raw.githubusercontent.com/codmsdncodusdn-web/platformtree-claude-skills-mac/main/install.sh | bash

set -euo pipefail
REPO="codmsdncodusdn-web/platformtree-claude-skills-mac"
SKILLS=("cut-filler")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "스킬을 내려받는 중..."
curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP"
ROOT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"

DEST="$HOME/.claude/skills"
mkdir -p "$DEST"
for s in "${SKILLS[@]}"; do
  rm -rf "$DEST/$s"
  cp -R "$ROOT/plugins/$s/skills/$s" "$DEST/$s"
  echo "[완료] $s -> $DEST/$s"
done
echo
echo 'Claude 앱을 다시 열고 영상을 넣은 뒤 "군말 잘라줘"라고 말해 보세요.'
