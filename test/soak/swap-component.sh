#!/bin/sh
# Replace the live component with an already-staged and already-checked tree. Reversible: the old one is parked
# under .backups/, which sits outside components/ because Harper loads anything it finds in there as a component.
#
# Run inside the container, as root. Harper installs a component by extracting the package into
# components/<name>/ and installing its dependencies there, so this does exactly that and nothing
# clever: the soak has to exercise the install a customer gets, not a tree assembled by hand.
#
# Two things this caught on 2026-09-15, both of which a hand-copied tree hides:
#   - `prepare` was `husky`, a devDependency, so `npm install` in the extracted package exited 127.
#     Fixed in 7.82.1-next.14; a release before that cannot be installed this way at all.
#   - the probe package is not an optionalDependency, by design, so a plain install leaves
#     system-probe and security-agent with no binaries. It is asked for explicitly below.
#
set -e
V="$1"
H=/home/harperdb/harper
STAGE="$H/.staging/dab-$V"
LIVE="$H/components/datadog-agent-binary"

[ -d "$STAGE" ] || { echo "REFUSED: nothing staged at $STAGE"; exit 1; }
OLD=$(grep -m1 '"version"' "$LIVE/package.json" | sed 's/.*: *"//; s/".*//')
PARK="$H/.backups/datadog-agent-binary-$OLD-replaced-by-$V"
rm -rf "$PARK"
mv "$LIVE" "$PARK"
mv "$STAGE" "$LIVE"
echo "  live tree is now $V; $OLD parked at $PARK"
