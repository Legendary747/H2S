#!/usr/bin/env bash
# Publish only the exact commit tested by the workflow. Never move an existing tag.
set -euo pipefail

cd "$(dirname "$0")/.."
version=1.4.0
tag="v$version"
notes="docs/releases/$tag.md"
assets=(h2s-monitor.user.js config.example.json "$notes")

node <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const source = fs.readFileSync('h2s-monitor.user.js', 'utf8');
assert.equal(pkg.version, '1.4.0', 'Unexpected package version');
assert.equal(lock.version, pkg.version, 'Lockfile version differs');
assert.equal(lock.packages[''].version, pkg.version, 'Root lock package version differs');
assert.equal(source.match(/^\/\/ @version\s+(\S+)$/m)?.[1], pkg.version, 'Userscript version differs');
JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
assert.ok(fs.readFileSync('docs/releases/v1.4.0.md', 'utf8').trim(), 'Release notes are empty');
NODE

if [[ "${1:-}" == --check-only ]]; then
  printf 'Release metadata is consistent for %s. No remote changes made.\n' "$tag"
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unexpected arguments.' >&2; exit 1; }
[[ "${GH_REPO:-}" == Legendary747/H2S ]] || { echo 'Unexpected release repository.' >&2; exit 1; }
[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'A full release commit SHA is required.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]] || { echo 'Checkout is not the tested release commit.' >&2; exit 1; }

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

# Listing matching refs returns an empty array for an absent tag; API failures
# still stop the script, rather than being mistaken for a missing release.
gh api "repos/$GH_REPO/git/matching-refs/tags/$tag" > "$work_dir/refs.json"
tag_count=$(jq --arg ref "refs/tags/$tag" '[.[] | select(.ref == $ref)] | length' "$work_dir/refs.json")
[[ "$tag_count" == 0 || "$tag_count" == 1 ]] || { echo 'Ambiguous release tag.' >&2; exit 1; }
if [[ "$tag_count" == 1 ]]; then
  existing_sha=$(gh api "repos/$GH_REPO/commits/$tag" --jq .sha)
  [[ "$existing_sha" == "$RELEASE_SHA" ]] || { echo 'Release tag already points to another commit; refusing to move it.' >&2; exit 1; }
fi

gh api --paginate --slurp "repos/$GH_REPO/releases?per_page=100" > "$work_dir/releases.json"
jq --arg tag "$tag" 'add | map(select(.tag_name == $tag))' "$work_dir/releases.json" > "$work_dir/matches.json"
release_count=$(jq length "$work_dir/matches.json")
[[ "$release_count" == 0 || "$release_count" == 1 ]] || { echo 'Ambiguous existing release.' >&2; exit 1; }
if [[ "$release_count" == 1 ]]; then
  # A published release must resolve through its tag. A draft may not yet have
  # a tag, in which case it must name this exact full SHA as its target.
  draft=$(jq -r '.[0].draft' "$work_dir/matches.json")
  if [[ "$tag_count" == 0 ]]; then
    [[ "$draft" == true && "$(jq -r '.[0].target_commitish' "$work_dir/matches.json")" == "$RELEASE_SHA" ]] || {
      echo 'Existing release has no verifiable matching target.' >&2; exit 1;
    }
  fi
  jq -r '.[0].body' "$work_dir/matches.json" > "$work_dir/notes.md"
  node - "$notes" "$work_dir/notes.md" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync(process.argv[2], 'utf8').trimEnd(),
  fs.readFileSync(process.argv[3], 'utf8').trimEnd(), 'Existing release notes differ; refusing to overwrite');
NODE
  # Verify existing assets byte-for-byte. Resume an interrupted draft by adding
  # missing files only; do not overwrite a published or conflicting asset.
  missing_assets=()
  for asset in "${assets[@]}"; do
    name=$(basename "$asset")
    count=$(jq --arg name "$name" '[.[0].assets[] | select(.name == $name)] | length' "$work_dir/matches.json")
    if [[ "$count" == 1 ]]; then
      gh release download "$tag" --pattern "$name" --dir "$work_dir"
      cmp --silent "$asset" "$work_dir/$name" || { echo "Existing release asset differs: $name" >&2; exit 1; }
    elif [[ "$count" == 0 && "$draft" == true ]]; then
      missing_assets+=("$asset")
    else
      echo "Missing or ambiguous published release asset: $name" >&2; exit 1
    fi
  done
  for asset in "${missing_assets[@]}"; do
    gh release upload "$tag" "$asset"
  done
  if [[ "$draft" == true ]]; then
    gh release edit "$tag" --draft=false --latest
  fi
else
  gh release create "$tag" "${assets[@]}" --target "$RELEASE_SHA" \
    --title "$tag — Configurable housing search assistance" --notes-file "$notes" --latest
fi

actual_sha=$(gh api "repos/$GH_REPO/commits/$tag" --jq .sha)
[[ "$actual_sha" == "$RELEASE_SHA" ]] || { echo 'Published tag does not match the tested commit.' >&2; exit 1; }
[[ "$(gh release view "$tag" --json isDraft --jq .isDraft)" == false ]] || { echo 'Release is still a draft.' >&2; exit 1; }
gh release view "$tag" --json url --jq .url
