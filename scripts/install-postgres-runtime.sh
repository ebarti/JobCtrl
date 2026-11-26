#!/usr/bin/env bash
# Build a private, relocatable PostgreSQL runtime from the pinned upstream source.
set -euo pipefail
umask 022

if [[ $# != 1 ]]; then
  echo "Usage: $0 INSTALL_ROOT" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
mkdir -p "$(dirname "$1")"
destination_parent=$(cd "$(dirname "$1")" && pwd -P)
destination="$destination_parent/$(basename "$1")"
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "PostgreSQL runtime destination already exists: $destination" >&2
  exit 1
fi

source_record=$(node - "$repo_root/packaging/distribution/components.lock.json" <<'NODE'
const { inputs } = require(process.argv[2]);
const entries = inputs.filter(input => input.id === "postgres-runtime-source");
const [input] = entries;
if (entries.length !== 1 || !/^17\.\d+$/.test(input.version)
    || input.componentId !== "postgres-runtime" || input.license !== "PostgreSQL"
    || input.archiveType !== "tar.gz" || !/^[a-f0-9]{64}$/.test(input.sha256)
    || input.url !== `https://ftp.postgresql.org/pub/source/v${input.version}/postgresql-${input.version}.tar.gz`) {
  throw new Error("Invalid PostgreSQL source lock");
}
process.stdout.write(`${input.version} ${input.sha256} ${input.url}`);
NODE
)
read -r version digest url <<<"$source_record"

work=$(mktemp -d "${TMPDIR:-/tmp}/jobctrl-pg-src.XXXXXXXX")
work=$(cd "$work" && pwd -P)
stage=
trap 'rm -rf "$work"; if [[ -n "$stage" ]]; then rm -rf "$stage"; fi' EXIT
stage=$(mktemp -d "$destination_parent/.jobctrl-postgres.XXXXXXXX")
archive="$work/postgresql-$version.tar.gz"
if [[ -n ${JOBCTRL_POSTGRES_SOURCE_ARCHIVE:-} ]]; then
  cp "$JOBCTRL_POSTGRES_SOURCE_ARCHIVE" "$archive"
else
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --output "$archive" "$url"
fi
if command -v sha256sum >/dev/null; then
  downloaded=$(sha256sum "$archive")
else
  downloaded=$(shasum -a 256 "$archive")
fi
if [[ ${downloaded%% *} != "$digest" ]]; then
  echo "PostgreSQL source SHA-256 mismatch for $version" >&2
  exit 1
fi
tar -xzf "$archive" -C "$work"
source_dir="$work/postgresql-$version"

platform=$(uname -s)
case "$platform" in
  Darwin)
    cc=/usr/bin/clang
    export MACOSX_DEPLOYMENT_TARGET=15.0
    # Use an image-relative install name for the shared client library.
    sed 's|install_name .$(libdir)/lib|install_name '\''@rpath/lib|' \
      "$source_dir/src/Makefile.shlib" > "$work/Makefile.shlib"
    mv "$work/Makefile.shlib" "$source_dir/src/Makefile.shlib"
    rpath="-Wl,-rpath,@loader_path/../lib"
    ;;
  Linux)
    cc=cc
    rpath="-Wl,-rpath,'\$\$ORIGIN/../lib',--enable-new-dtags"
    ;;
  *)
    echo "Unsupported PostgreSQL runtime build platform" >&2
    exit 1
    ;;
esac

# Build core PostgreSQL against system libraries for the private local runtime.
prefix=/opt/jobctrl/postgres
(
  cd "$source_dir" || exit 1
  unset CPPFLAGS CXXFLAGS LDFLAGS LIBS CPATH C_INCLUDE_PATH LIBRARY_PATH PKG_CONFIG_PATH
  CONFIG_SITE=/dev/null CC="$cc" CFLAGS="-O2 -g0" ./configure \
    --prefix="$prefix" --datadir="$prefix/share/postgresql" \
    --without-icu --without-readline --without-ldap --without-gssapi \
    --without-lz4 --without-zstd &&
    make -j "${JOBCTRL_POSTGRES_BUILD_JOBS:-4}" "rpath=$rpath" all &&
    make "rpath=$rpath" DESTDIR="$work/install" install-strip
) > "$work/build.log" 2>&1 || {
  tail -n 120 "$work/build.log" >&2
  exit 1
}

installed="$work/install$prefix"
runtime="$stage/runtime"
mkdir -p "$runtime/bin"
for tool in postgres initdb pg_ctl pg_isready createdb pg_dump pg_restore psql; do
  install -m 0755 "$installed/bin/$tool" "$runtime/bin/$tool"
done
mkdir "$runtime/lib"
for library in "$installed"/lib/libpq* "$installed"/lib/*.so "$installed"/lib/*.dylib; do
  [[ -f "$library" ]] || continue
  case "$(basename "$library")" in
    *.a|libecpg*|libpgtypes*) continue ;;
  esac
  if [[ -e "$runtime/lib/${library##*/}" || -L "$runtime/lib/${library##*/}" ]]; then continue; fi
  if [[ -L "$library" ]]; then
    cp -P "$library" "$runtime/lib/"
  else
    install -m 0755 "$library" "$runtime/lib/"
  fi
done
if [[ ! -f "$runtime/lib/dict_snowball.so" && ! -f "$runtime/lib/dict_snowball.dylib" ]]; then
  echo "PostgreSQL runtime is missing the required Snowball dictionary module" >&2
  exit 1
fi
cp -R "$installed/share" "$runtime/share"
install -m 0644 "$source_dir/COPYRIGHT" "$runtime/COPYRIGHT"
install -m 0644 "$source_dir/src/backend/regex/COPYRIGHT" "$runtime/COPYRIGHT.regex"
install -m 0644 "$repo_root/packaging/distribution/licenses/Snowball-BSD-3-Clause.txt" "$runtime/Snowball-BSD-3-Clause.txt"

if [[ $platform == Darwin ]]; then
  # install-strip uses a temporary basename containing a process ID. Use
  # stable ad hoc identifiers before the protected release signing stage.
  for image in "$runtime"/bin/* "$runtime"/lib/*.dylib; do
    [[ -f "$image" && ! -L "$image" ]] || continue
    if ! signature=$(/usr/bin/codesign --force --sign - --timestamp=none \
      --identifier "org.postgresql.${image##*/}" "$image" 2>&1); then
      printf '%s\n' "$signature" >&2
      exit 1
    fi
  done
fi

for tool in postgres initdb pg_ctl pg_isready createdb pg_dump pg_restore psql; do
  if [[ $("$runtime/bin/$tool" --version) != "$tool (PostgreSQL) $version" ]]; then
    echo "Could not run the relocated PostgreSQL tool $tool" >&2
    exit 1
  fi
done
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$runtime" "$destination"
