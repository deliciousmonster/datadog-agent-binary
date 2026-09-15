#!/bin/sh
# Build a complete component tree for one published version, outside components/ so Harper never scans it
# while it is half-built. Nothing here touches the live tree.
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
T="$2"   # platform label, e.g. linux-arm64
H=/home/harperdb/harper
STAGE="$H/.staging/dab-$V"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cd "$STAGE"
npm pack "@deliciousmonster/datadog-agent-binary@$V" --loglevel=error >/dev/null
tar xzf ./*.tgz --strip-components=1
rm -f ./*.tgz

# The root package and its platform binaries. `prepare` runs here, which is why it must tolerate a missing husky.
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null

# The probe is deliberately not an optionalDependency: listed as one it would install on every matching host,
# and its eBPF objects are 42 MB that most hosts cannot load. An operator who wants runtime security asks for it.
npm install "@deliciousmonster/datadog-agent-binary-probe-$T@$V" \
	--omit=dev --no-audit --no-fund --no-save --loglevel=error >/dev/null

# system-probe refuses an asset it does not own: "has incorrect permissions: user=1000". Harper runs as root here.
chown -R 0:0 "node_modules/@deliciousmonster/datadog-agent-binary-probe-$T"

# Refuse a staged tree that is missing anything the live one needs, before it can replace the live one.
for want in package.json resources.js runtime/component.js runtime/verify.js conf.d config.yaml; do
	[ -e "$want" ] || { echo "REFUSED: staged tree has no $want"; exit 1; }
done
for want in harper-process-guard harper-binary-kit "datadog-agent-binary-$T" "datadog-agent-binary-probe-$T"; do
	[ -d "node_modules/@deliciousmonster/$want" ] || { echo "REFUSED: staged tree has no $want"; exit 1; }
done
[ -d "node_modules/@deliciousmonster/datadog-agent-binary-probe-$T/share/system-probe" ] \
	|| { echo "REFUSED: the probe package carries no eBPF objects"; exit 1; }

echo "staged $V at $STAGE"
echo "  component: $(grep -m1 '"version"' package.json | tr -d ' \t,')"
echo "  guard:     $(grep -m1 '"version"' node_modules/@deliciousmonster/harper-process-guard/package.json | tr -d ' \t,')"
echo "  kit:       $(grep -m1 '"version"' node_modules/@deliciousmonster/harper-binary-kit/package.json | tr -d ' \t,')"
echo "  probe:     $(grep -m1 '"version"' node_modules/@deliciousmonster/datadog-agent-binary-probe-$T/package.json | tr -d ' \t,') owned by $(stat -c '%U:%G' node_modules/@deliciousmonster/datadog-agent-binary-probe-$T)"
echo "  binaries:  $(ls node_modules/@deliciousmonster/datadog-agent-binary-$T/bin node_modules/@deliciousmonster/datadog-agent-binary-probe-$T/bin | tr '\n' ' ')"
