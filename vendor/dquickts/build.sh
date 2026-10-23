#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="${1:?path to patched dquickts source at f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406}"
sdk_dir="${2:?path to wasi-sdk-34.0-x86_64-linux}"
source_dir="$(cd "$source_dir" && pwd -P)"
objects_dir="$root/.local/durable-code/objects"
mkdir -p "$objects_dir"
version=$(cat "$source_dir/VERSION")
flags=(-Oz -flto -funsigned-char -fwrapv -D_GNU_SOURCE "-DCONFIG_VERSION=\"$version\"" "-I$source_dir"
  "-ffile-prefix-map=$source_dir=/dquickts" "-ffile-prefix-map=$root=/goblin")
objects=()
for name in quickjs dtoa libregexp libunicode cutils; do
  "$sdk_dir/bin/clang" "${flags[@]}" -c "$source_dir/$name.c" -o "$objects_dir/$name.o"
  objects+=("$objects_dir/$name.o")
done
exports=()
for name in init dispose eval resume snapshot snapshot_len restore status output alloc free heap_used budget remaining; do
  exports+=("-Wl,--export=dq_$name")
done
"$sdk_dir/bin/clang" "${flags[@]}" -mexec-model=reactor "$root/vendor/dquickts/driver.c" "${objects[@]}" \
  -Wl,-z,stack-size=2097152 -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432 \
  -Wl,--strip-all "${exports[@]}" -lm -lpthread -o "$root/apps/runtime/src/agent-apps/dquickts/engine.wasm"
sha256sum "$root/apps/runtime/src/agent-apps/dquickts/engine.wasm"
