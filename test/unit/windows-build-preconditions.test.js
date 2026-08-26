/**
 * The two host assumptions upstream's Windows build makes and a GitHub runner breaks.
 * `.bazelrc` at 7.82.1 pins bazel's shell to C:/tools/msys64, which the image does not
 * have, and `tools/bazel.bat` exits 2 before bazel starts when %TEMP% sits on a volume
 * with 8.3 short names off, which is every volume but the profile's by default.
 *
 * Hermetic: HOME and USERPROFILE point at a temp directory and the MSYS2 candidates are
 * substituted, so nothing here reads or writes a real Windows path. Windows behaviour
 * itself is not proven by this file, only the shape of what the builder emits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withEnv, withTempDir } from '../support/harness.js';

const { AgentBuilder } = await importDist('builder.js');
const { Platform } = await importDist('platform.js');

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
const withHome = (home, run) => withEnv('HOME', home, () => withEnv('USERPROFILE', home, run));

/**
 * A builder whose MSYS2 lookup is pointed at `shells` instead of C:. The real candidate
 * list is asserted separately; it cannot be exercised anywhere but a Windows host.
 */
function builderWith({ os = 'windows', sourceDir, shells }) {
	return new (class extends AgentBuilder {
		windowsShellCandidates() {
			return shells ?? super.windowsShellCandidates();
		}
	})({ platform: new Platform(os, 'x86_64'), sourceDir, outputDir: path.join(sourceDir, 'out') });
}

const bashAt = (dir) => {
	const file = path.join(dir, 'bash.exe');
	fs.writeFileSync(file, '');
	return file;
};

/**
 * The emitted spelling is posix on every host: upstream's own .bazelrc at 7.82.1 writes
 * C:/tools/msys64/usr/bin/bash.exe, and bazel reads \ in an rc file as an escape. So the
 * shell fixture is a literal Windows path rather than whatever mkdtemp handed the host.
 * Interpolating the host's own path is what let this pass on macOS while Windows failed:
 * a POSIX temp path has no backslash to convert, so the assertion agreed with a broken
 * implementation by accident.
 */
const WINDOWS_SHELL = 'C:\\msys64\\usr\\bin\\bash.exe';

test('a Windows target writes both bazel shell overrides, forward-slashed, into user.bazelrc', async () => {
	await withTempDir('win-shell-', (dir) =>
		withHome(dir, async () => {
			const build = builderWith({ sourceDir: dir });
			build.resolveWindowsShell = async () => WINDOWS_SHELL;
			await build.ensureWindowsPreconditions();

			const written = fs.readFileSync(path.join(dir, 'user.bazelrc'), 'utf8');
			assert.ok(!written.includes('\\'), written);
			assert.deepEqual(
				written.split('\n').filter((line) => line.startsWith('common:')),
				[
					'common:windows --repo_env=BAZEL_SH=C:/msys64/usr/bin/bash.exe',
					'common:windows --shell_executable=C:/msys64/usr/bin/bash.exe',
				]
			);
		})
	);
});

test('the resolver takes the first candidate that exists, not the first it is handed', async () => {
	await withTempDir('win-resolve-', (dir) =>
		withHome(dir, async () => {
			const shell = bashAt(dir);
			const build = builderWith({ sourceDir: dir, shells: ['C:\\absent\\usr\\bin\\bash.exe', shell] });

			// Compared as handed back, with no respelling: resolution is separate from how
			// writeBazelShellOverride() then spells the winner.
			assert.equal(await build.resolveWindowsShell(), shell);
		})
	);
});

test('the default candidates lead with the path the GitHub image actually uses', async () => {
	await withTempDir('win-candidates-', (dir) =>
		withEnv('SystemDrive', 'C:', () =>
			withEnv('BAZEL_SH', undefined, async () => {
				const build = builderWith({ sourceDir: dir });
				assert.deepEqual(build.windowsShellCandidates(), [
					'C:/msys64/usr/bin/bash.exe',
					'C:/tools/msys64/usr/bin/bash.exe',
				]);
			})
		)
	);
});

test('BAZEL_SH is tried before either default, since upstream already owns that name', async () => {
	await withTempDir('win-bazelsh-', (dir) =>
		withEnv('SystemDrive', 'C:', () =>
			withEnv('BAZEL_SH', 'D:/msys64/usr/bin/bash.exe', async () => {
				const build = builderWith({ sourceDir: dir });
				assert.equal(build.windowsShellCandidates()[0], 'D:/msys64/usr/bin/bash.exe');
			})
		)
	);
});

test('a Windows target points TEMP and TMP at the profile volume, which is where 8.3 is on', async () => {
	await withTempDir('win-temp-', (dir) =>
		withHome(dir, async () => {
			const build = builderWith({ sourceDir: dir, shells: [bashAt(dir)] });
			await build.ensureWindowsPreconditions();

			const expected = path.join(dir, 'AppData', 'Local', 'Temp');
			assert.ok(fs.statSync(expected).isDirectory());
			assert.equal(build.getEnvironmentVariables().TEMP, expected);
			assert.equal(build.getEnvironmentVariables().TMP, expected);
		})
	);
});

test('a non-Windows target writes no override file and exports no TEMP', async () => {
	await withTempDir('win-noop-', (dir) =>
		withHome(dir, async () => {
			const build = builderWith({ os: 'linux', sourceDir: dir, shells: [bashAt(dir)] });
			await build.ensureWindowsPreconditions();

			assert.ok(!fs.existsSync(path.join(dir, 'user.bazelrc')));
			assert.ok(!fs.existsSync(path.join(dir, 'AppData')));
			const env = build.getEnvironmentVariables();
			assert.ok(!('TEMP' in env));
			assert.ok(!('TMP' in env));
		})
	);
});

test('no MSYS2 bash anywhere fails loudly instead of writing a path that is wrong differently', async () => {
	await withTempDir('win-nobash-', (dir) =>
		withHome(dir, async () => {
			// Windows-shaped and absent on every host, so the diagnostic is checked in the
			// spelling a real Windows run would produce.
			const missing = 'C:\\nowhere\\usr\\bin\\bash.exe';
			const build = builderWith({ sourceDir: dir, shells: [missing] });

			await assert.rejects(
				() => build.ensureWindowsPreconditions(),
				(error) => {
					// Verbatim, backslashes intact: the candidate is quoted for an operator to
					// paste, and the posix respelling applies to the rc file, not to this.
					assert.ok(error.message.includes(missing), error.message);
					assert.match(error.message, /No MSYS2 bash found.+BAZEL_SH/s);
					return true;
				}
			);
			assert.ok(!fs.existsSync(path.join(dir, 'user.bazelrc')));
		})
	);
});

test('a Windows target turns off the PDB linker flag, which nothing here ships', async () => {
	await withTempDir('win-pdb-', (dir) =>
		withHome(dir, async () => {
			assert.equal(builderWith({ sourceDir: dir }).getEnvironmentVariables().DD_GO_PDB, '0');
			assert.ok(!('DD_GO_PDB' in builderWith({ os: 'linux', sourceDir: dir }).getEnvironmentVariables()));
		})
	);
});
