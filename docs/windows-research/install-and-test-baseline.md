# Windows install, load, and test baseline

Factual inventory of what the repository does from a clean checkout on native Windows (no WSL, no MSYS shell as the
test runner). No product code was changed for this investigation.

- Worktree: `D:\Projects\pi-project-memory-wt-baseline`
- Branch: `research/windows-baseline`
- Base commit: `f88a96d` (`chore(deps): update dependency @biomejs/biome to v2.6.3 (#17)`)

## Environment

| Item              | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| OS                | Microsoft Windows NT 10.0.26300.0 (Windows 11), AMD64                   |
| Shell             | PowerShell 5.1 (`pnpm` and `pi` both resolve to `.ps1` shims)           |
| Node.js           | v26.8.1                                                                 |
| pnpm              | 12.5.1 (CI pins 12.15.0)                                                |
| npm               | 11.19.0                                                                 |
| Git               | 2.55.0.windows.5                                                        |
| Pi CLI            | 1.4.0 (`~/.pi/agent/bin/pi.ps1`)                                        |
| Git line endings  | `core.autocrlf=true`, no `.gitattributes` in the repository             |
| Native build deps | none required; `tree-sitter` and `tree-sitter-bash` installed prebuilds |

`git ls-files --eol index.ts` after checkout: `i/lf w/crlf attr/`.

## Results summary

| Command                                                                                  | Exit | Observed                                                 |
| ---------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------- |
| `pnpm install`                                                                           | 0    | 220 packages, ~63 s warm store, native prebuilds loaded  |
| `pnpm install --frozen-lockfile`                                                         | 0    | lockfile up to date                                      |
| `pnpm check`                                                                             | 1    | stops at `biome check` on CRLF formatting (45 errors)    |
| `pnpm lint`                                                                              | 0    | biome lint + markdownlint clean                          |
| `pnpm format:check`                                                                      | 1    | biome format + prettier fail on CRLF (13 Markdown files) |
| `pnpm typecheck`                                                                         | 0    | clean                                                    |
| `pnpm test`                                                                              | 1    | 246 tests, 210 pass / 36 fail on a CRLF checkout         |
| `pnpm test` (LF working tree, see below)                                                 | 1    | 246 tests, 218 pass / 28 fail                            |
| `pnpm pack --dry-run`                                                                    | 0    | 29 files, `pi-project-memory-0.1.10.tgz`                 |
| `pi install .` (isolated HOME)                                                           | 0    | records absolute path in settings; no platform check     |
| `PI_OFFLINE=1 pi --no-extensions --extension ./index.ts --list-models __no_such_model__` | 0    | "No models available" (isolated HOME has no provider)    |

## `pnpm install`

Succeeded with no manual toolchain setup. `tree-sitter` and `tree-sitter-bash` ran `node-gyp-build` and picked up the
vendored `win32-x64` prebuilds (`.node` files present under `node_modules/tree-sitter*/prebuilds/win32-x64`), so MSVC
Build Tools are not needed.

```text
.../node_modules/tree-sitter install$ node-gyp-build
.../node_modules/tree-sitter install: Done
.../node_modules/tree-sitter-bash install$ node-gyp-build
.../node_modules/tree-sitter-bash install: Done
Done in 1m 2.6s using pnpm v12.5.1
```

Smoke test that the grammar actually loads:

```text
node -e "const P=require('tree-sitter');const B=require('tree-sitter-bash');const p=new P();p.setLanguage(B);console.log(p.parse('echo hi | grep h').rootNode.hasError)"
# false
```

Caveats: the local pnpm is 12.5.1 while CI pins 12.15.0; install printed a pnpm self-update notice and a
supply-chain policy verification pass, neither of which affects the result.

## `pnpm check`

`pnpm check` is `biome check . --error-on-warnings && markdownlint-cli2 "**/*.md" && prettier --check "**/*.md" &&
pnpm typecheck && pnpm test`. On a default Windows checkout it fails at the very first gate, so the later gates and the
test suite never run under `pnpm check`:

```text
.github\workflows\ci.yml format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  × Formatter would have printed the following content:
     1    │ - name:·CI␍
...
Checked 58 files in 699ms. No fixes applied.
Found 45 errors.
```

Root cause: every text file is checked out with CRLF because the repo has no `.gitattributes` and Git for Windows
defaults to `core.autocrlf=true`. Biome and Prettier are configured for LF (`"endOfLine": "lf"`). The diff in the error
output is purely `␍` characters.

Stage-by-stage on the same CRLF checkout:

- `pnpm lint` → 0 (biome lint 58 files, markdownlint 13 files, 0 issues)
- `pnpm format:check` → 1 (`Code style issues found in 13 files`, all Markdown; the other 45 files are the biome half)
- `pnpm typecheck` → 0

Re-running after converting the working tree to LF (`git config core.autocrlf false; git rm --cached -r .; git reset
--hard`) makes both `biome check . --error-on-warnings` and `prettier --check "**/*.md"` exit 0. The format failure is
therefore a repository configuration gap, not a code problem:

> A `.gitattributes` with `* text=auto eol=lf` (at minimum for `*.ts`, `*.json`, `*.yml`, `*.md`) is required before any
> Windows CI job can get past `pnpm check`.

## `pnpm test`

`node --import=tsx --test tests/*.test.ts` over 18 test files (246 tests), ~70 s.

- Default CRLF checkout: `pass 210 / fail 36`
- LF working tree: `pass 218 / fail 28`

The 8-test difference is not all CRLF. The failure set is not fully deterministic: temp-directory cleanup fails
intermittently with `EBUSY` (see below), so different tests fail on different runs. The stable CRLF-only failure is
`runtime prompts match the fixed Claude-derived fixtures after allowed substitutions` (the on-disk fixture contains
`\r\n` while the rendered prompt contains `\n`). The rest of the run-to-run delta is `EBUSY` noise.

The counts below are from the LF run (28 failures), which is the meaningful product baseline.

### Failure inventory

#### A. POSIX-only test fixtures (15 of 28)

These tests encode Unix semantics that Windows does not provide. They are not product regressions.

| Test                                                                                       | Why it cannot work on Windows                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validates printf arithmetic operands`                                                     | `xargs` is deliberately classified as not read-only on `win32` in `src/bash-readonly.ts` (line ~2405)                                                                            |
| `restricted Pi-native Bash permits outside reads and denies writes`                        | same `xargs` gate                                                                                                                                                                |
| `dream tools read original session directories and keep them read-only`                    | same `xargs` gate                                                                                                                                                                |
| `native Bash runs xargs and env commands without earlier calls`                            | same `xargs` gate                                                                                                                                                                |
| `Bash leaves grep options and xargs input expansion to the native programs`                | same `xargs` gate                                                                                                                                                                |
| `background Bash follows PATH order and relative entries`                                  | fixtures are `#!` scripts with `chmod 0777/0644`; Windows has no shebang or executable bit                                                                                       |
| `background tools use executables and their helpers from arbitrary host PATH directories`  | `execFileSync("/bin/sh", ...)` → `spawnSync /bin/sh ENOENT`                                                                                                                      |
| `linked worktrees use the common checkout as the Claude-compatible root`                   | fake `git` is a `#!` script executed through `/bin/sh`                                                                                                                           |
| `project path initialization keeps existing permissions and accepts a symlink memory root` | asserts `chmod 0777` round-trips; Windows reports `0o666` (438) for anything writable                                                                                            |
| `atomic replacement of a hard-linked entry leaves the other name unchanged`                | asserts mode `0o600` (384); Windows always reports `0o666` (438)                                                                                                                 |
| `new memory files publish exclusively with private permissions ...`                        | same mode-bit assertion                                                                                                                                                          |
| `topic scans and backfill omit unreadable files and keep valid topics`                     | relies on `chmod 000` making a file unreadable; Windows ignores it                                                                                                               |
| `topic scans return no catalog when the memory directory cannot be listed`                 | relies on `chmod 000` making a directory unlistable                                                                                                                              |
| `topic scans and backfill retain newest topics under a low file-descriptor limit`          | runs `bash -c "ulimit -n 128"`; on this host `bash` resolves to the WSL launcher and fails with a WSL NAT/localhost warning                                                      |
| `custom roots isolate state and share locks by canonical memory namespace`                 | creates a directory symlink without `{ type: "dir" }`; Node on Windows defaults to a file link, so `realpath` throws `EPERM` and the namespace hash falls back to the alias path |

Representative output:

```text
AssertionError: xargs printf '%s\n': Command is not read-only: xargs printf %s\n | false !== true
Error: spawnSync /bin/sh ENOENT
Error: spawn /bin/sh ENOENT
AssertionError: 438 !== 384
```

Security caveat: the two permission tests are POSIX assertions, but they assert a real product guarantee ("private
memory files"). On Windows `fs.chmod(path, 0o600)` cannot express that; the file inherits the parent ACL. Windows
support needs either ACL-based hardening or an explicit documented downgrade. That is a product decision, not a test
fix.

#### B. Genuine product bugs / Windows incompatibilities (7 of 28)

| Test                                                                                           | Evidence                                                                                                                        | Assessment                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory deletion parses escaped spaces, quoted concatenations, and literal special characters` | `Error: rm requires absolute, non-glob Markdown paths` at `src/restricted-bash.ts:59`                                           | `parseDelete` requires the operand to start with `/`; a real Windows memory path (`C:\Users\...`) is always rejected. Restricted Bash cannot delete memory files on Windows.                                                                              |
| `reads can follow symlinks while writes stay contained and rm needs no read baseline`          | same error from `rm --force C:\...\delete.md`                                                                                   | same defect                                                                                                                                                                                                                                               |
| `forced deletion succeeds for absent files without creating directories`                       | tool returns `bash failed: rm requires absolute, non-glob Markdown paths`                                                       | same defect                                                                                                                                                                                                                                               |
| `background writes and edits follow internal file and directory symlinks`                      | same error                                                                                                                      | same defect                                                                                                                                                                                                                                               |
| `explicit pages establish Claude-style baselines but automatic truncation revokes them`        | same error on `rm 'C:\...\large.md'`                                                                                            | same defect                                                                                                                                                                                                                                               |
| `all background tools inherit the parent cwd for both roles`                                   | expected `C:\...\Temp\pi-memory-relative-tools-...\worktree\nested`, actual `/tmp/pi-memory-relative-tools-.../worktree/nested` | The Bash tool runs through Git Bash/MSYS, so `pwd` reports an MSYS path. No translation back to the native path, so path identity differs between the Bash view and Node.                                                                                 |
| `dream reads live session transcripts without staging or pre-parsing omitted files`            | `1 !== 4` provider calls                                                                                                        | Dream consolidation stops after the first model turn. The first `read` of the live transcript does not lead to the second turn. Cause not identified in this pass; needs a focused follow-up (session snapshot/mtime or containment check under Windows). |

Representative output:

```text
AssertionError [ERR_ASSERTION]: {"content":[{"type":"text","text":"bash failed: rm requires absolute, non-glob Markdown paths"}],"isError":true}
  + actual: '/tmp/pi-memory-relative-tools-qP8ZoT/worktree/nested'
  - expected: 'C:\\Users\\Lenovo\\AppData\\Local\\Temp\\pi-memory-relative-tools-qP8ZoT\\worktree\\nested'
```

#### C. Flaky temp-directory cleanup (5–6 of 28, varies per run)

Tests fail at teardown, not in their assertions, with EBUSY while removing a temp project directory. The affected tests
change between runs (e.g. `namespace reservation rejects a pre-existing symlink`, `memory list previews ...`, one of the
`selector` subtests). This is a Windows file-locking/timing issue: something in the product or harness still holds a
handle (watcher, child process, or open log) when `rm(..., { recursive: true, force: true })` runs.

```text
[Error: EBUSY: resource busy or locked, rmdir 'C:\Users\Lenovo\AppData\Local\Temp\pi-memory-lifecycle-focused-\...\project'] { errno: -4082, code: 'EBUSY', syscall: 'rmdir' }
```

This is why the raw fail count moves between 26 and 36 across runs. CI on Windows will be flaky until teardown is made
handle-safe (retry with backoff, or explicit close of watchers/children).

#### D. CRLF-only failure (present only on the default checkout)

`runtime prompts match the fixed Claude-derived fixtures after allowed substitutions` fails because the fixture is read
from disk with CRLF and compared against `\n` text. Fixed by LF checkout (`.gitattributes`), not by code.

## `pnpm pack --dry-run`

Exit 0. 31 files: `index.ts`, `src/*.ts` (14), `docs/**` (11), `README.md`, `README.zh.md`, `LICENSE`,
`config.example.json`, `package.json`. No `tests/`, no `node_modules/`, no stray files. Pack contents are unaffected by
line endings (the tarball stores checkout bytes, but nothing in the publish path normalizes them).

## `pi install .`

Run with an isolated environment so the real agent config was never touched:

```powershell
$env:HOME = $iso; $env:USERPROFILE = $iso
$env:PI_CODING_AGENT_DIR = "$iso\.pi\agent"
$env:XDG_CONFIG_HOME = "$iso\.config"; $env:XDG_DATA_HOME = "$iso\.local\share"; $env:XDG_CACHE_HOME = "$iso\.cache"
pi install .
```

Result: exit 0, output `Installing ....` / `Installed .`. It writes only the package path to
`<iso>\.pi\agent\settings.json`:

```json
{ "packages": ["D:\\Projects\\pi-project-memory-wt-baseline"] }
```

It does not run `npm install` for a local directory, so it does not evaluate the `os` field. `pi list` then shows the
package.

Isolation check: the real `~/.pi/agent/settings.json`, `npm/package.json` and `npm/package-lock.json` kept identical
SHA-256 prefixes and pre-run mtimes (`dc6d27b4...`, `6a7a2ba1...`, `03b029d3...`) before and after all probes.

However, installing the same directory through npm — which is what a registry install (`npm:pi-memory`) does — fails
because `package.json` still declares Unix-only platforms:

```text
npm error code EBADPLATFORM
npm error notsup Unsupported platform for pi-project-memory@0.1.10: wanted {"os":"darwin,linux,android"} (current: {"os":"win32"})
```

`tests/config.test.ts` asserts that exact list (`package metadata declares the supported Unix platforms`), and
`README.md` line 22 says the extension supports macOS, Linux, and Android only. Windows support currently contradicts
the package metadata, the README, and a passing test.

## Extension load probe

```text
PI_OFFLINE=1 pi --no-extensions --extension ./index.ts --list-models __no_such_model__
```

Exit 0, output:

```text
No models available. Use /login to log into a provider via OAuth or API key. See:
  .../docs/providers.md
  .../docs/models.md
```

Limitation: an isolated HOME has no providers, so the command exits during model listing and the output does not prove
the extension was activated. As a separate check, the entry module imports cleanly under the same loader used by the
tests: `node --import=tsx -e "await import('./index.ts')"` → exit 0, default export present. Loading the extension with
a real provider would require copying credentials into the isolated HOME, which was not done.

## CI recommendation (smallest Windows matrix)

Current CI is `ubuntu-latest` + `macos-latest` × Node 22/24/26 (6 jobs), and only Ubuntu/Node 24 runs `pnpm pack
--dry-run`. Nothing exercises Windows.

Smallest effective addition:

1. **One job**: `windows-latest` × **Node 22** (the declared engine minimum), steps:
   `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm pack --dry-run`.
   Node 22 is enough: the observed failures are platform-driven, not Node-version-driven, and Node 22/24/26 coverage
   already exists on two other OSes.
2. **Prerequisites before that job can be green**:
   - Add `.gitattributes` (`* text=auto eol=lf`) — otherwise the job fails at `biome check` on CRLF.
   - Add `win32` to `package.json` `os` and update the `package metadata declares the supported Unix platforms` test;
     otherwise registry installation stays blocked.
   - Skip POSIX-only tests on `win32` (`t.skip` guards keyed on `process.platform`) and gate the `xargs` block, so the
     job reports only genuine regressions.
   - Make temp cleanup retry on `EBUSY`; otherwise the job is flaky (5–6 failures per run).
   - Install search tools on the Windows runner (`choco install ripgrep fd` or equivalent); the Linux/macOS jobs do this
     explicitly and the Windows image does not guarantee `rg`/`fd` on `PATH`. Note `bash` on the runner must be Git Bash,
     not the WSL launcher.
3. **Optional second job**: add Node 26 for the same Windows runner only if dependency ABIs prove version-sensitive.
   Not needed for the regression class observed here.
4. **arm64**: no CI needed. `tree-sitter`, `tree-sitter-bash`, `@biomejs/cli-win32-arm64`, `esbuild`, and
   `@typescript/typescript-win32-arm64` all ship `win32-arm64` artifacts and are present in the lockfile, so arm64 is a
   prebuild-availability question, not a build question. If desired, add a `workflow_dispatch`-only job on
   `windows-11-arm` running `pnpm install --frozen-lockfile && pnpm exec biome --version` plus the tree-sitter parse
   smoke, rather than adding it to every PR.

## Reproduction notes

To reproduce the two test baselines:

```powershell
git worktree add D:\tmp\baseline -b research/windows-baseline f88a96d
cd D:\tmp\baseline
pnpm install
pnpm test            # CRLF checkout: 210 pass / 36 fail
git config core.autocrlf false
git rm --cached -r . --quiet; git reset --hard --quiet
pnpm test            # LF checkout: 218 pass / 28 fail
```

`pnpm pack --dry-run` and the `pi` probes do not depend on line endings. Keep `HOME`/`USERPROFILE`/`PI_CODING_AGENT_DIR`
pointed at a throwaway directory for any `pi install` probe.

## Open questions

- Why does dream consolidation stop after one provider call on Windows? (`dream reads live session transcripts ...`)
- Should memory file privacy on Windows be expressed with ACLs or explicitly downgraded in the docs?
- Should restricted Bash accept native Windows absolute paths for `rm`, or should deletion be routed through a non-Bash
  tool on Windows?
- Is the `/tmp/...` path from the Bash tool a pi-harness mapping that the extension should translate, or should the
  extension treat the Bash view as authoritative?
