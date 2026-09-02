#!/usr/bin/env bash
#
# Harper v5 integration test for @harperfast/datadog-agent-binary.
#
# Deploys this package as a Harper application and proves the documented
# consumer pattern works end to end: the agent binary is resolved from the
# installed platform package, registered in `applications.allowedSpawnCommands`,
# and spawned by a Harper resource under Harper v5's spawn enforcement.
#
# Prerequisites (the workflow provides these):
#   - npm ci && npm run build               -> dist/ present
#   - the agent built for the current platform at build/<platform>/bin/<binary>
#   - Harper installable via `npm i -g harperdb`
#
# Runnable locally too (uses a mktemp work dir when RUNNER_TEMP is unset).
set -euo pipefail

# --- configuration ----------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/test/e2e/harper-app"
WORK_DIR="${RUNNER_TEMP:-$(mktemp -d)}"

# Derive the platform name from the package itself so this isn't hard-coded.
PLATFORM="$(node -e "console.log(require('$REPO_ROOT/dist/targets.js').currentTarget().name)")"
PLATFORM_PKG="@harperfast/datadog-agent-binary-$PLATFORM"

export TC_AGREEMENT=yes
export HDB_ADMIN_USERNAME="${HDB_ADMIN_USERNAME:-HDB_ADMIN}"
export HDB_ADMIN_PASSWORD="${HDB_ADMIN_PASSWORD:-password}"
export ROOTPATH="${ROOTPATH:-$WORK_DIR/hdb}"
export DEFAULT_MODE=dev
export REPLICATION_HOSTNAME=localhost
HARPER_PORT="${HARPER_PORT:-9926}"
export HARPER_URL="http://localhost:$HARPER_PORT"

HARPER_LOG="$WORK_DIR/harper.log"
HARPER_CONFIG="$ROOTPATH/harperdb-config.yaml"
HARPER_PID=""

# --- helpers ----------------------------------------------------------------

group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
die() {
	echo "ERROR: $*" >&2
	exit 1
}

teardown() {
	local status=$?
	group "Harper config ($HARPER_CONFIG)"
	cat "$HARPER_CONFIG" 2>/dev/null || echo "(no config written)"
	endgroup
	group "Harper logs ($HARPER_LOG)"
	cat "$HARPER_LOG" 2>/dev/null || echo "(no logs captured)"
	endgroup
	harper stop >/dev/null 2>&1 || true
	[ -n "$HARPER_PID" ] && kill "$HARPER_PID" 2>/dev/null || true
	if [ -z "${RUNNER_TEMP:-}" ] && [ -d "$WORK_DIR" ]; then
		rm -rf "$WORK_DIR"
	fi
	[ "$status" -eq 0 ] && echo "Harper integration test passed." \
		|| echo "Harper integration test FAILED (exit $status)." >&2
}

# Wait until the REST endpoint answers, but bail out early if the Harper
# process dies instead of waiting out the whole timeout.
wait_for_ready() {
	local deadline=$((SECONDS + ${READY_TIMEOUT:-120}))
	while [ "$SECONDS" -lt "$deadline" ]; do
		kill -0 "$HARPER_PID" 2>/dev/null || die "Harper process exited during startup"
		if curl -fsS -u "$HDB_ADMIN_USERNAME:$HDB_ADMIN_PASSWORD" \
			-o /dev/null "$HARPER_URL/AgentVersion/" 2>/dev/null; then
			return 0
		fi
		sleep 2
	done
	die "Harper REST endpoint did not become ready within ${READY_TIMEOUT:-120}s"
}

# --- steps ------------------------------------------------------------------

prepare_packages() {
	group "Build platform package and install into the test app"
	# Package the platform-specific binary (build/<platform>/bin -> npm/<platform>).
	node "$REPO_ROOT/scripts/create-platform-packages.js"

	# Pack the main package and the platform package into tarballs.
	local main_tgz platform_tgz
	main_tgz="$WORK_DIR/$(cd "$REPO_ROOT" && npm pack --silent --pack-destination "$WORK_DIR")"
	platform_tgz="$WORK_DIR/$(cd "$REPO_ROOT/npm/$PLATFORM" && npm pack --silent --pack-destination "$WORK_DIR")"

	# Pre-populate the app's node_modules with BOTH packages. The platform
	# package is normally an optionalDependency resolved from the registry; it
	# isn't published yet, so we install it explicitly. With node_modules
	# present, Harper skips its own dependency install.
	(cd "$APP_DIR" && npm install --no-save --no-package-lock "$main_tgz" "$platform_tgz")
	endgroup
}

configure_harper() {
	group "Resolve binary path and write Harper config"
	# Ask the platform package where the binary is — the same contract
	# BinaryManager uses at runtime.
	local binary_path
	binary_path="$(cd "$APP_DIR" && node -e "console.log(require('$PLATFORM_PKG').getBinaryPath())")"
	echo "Resolved agent binary: $binary_path"
	[ -x "$binary_path" ] || die "agent binary missing or not executable: $binary_path"

	mkdir -p "$ROOTPATH"
	# Fresh global config; Harper fills defaults for omitted keys.
	cat >"$HARPER_CONFIG" <<-EOF
		http:
		  port: $HARPER_PORT
		logging:
		  level: warn
		applications:
		  allowedSpawnCommands:
		    - $binary_path
	EOF
	echo "Wrote $HARPER_CONFIG"
	endgroup
}

start_harper() {
	group "Install and boot Harper"
	npm install -g harperdb
	harper version
	# `harper run` executes the app directory in the foreground; background it
	# so we can poll for readiness while capturing logs.
	harper run "$APP_DIR" >"$HARPER_LOG" 2>&1 &
	HARPER_PID=$!
	echo "Harper PID: $HARPER_PID"
	endgroup

	group "Wait for Harper to be ready"
	wait_for_ready
	echo "Harper is ready."
	endgroup
}

assert_agent_runs() {
	group "Assert the agent runs under Harper"
	node "$REPO_ROOT/test/e2e/harper-integration-assert.mjs"
	endgroup
}

# --- main -------------------------------------------------------------------

main() {
	[ -d "$REPO_ROOT/dist" ] || die "dist/ not found — run 'npm run build' first"
	trap teardown EXIT
	prepare_packages
	configure_harper
	start_harper
	assert_agent_runs
}

main "$@"
