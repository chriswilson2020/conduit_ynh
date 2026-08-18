#!/usr/bin/env bash
set -euo pipefail

# Assemble release/conduit-<version>.tar.gz containing everything the YunoHost
# install script needs, and nothing it does not. No TypeScript or Vite build
# runs on the target server: this script does all compiling here, and the
# install script only ever runs `npm ci --omit=dev` to fetch runtime deps.

VERSION="${1:?usage: make-release.sh <version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/release/conduit"

rm -rf "$ROOT/release"
mkdir -p "$STAGE"

echo "Building workspaces..."
cd "$ROOT"
npm run build

echo "Staging server..."
mkdir -p "$STAGE/server"
cp -R "$ROOT/packages/api/dist/." "$STAGE/server/"
cp -R "$ROOT/packages/shared/dist" "$STAGE/server/shared"
cp -R "$ROOT/packages/api/drizzle" "$STAGE/drizzle"

echo "Staging web assets..."
mkdir -p "$STAGE/web"
cp -R "$ROOT/packages/web/dist/." "$STAGE/web/"

# --- @conduit/shared resolution -------------------------------------------
#
# packages/api/src currently imports @conduit/shared only with `import type`,
# which verbatimModuleSyntax erases completely from the compiled output --
# building the workspace and grepping dist/*.js confirms there is today no
# "@conduit/shared" specifier left in any runtime .js file, only in the .d.ts
# files Node never loads. So, strictly, nothing needs to resolve at runtime
# right now.
#
# Relying on that is a trap, though: the moment someone imports a *value* from
# @conduit/shared (e.g. one of its zod schemas, to validate a response body
# instead of just typing it), the compiled runtime code needs the specifier to
# resolve. Dev would keep working fine (npm workspace symlink), and only the
# packaged tarball would break -- silently, with no compile-time signal that
# packaging was affected. So this script makes "@conduit/shared" resolve
# unconditionally, rather than betting on the current import shape.
#
# Approach taken: vendor the compiled shared package as a real `file:`
# dependency instead of a bare directory copy. server/shared gets its own
# package.json, and the runtime package.json points "@conduit/shared" at
# "file:./server/shared" instead of dropping it. `npm install
# --package-lock-only` resolves and records it in package-lock.json with a
# pinned integrity hash like any other dependency, and `npm ci --omit=dev`
# later installs it from that local path -- the exact same mechanism used for
# every registry dependency, just pointed at a local directory. Nothing under
# packages/api/src changes, and no source file needs to know packaging exists.
#
# Rejected:
#  - Node subpath imports ("imports": {"#shared": ...}), the plan draft's
#    proposal: it works, but rewrites three source files to say "#shared"
#    instead of "@conduit/shared" purely to satisfy a packaging step, and
#    keeps that indirection permanently for every future import of the
#    package. The file: dependency gets the same robustness with zero source
#    changes and zero new specifiers to remember.
#  - Hand-copying dist straight into node_modules/@conduit/shared: this is
#    what the plan draft's "cp -R ... server/shared" already does, just at a
#    different path, and it fails the one requirement that actually matters
#    here -- `npm ci` deletes node_modules before reinstalling, and a
#    directory that is not recorded as a dependency in package-lock.json does
#    not come back.
#  - Bundling (esbuild etc.) to inline @conduit/shared into the compiled
#    output: would work, but adds a new build tool, a bundling step, and a new
#    thing to debug, to solve the resolution of one small dependency-free
#    internal package. Not proportionate.
echo "Vendoring @conduit/shared as a file: dependency..."
node - > "$STAGE/server/shared/package.json" <<'NODE'
const fs = require("node:fs");
const shared = JSON.parse(fs.readFileSync("packages/shared/package.json", "utf8"));
process.stdout.write(
  JSON.stringify(
    {
      name: "@conduit/shared",
      version: shared.version,
      private: true,
      type: "module",
      main: "./index.js",
      types: "./index.d.ts",
      dependencies: shared.dependencies ?? {},
    },
    null,
    2,
  ) + "\n",
);
NODE

echo "Writing runtime package.json..."
node - "$VERSION" > "$STAGE/package.json" <<'NODE'
const fs = require("node:fs");
const version = process.argv[2];
const api = JSON.parse(fs.readFileSync("packages/api/package.json", "utf8"));
const deps = { ...api.dependencies };
// Point at the vendored copy staged above instead of the workspace wildcard
// version ("*") that only resolves inside this monorepo.
deps["@conduit/shared"] = "file:./server/shared";
process.stdout.write(
  JSON.stringify(
    { name: "conduit", version, private: true, type: "module", dependencies: deps },
    null,
    2,
  ) + "\n",
);
NODE

echo "Resolving lockfile..."
( cd "$STAGE" && npm install --package-lock-only --omit=dev >/dev/null )

echo "Creating tarball..."
cd "$ROOT/release"
tar czf "conduit-${VERSION}.tar.gz" conduit

# sha256sum is Linux-only, which is fine: this script is meant to run on the
# Debian build server, never on a Mac. shasum -a 256 is the macOS/BSD
# equivalent, kept here only so a stray local run does not hard-fail.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "conduit-${VERSION}.tar.gz"
else
  shasum -a 256 "conduit-${VERSION}.tar.gz"
fi
