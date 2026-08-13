# CLAUDE.md

Context for working in this repo. Read before changing anything under `src/`, `scripts/`, or `.github/workflows/`.

## What this package is

An npm package that ships two pre-compiled Datadog binaries as platform-specific sub-packages, so they can be installed and versioned as ordinary Node dependencies and spawned from inside a Harper v5 component.

| Binary | Role |
|---|---|
| `datadog-agent` | Core agent. Metrics, checks, log forwarding, DogStatsD. |
| `trace-agent` | APM receiver. Binds `127.0.0.1:8126` and accepts spans from `dd-trace`. |

## The defect this exists to fix

Earlier releases shipped the **core agent alone**. Nothing bound 8126, so `dd-trace` connected, got `ECONNREFUSED`, and dropped every span. The application logged nothing for ~18 seconds and never crashed, which is why months of app-level config work found nothing.

Proven from the published artifact, not inferred:

```bash
strings -a package/bin/datadog-agent | grep -c 'datadog-agent/pkg/trace/api\.'   # 0
```

A core agent built from the same commit still has zero receiver symbols. Shipping one binary drops spans by construction.

**Consequences for anyone editing here:** the trace-agent is not optional and not a nice-to-have. If a change makes it possible to build, package, or publish without it, that change is wrong. The descriptor model, the `--local` matrix gate, and the CI symbol assertion all exist for that single reason.

## Architecture

Everything is driven by `AgentBinaryDescriptor` (`src/types.ts`) and `Platform.getBinaries()` (`src/platform.ts`). Build, packaging, resolution, and spawning all iterate that list. Adding a future sub-agent should be a new entry, not a change to five call sites.

```
.datadog-agent-version      single pin for the upstream Datadog release
src/downloader.ts           resolves + asserts the pin, clones, verifies git describe
src/builders/               runs `dda inv <task>` per descriptor, copies each binary out
scripts/create-platform-packages.js
                            builds npm/<platform>/ with both binaries + accessors
scripts/publish-matrix.js   verifies the matrix, staged or published
src/binary-manager.ts       resolves a binary from the platform package at runtime
src/agent-launcher.ts       shared launcher behind bin/datadog-agent and bin/trace-agent
example/                    Harper component showing the correct spawn pattern
```

## Constraints that will bite you

Each of these caused a real defect. None is obvious from the code alone.

**Harper's spawn gate does not apply to this package's launchers.** Harper substitutes a constrained `child_process` only for modules its own loader evaluates, and only on the ESM path; its CJS bridge forwards builtin specifiers to the real `require`. `dist/` is CommonJS, so `spawn(..., {name})` from a launcher hits stock Node, which ignores `name`. No PID lock, no allowlist. Component code that needs the singleton must spawn from its own module graph via a **relative ESM import** — see `example/dd-supervisor.js`.

**Harper dedupes by PID-file lock**, `openSync(<rootPath>/pids/<name>.pid, 'wx')`. Filesystem-based, so it dedupes across worker threads and processes. Two distinct spawn names give one core agent and one trace-agent per node. Losers of the race get a handle with `pid`/`kill`/`unref`/`'exit'` and **no `stdout`** — unguarded `child.stdout.on(...)` throws there.

**The spawn `version` option must be a number.** Harper parses the recorded value with `parseInt`; a string never equals itself, so every thread kills and respawns forever.

**`dd-trace` needs both preload keys.** `threads.preloadRequire: dd-trace/init` is mandatory (`register.js` under `--import` initializes nothing in a worker), and `threads.preload: dd-trace/register.js` is also required or `node:http` is not instrumented.

**`os`/`cpu` must be Node's values** (`darwin`/`x64`), not this project's internal names (`macos`/`x86_64`). npm compares them to `process.platform`/`process.arch`. A mismatch means the package never installs, and because the dependency is optional, npm skips it silently and `npm ci` still exits 0.

**`SUPPORTED_PLATFORMS`, `optionalDependencies`, and the `build-release.yml` matrix must agree.** A platform declared but never built is silently unresolvable at install time.

**The trace-agent needs an existing `datadog.yaml`** (0 bytes is fine) and a writable config dir, or it dies fatally or hangs 30s. The deploy target runs non-root, so every Datadog default path must be relocated.

**Version pinning.** The npm version and the bundled agent version are independent. A package published as `7.75.5` once contained agent `7.79.2`, and `7.75.5` is not even a real upstream tag. `.datadog-agent-version` is the single pin; `resolveVersion()` asserts the tag exists before cloning and that `git describe` matches after.

## Conventions

- **Tabs**, double quotes, semicolons. Prettier runs on commit via lint-staged.
- TypeScript compiles to CommonJS. Imports use `.js` extensions (`from "./platform.js"`).
- Do not rename exports or change signatures without checking `scripts/` and `test/` — several read them by name.

### Comments

Explain **why**, never what. The bar: would a competent engineer be surprised, or make the wrong change, without this? If not, delete it.

Keep: non-obvious choices where the obvious one is wrong, real upstream constraints (a Datadog build tag, a Harper API, an npm rule), silent-failure warnings.

Cut: restatements of the code, section-divider banners, narration, explanations of standard library behaviour, doc comments that only repeat the function name.

Avoid these tells: em dashes, rule-of-three lists, "Note that", "It's worth noting", "Importantly", "Simply", "This is because", trailing clauses spelling out an obvious consequence, comments longer than the code they describe.

## Commands

```bash
npm run build          # tsc
npm run typecheck      # tsc --noEmit
npm test               # unit + e2e, hermetic, no network or agent binary
npm run test:integration   # boots real Harper 5.2.1 (needs Node >=22.18)
npm run lint:check     # prettier
npm run matrix         # what is published per platform, and whether it is correct
npm run matrix:local   # same, against staged npm/ dirs
npm run build-agent    # build both binaries for this platform (needs Go, Python, dda)
```

`npm test` must stay hermetic. Anything needing a real binary or a real Harper belongs in `test/integration/` and must **skip** with a reason, not fail, when prerequisites are absent.

## CI

| Workflow | Trigger | Purpose |
|---|---|---|
| `test.yml` | every push, every PR | lint, typecheck, unit/e2e on 6 legs; real-Harper integration on ubuntu |
| `build-verify.yml` | push to main, nightly | builds both binaries and asserts the receiver works, without publishing |
| `build-release.yml` | `v*` tags | build, gate, publish, verify |
| `matrix-drift.yml` | weekly | registry vs declared |
| `check-upstream.yml` | disabled | do not re-enable without making it write `.datadog-agent-version` |

The pre-publish matrix gate runs **before** `npm publish` because that is the last moment anything can change: a published version can be deprecated but never replaced. Platform packages publish before the main package, or its `optionalDependencies` briefly point at nothing.

## Working style

**Verify, do not assert.** This codebase punished assumption repeatedly. `package-lock.json` records what one machine resolved once; query the registry. Upstream behaviour changes between tags; read the pinned tag, not `main`. A test that passes may be passing because enforcement is absent.

**Prefer negative assertions.** "Spawn without a name throws" proves the runtime enforces. "Spawn with a name works" passes on a runtime with no enforcement at all.

**Report failures plainly**, including your own. State what was observed, what was inferred, and what remains unproven. Partial results labelled honestly beat confident summaries.

**Do not push or open PRs unless asked.** Commit locally by default.

## Skills

- `jaxontalk` — applies to all prose, including comments, commit messages, and READMEs. No em dashes, no rule-of-three, no reader-validation, lead with the claim.
- `status` — one-line-per-agent table when asked for status.
- `code-review`, `simplify` — useful before a release tag.
