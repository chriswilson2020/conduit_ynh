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
# packages/api/src imports VALUES from @conduit/shared, so the specifier has to
# resolve at runtime -- `grep -c "@conduit/shared" packages/api/dist/**/*.js`
# finds it in the compiled output, most recently in dist/services/export.js,
# which imports decimalFromCents.
#
# THIS PARAGRAPH USED TO SAY THE OPPOSITE, and the day it stopped being true is
# the day this arrangement started earning its keep. It read: "packages/api/src
# currently imports @conduit/shared only with `import type`, which
# verbatimModuleSyntax erases completely from the compiled output ... So,
# strictly, nothing needs to resolve at runtime right now" -- with the next
# paragraph explaining that relying on that would be a trap, because the moment
# someone imports a value the packaged tarball breaks silently with no
# compile-time signal. That is exactly what happened, in Phase 2 and in most
# phases since; nothing broke, because this script never took the bet. The claim
# went stale years of commits ago and no symbol grep could have seen it, which
# is why it is corrected here rather than left as a curiosity.
#
# So this script makes "@conduit/shared" resolve unconditionally, rather than
# betting on any particular import shape.
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
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = { ...api.dependencies };
// Point at the vendored copy staged above instead of the workspace wildcard
// version ("*") that only resolves inside this monorepo.
deps["@conduit/shared"] = "file:./server/shared";
// Carry the monorepo root's `overrides` into the runtime package (Phase
// 4.3's deepmerge-ts pin was the first): the lockfile resolved below is a
// FRESH resolve against this generated package.json, so an override left
// behind in the monorepo root would silently not reach the tarball -- and
// the target server's `npm ci --omit=dev` installs exactly what that
// lockfile says.
const overrides = root.overrides ?? {};
process.stdout.write(
  JSON.stringify(
    {
      name: "conduit", version, private: true, type: "module", dependencies: deps,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
    null,
    2,
  ) + "\n",
);
NODE

echo "Resolving lockfile..."
( cd "$STAGE" && npm install --package-lock-only --omit=dev >/dev/null )

# The permanent form of the v0.8.0 dry-run check: every root override must be
# REALIZED in the staged lockfile. The stage resolve above is a fresh one, so
# a regression in the overrides carry-through (or an npm behavior change)
# would otherwise ship a tarball that silently drops the pin -- the exact
# near-miss that motivated carrying overrides in the first place. `semver` is
# require()d from the monorepo root's node_modules (this script already runs
# from ROOT with dependencies installed; a missing module fails loudly here,
# never silently skips). A non-string override value means someone introduced
# a nested/object override -- extend this guard rather than working around it.
echo "Checking override pins survived the stage resolve..."
node - "$STAGE/package-lock.json" <<'NODE'
const fs = require("node:fs");
const semver = require("semver");
const overrides = JSON.parse(fs.readFileSync("package.json", "utf8")).overrides ?? {};
const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const [name, range] of Object.entries(overrides)) {
  if (typeof range !== "string") {
    throw new Error(`override for ${name} is not a plain range string -- extend this guard`);
  }
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (version === undefined) {
    throw new Error(`override ${name}@${range}: package absent from the staged lockfile`);
  }
  if (!semver.satisfies(version, range)) {
    throw new Error(`override ${name}@${range}: staged lockfile resolves ${version}`);
  }
  console.log(`  ${name}@${range} -> ${version}`);
}
NODE

echo "Creating tarball..."
cd "$ROOT/release"

# A TARBALL BUILT ON A MAC MAKES GNU tar TALK, AND THIS IS WHAT IT SAYS.
#
# macOS's /usr/bin/tar is bsdtar, and it records two things GNU tar has never
# heard of: Apple extended attributes (LIBARCHIVE.xattr.com.apple.provenance,
# stamped on anything a browser or an installer touched) and BSD file flags
# (SCHILY.fflags). Debian's GNU tar answers each one with
#
#   tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'
#   tar: Ignoring unknown extended header keyword 'SCHILY.fflags'
#
# ONCE PER FILE, so an upgrade opens with a screen and a half of warnings before
# it says anything true. Measured on the deploy target during v1.4.1's upgrade,
# 4 Sep 2026: harmless -- "ignoring the KEYWORD", not the file, and the install
# that followed ran -- but it is noise in the one place an operator is watching
# for trouble, and noise is where a real warning goes to hide. This release was
# an entire evening spent on a message that blamed the wrong thing.
#
# THE HEADER OF THIS SCRIPT ALREADY SAID NOT TO DO THIS -- "meant to run on the
# Debian build server, never on a Mac" -- and v1.4.1 was built on a Mac anyway,
# which is the argument for making the script produce a clean artefact wherever
# it runs rather than for writing the instruction a second time.
#
# The flags are bsdtar's and GNU tar rejects them outright, so they are applied
# only when bsdtar is what we have. COPYFILE_DISABLE additionally stops the
# ._AppleDouble companion files, which are a different mechanism and would
# otherwise ride along as real entries rather than as headers.
tar_flags=()
if tar --version 2>/dev/null | grep -qi bsdtar; then
  tar_flags=(--no-xattrs --no-fflags --no-mac-metadata)
fi
# `-czf`, NOT the bare `czf` this line carried for four releases. tar accepts an
# undashed option bundle only as its FIRST argument; with a long option ahead of
# it, `czf` becomes an operand and tar answers "Must specify one of -c, -r, -t,
# -u, -x". Found by running it.
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -czf "conduit-${VERSION}.tar.gz" conduit

# sha256sum is Linux-only, which is fine: this script is meant to run on the
# Debian build server, never on a Mac. shasum -a 256 is the macOS/BSD
# equivalent, kept here only so a stray local run does not hard-fail.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "conduit-${VERSION}.tar.gz"
else
  shasum -a 256 "conduit-${VERSION}.tar.gz"
fi
