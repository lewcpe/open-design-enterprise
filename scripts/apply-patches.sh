#!/usr/bin/env bash
# Check out the pinned upstream commit in upstream/ and apply patches/*.patch
# on top of it as commits (so they can be edited and re-exported).
#
#   scripts/apply-patches.sh          # refuses if upstream/ has local changes
#   scripts/apply-patches.sh --force  # discard local changes in upstream/
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

git submodule update --init upstream
base="$(git ls-tree HEAD upstream | awk '{print $3}')"

if [[ "${1:-}" != "--force" ]] && [[ -n "$(git -C upstream status --porcelain)" ]]; then
  echo "upstream/ has uncommitted changes; rerun with --force to discard them" >&2
  exit 1
fi

git -C upstream am --abort >/dev/null 2>&1 || true
git -C upstream checkout --quiet --force --detach "$base"
git -C upstream clean -fdq

shopt -s nullglob
patches=("$root"/patches/*.patch)
if (( ${#patches[@]} == 0 )); then
  echo "no patches to apply"
  exit 0
fi

git -C upstream \
  -c user.name="${GIT_COMMITTER_NAME:-open-design-enterprise}" \
  -c user.email="${GIT_COMMITTER_EMAIL:-patches@localhost}" \
  am --3way --keep-cr "${patches[@]}"

echo "applied ${#patches[@]} patch(es) onto upstream ${base:0:12}"
