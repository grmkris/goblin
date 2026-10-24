#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="$(cd "${1:?patched pinned dquickts source}" && pwd -P)"
output_dir="$root/.local/native"
mkdir -p "$output_dir"
version=$(cat "$source_dir/VERSION")
cc="${CC:-cc}"
"$cc" -O2 -funsigned-char -fwrapv -D_GNU_SOURCE "-DCONFIG_VERSION=\"$version\"" \
  "-ffile-prefix-map=$source_dir=/dquickts" "-ffile-prefix-map=$root=/goblin" "-I$source_dir" \
  "$root/vendor/dquickts/native.c" "$source_dir/quickjs.c" "$source_dir/dtoa.c" \
  "$source_dir/libregexp.c" "$source_dir/libunicode.c" "$source_dir/cutils.c" \
  -lm -lpthread -o "$output_dir/dquickts-native"
sha256sum "$output_dir/dquickts-native"
