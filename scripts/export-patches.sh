#!/usr/bin/env bash
# Re-export the commits made in upstream/ on top of the upstream base into
# patches/. Run after editing/adding commits inside upstream/.
#
#   scripts/export-patches.sh             # base = upstream commit pinned in HEAD
#   scripts/export-patches.sh origin/main # after rebasing upstream/ onto a new
#                                         # base: export from it AND stage it as
#                                         # the new pinned upstream commit
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -n "${1:-}" ]]; then
  base="$(git -C upstream rev-parse --verify "$1^{commit}")"
else
  base="$(git ls-tree HEAD upstream | awk '{print $3}')"
fi

if [[ -n "$(git -C upstream status --porcelain)" ]]; then
  echo "commit your changes inside upstream/ first" >&2
  exit 1
fi
if ! git -C upstream merge-base --is-ancestor "$base" HEAD; then
  echo "upstream/ HEAD is not based on ${base:0:12}" >&2
  exit 1
fi

rm -f patches/*.patch
git -C upstream format-patch --quiet --zero-commit --no-signature -N \
  "$base"..HEAD -o "$root/patches"
git add -A patches

if [[ -n "${1:-}" ]]; then
  git update-index --cacheinfo "160000,$base,upstream"
  echo "staged upstream pin -> ${base:0:12}"
fi
git status --short patches upstream
