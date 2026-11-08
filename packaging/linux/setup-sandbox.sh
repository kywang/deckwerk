#!/bin/bash
# Ubuntu/AppArmor: permit user namespaces for this exact DeckWerk executable.
set -euo pipefail
print_only=false
if [[ "${1:-}" == --print-profile ]]; then print_only=true; shift; fi
binary=$(readlink -f "${1:-$(dirname "$0")/deckwerk}")
[[ -f "$binary" && -x "$binary" ]] || { echo "Executable not found: $binary" >&2; exit 1; }
# Keep profile syntax literal; reject paths with AppArmor metacharacters.
[[ "$binary" =~ ^/[a-zA-Z0-9_./+[:space:]-]+$ && "$binary" != *$'\n'* ]] || {
  echo "Move DeckWerk to a path containing letters, numbers, spaces, / . _ + or -" >&2; exit 1;
}
name="deckwerk-local-$(printf '%s' "$binary" | cksum | cut -d' ' -f1)"
profile() {
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile %s "%s" flags=(unconfined) {\n  userns,\n}\n' "$name" "$binary"
}
if $print_only; then profile; exit 0; fi
[[ "$EUID" -eq 0 ]] || { echo "Run: sudo bash $0 '$binary'" >&2; exit 1; }
command -v apparmor_parser >/dev/null || { echo "This setup requires AppArmor (Ubuntu 23.10 or newer)." >&2; exit 1; }
profile > "/etc/apparmor.d/$name"
chmod 644 "/etc/apparmor.d/$name"
apparmor_parser -r "/etc/apparmor.d/$name"
echo "Sandbox access configured for $binary. Launch normally without --no-sandbox."
