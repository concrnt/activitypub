#!/bin/sh
# Builds the tree that the packages install, under _packaging/stage:
#
#   concrnt-ap-bridge/            package root (= /usr/lib/concrnt-ap-bridge)
#     package.json                repo package.json with "version" set to the
#                                 release version (served by /cc-info)
#     src/ drizzle/               copied from the repo
#     node_modules/               production install with the linux x64 AND
#                                 arm64 builds of esbuild (tsx's only native
#                                 dependency), so one package fits both
#   concrnt-ap-bridge_<ver>.tar.gz  the same tree, for hosts without deb/rpm
#
# The repo's own package.json and node_modules are left untouched.
set -e

version="$1"
if [ -z "$version" ]; then
    echo "usage: $0 <version>" >&2
    exit 1
fi

stage=_packaging/stage
tree=$stage/concrnt-ap-bridge
rm -rf "$stage"
mkdir -p "$tree"

cp -R src drizzle config.example.yaml README.md pnpm-lock.yaml "$tree/"
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
' "$version" "$tree/package.json"

# pnpm settings for this tree only (not the repo): optional dependencies for
# both linux architectures
cat > "$tree/pnpm-workspace.yaml" <<'YAML'
supportedArchitectures:
  os:
    - linux
  cpu:
    - x64
    - arm64
YAML
(cd "$tree" && pnpm install --frozen-lockfile --prod)
rm "$tree/pnpm-workspace.yaml"

tar -czf "$stage/concrnt-ap-bridge_$version.tar.gz" -C "$stage" concrnt-ap-bridge
