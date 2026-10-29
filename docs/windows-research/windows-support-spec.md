# Windows support spec

Status: assembled from the closed wayfinder tickets for [Windows support map](https://github.com/fktpp2022/pi-project-memory/issues/1). Awaiting review in [Consolidated Windows support spec review](https://github.com/fktpp2022/pi-project-memory/issues/12). Implementation is a later handoff.

Scope: make `pi-project-memory` fully usable on native Windows 10/11 (x64 and arm64) under Pi, with no regression on macOS, Linux, or Termux, and with Git Bash optional for background bash.

## 1. Supported matrix

| Axis       | Supported                                             |
| ---------- | ----------------------------------------------------- |
| OS         | Windows 10 22H2 and Windows 11                        |
| Arch       | x64 and arm64                                         |
| Node       | 22, 24, 26 (`engines.node >= 22.19.0`)                |
| Pi         | current 1.4.x                                         |
| Filesystem | local fixed NTFS, including hydrated OneDrive folders |

- arm64 has no CI runner. It is validated by `tree-sitter`/`tree-sitter-bash` prebuild availability plus a documented manual smoke test.
- Windows Server is out of scope.
- No enforced minimum Pi version. `peerDependencies` stay `*`; the declaration records "tested against Pi 1.4.x; earlier 1.x lines untested".

## 2. Install and packaging

- `package.json` `os` becomes `["darwin", "linux", "win32", "android"]`. No `cpu` field. `engines.node` unchanged.
- `tests/config.test.ts` asserts the new `os` list.
- Install paths:
  - `pi install git:...` and `pi install .` (local clone) are supported today. The git path clones and runs `npm install` inside the clone, so the root `os` field does not block it; the local path only records the path.
  - `pi install npm:pi-project-memory` becomes supported once a release carrying `win32` exists. Before that, npm-from-fork is not supported and the docs say so.
- Native binding:
  - `tree-sitter` and `tree-sitter-bash` are static imports (`src/bash-readonly.ts:1-2`).
  - A startup preflight converts `MODULE_NOT_FOUND` / `ERR_DLOPEN_FAILED` into an actionable error naming `win32-<arch>` and the supported Node lines, then fails extension load.
  - No degradation: a broken native binding is a broken install, unlike a missing Git Bash.
- Live `pi install` and extension-load smoke stay out of CI; they are part of the manual checklist.

## 3. Shell and background tools

### Detection

Probe order:

1. user `shellPath`, when set
2. `C:\Program Files\Git\bin\bash.exe`
3. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
4. `where bash.exe`

Every candidate is validated by `bash -c 'uname -s'`, which must match `MINGW*` or `MSYS*`. This rejects the legacy WSL launcher (`%SystemRoot%\System32\bash.exe`), which reports `Linux`.

- An explicit `shellPath` is authoritative. If it fails validation, bash is disabled and status names the path and reason; the probe does not silently fall through.
- Results are cached per session and re-probed at the start of each background run.
- `shellCommandPrefix` is not honored by background bash; this is documented.

### Tool set

- `createChildTools` returns `[read, write, edit, find, grep, bash]` when a validated Git Bash exists, otherwise `[read, write, edit, find, grep]`.
- No stub bash tool. The codemode allowlist derives from the same array.
- Native `read`/`find`/`grep` and the extension `read`/`write`/`edit` are unaffected; recall and `/memory` keep working.

### Prompt and codemode text

- `src/prompts.ts` and `src/child-codemode.ts` each gain a no-bash variant chosen by the same availability check.
- The variant removes the read-only-bash and `bash rm` clauses from the allowed set and states that shell access is unavailable in this run.
- `tests/fixtures/prompts/` stays word-for-word for the with-bash case. The no-bash variants are regenerated once and the changed lines are listed in this spec as the documented allowed adaptation.

### Notice and status

- One-time TUI notice per Pi session, on the first background run that would have offered bash. Not persisted across sessions, not repeated per project.
- `/memory status` reports exactly one of:
  - `Git Bash: <path>`
  - `Git Bash: not found — bash tool disabled`
  - `Git Bash: rejected (<path> is WSL)`

### Mid-session change

- Availability is re-probed per background run; the tool set and prompt are frozen for that run.
- A shell installed mid-session takes effect next run. A shell removed mid-run makes `bash` calls fail as tool errors.

## 4. Paths

### Accepted forms

| Form                | Example                                | Handling                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------ |
| Native drive        | `C:\mem\a.md`                          | canonical                                        |
| Forward-slash drive | `C:/mem/a.md`                          | canonical after separator normalization          |
| Git Bash / MSYS     | `/c/mem/a.md`, `/d/...`                | drive-letter expansion                           |
| Cygwin              | `/cygdrive/c/mem/a.md`                 | drive-letter expansion                           |
| WSL                 | `/mnt/c/mem/a.md`                      | drive-letter expansion                           |
| Home                | `~`, `~/x`, `~\x`                      | expand against the user profile, both separators |
| Extended-length     | `\\?\C:\mem\a.md`, `\\?\UNC\srv\share` | strip prefix and continue                        |
| UNC                 | `\\server\share\a.md`                  | parsed as absolute, then subject to root policy  |

Canonical output is native drive form with backslashes and on-disk casing.

Rejected with explicit hints:

- drive-relative forms (`C:foo`, `C:`)
- `%VAR%` expansion (never performed)
- any `:` in a segment after the drive prefix, including `::$DATA` (ADS guard)

### Normalization order

`normalizePathInput` performs, in order: expand `~` → strip `\\?\` / `\\?\UNC\` → expand MSYS/Cygwin/WSL prefixes → normalize separators → reject drive-relative → `resolve` against the base → reject ADS segments → containing-root `realpath`.

One helper and one containment predicate are used by `resolveToolPath`, `configuredMemoryDirectory`, `assertContainedMarkdown`, `parseDelete`, and child-tool revalidation. No call site keeps its own `~` or prefix logic.

### Containment

- `memoryDir` is canonicalized once at startup with `realpath`; that value is used everywhere, including namespace hashing and `displayPath`.
- Containment compares case-folded `path.win32` forms, then re-checks both sides with `realpath`.
- One primitive serves read, write, edit, delete, teardown, and index exclusion. `path.relative` is not a containment proxy.

### Root policy

- After `realpath`, the memory root must match `^[A-Z]:\`.
- `subst` drives pass automatically.
- Rejected at startup with `memory root is not a local fixed drive`: UNC, `\\?\UNC\`, network-mapped, removable, and unknown drive types.
- Hydrated OneDrive is supported. Dehydrated Files On-Demand placeholders are documented as unsupported.

### Case and ADS rules

- `.md` matches case-insensitively on Windows; `FOO.MD` is a valid topic.
- The index name `MEMORY.md` is compared case-insensitively.
- Scanning uses a case-insensitive pattern and dedupes by canonical path.
- Any `:` after the drive prefix is rejected.

### Budget

- The full memory path must stay within `259 − 18 = 241` characters; startup fails with the offending path otherwise.
- Generated topic filenames are capped so a full file path never exceeds 258 characters.
- Background bash refuses a run `cwd` longer than 258 characters.
- `git -C` cannot exceed the spawn limit even with `core.longpaths`; documented limitation.

### Restricted bash

- The typed command is not rewritten. Git Bash already understands `/c/...`.
- `rm` operands are normalized on a copy for validation. Accepted operand forms: drive letter, `/c/...`, `/cygdrive/c/...`, `/mnt/c/...`, `~`-relative. Genuinely relative operands are rejected.
- Normalized operands must resolve to a `.md` file inside the memory root, outside protected subdirectories.
- `rm` never executes through bash: `prepareRestrictedBash` returns `kind: "delete"` and deletion goes through `safeDeleteMemoryFile`.
- Model-authored read-only bash commands should use forward slashes or MSYS form, because Git Bash collapses unquoted backslashes. This is a docs note, not a code seam.

## 5. Storage, atomicity, and locking

### Retries

- Retry only `EPERM`, `EBUSY`, `EACCES`, for idempotent steps: publish replace, delete, and teardown.
- 5 attempts, 50/100/200/400/800 ms with jitter (~1.6 s worst case), then fail with: `<path> is open in another process — close editors, pause OneDrive sync, or retry`.
- No retry for other codes, no unbounded spin.

### Read-only targets

- A read-only attribute is treated as stale: clear it (mode `0o666`), retry, and report the cleared attribute in the tool result.
- Documented: memory files are machine-managed; a user-set read-only flag is not honored.

### Hard-link publish

- No `copyFile` fallback. `link` + `EEXIST` stays the exclusive-create primitive.
- `EPERM`/`ENOSYS`/`ENOTSUP`/`EXDEV` fail with the errno, filesystem, and path, pointing at the root policy.

### Reparse points and no-follow

- A memory root that is itself a junction or symlink is rejected at startup.
- Scanning uses `followSymbolicLinks: false` and skips reparse entries, so scan and snapshot agree.
- Direct read/write/edit/delete refuses any path with a reparse point in its ancestry, verified per file.
- `O_NOFOLLOW` is replaced by `lstat` → reject reparse → open → `realpath` containment.
- Documented limitation: check-then-open leaves a residual TOCTOU window that `O_NOFOLLOW` would close.

### Locks

- Payload records `pid`, process start-time token, and hostname.
- Creation uses `wx` and is fsync'd. Heartbeat uses `utimes` at `staleMs / 3`, bounded to 100–1000 ms.
- Staleness: `pid: 0` is dead; a start-token or hostname mismatch is dead; otherwise the mtime heartbeat decides.
- An absolute maximum lease age guarantees reclamation.
- `process.kill(pid, 0)` is a secondary signal only.

### Permissions

- `chmod` runs on POSIX only; skipped on Windows.
- "Private directory" wording is removed from Windows code paths.
- Windows privacy is the inherited user-profile ACL; no explicit ACL hardening.

## 6. Tests and CI

### Matrix

- One `windows-latest` job at Node 22, required, `fail-fast: false`. Existing `ubuntu-latest`/`macos-latest` × 22/24/26 unchanged.
- No arm64 runner.

### Prerequisites

- `.gitattributes` with `* text=auto eol=lf`, index renormalized once. No CRLF normalization inside tests.
- Install `ripgrep` and `fd` on the Windows runner.
- Assert the resolved `bash` reports `MINGW*`/`MSYS*`; fail the job otherwise.

### Skips

- POSIX-only tests skip through one `skipOnWindows(reason)` helper keyed on `process.platform`, with the reason emitted.
- The same list is reproduced in the user docs.
- `ulimit` and `xargs` blocks are gated the same way.
- No `if (win32) return` early exits.

### Teardown

- Bounded jittered retry, explicit close of watchers and children, and `chdir` out of temp directories before removal.
- Success criterion: repeated Windows runs are not flaky.

### New tests

- Cross-platform unit tests for pure path rules: forms, drive-relative rejection, ADS rejection, case-insensitive containment, `.MD`, budget arithmetic.
- `tests/windows.test.ts` (win32 only) for: Git Bash vs WSL detection, `shellPath` honoring and rejection, no-bash tool list and prompt variant, `rm` operand forms, reparse refusal, spawn-`cwd` budget, read-only recovery, retry, stale-lock takeover.
- The metadata test asserts `os` includes `win32` on every OS.

## 7. Docs and security claims

- `docs/windows.md` and `docs/windows.zh.md` are the single source: matrix, install, shell, accepted paths, root policy, budget, limitations, troubleshooting, manual checklist.
- `README.md`, `docs/configuration.md`, `docs/design-and-security.md`, `docs/development.md` keep short caveats and link to the Windows page.
- `docs/claude-code-compatibility.md` gets no Windows section; it covers behavioral parity, not platform support.
- Privacy wording everywhere becomes:

  > On POSIX, memory files and directories are created with `0600`/`0700` mode bits. On Windows those bits are cosmetic: Node cannot set owner/group/other permissions, and privacy relies on the inherited user-profile ACL. The extension does not add ACL hardening.

- Chinese docs update in the same change. `docs/development.md` gains a contributor checklist line requiring the matching `.zh.md` update.
- Troubleshooting table maps the exact emitted strings to cause and fix:

| Message                                    | Cause                                     | Fix                                                      |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| `Git Bash: not found — bash tool disabled` | no validated `bash.exe`                   | install Git for Windows, or set `shellPath`              |
| `Git Bash: rejected (<path> is WSL)`       | candidate resolves to the WSL launcher    | point `shellPath` at `C:\Program Files\Git\bin\bash.exe` |
| `<path> is open in another process`        | sharing violation                         | close the handle or pause sync; retry                    |
| memory path exceeds the budget             | long project path or agent root           | shorten the project path or agent root                   |
| `memory root is not a local fixed drive`   | UNC, mapped network, or removable root    | move the memory root to a local fixed drive              |
| native binding failed to load              | missing or ABI-mismatched prebuild        | use Node 22/24/26 and reinstall                          |
| worktree memory is separate                | Git could not resolve the common checkout | install Git, shorten the path                            |

## 8. Migration and compatibility

- macOS, Linux, and Termux behavior is unchanged except for the shared normalization helper, which must be a no-op for already-canonical POSIX paths.
- Namespace adoption: compute the canonical key; if the canonical namespace directory does not exist and the legacy-key directory does, keep using the legacy directory. No directory moves, no halfway migration.
- No Windows memory exists before this work, so Windows needs no migration.
- Existing locks and state files stay compatible; the added lock fields are optional on read and default to "unknown, fall back to heartbeat".

## 9. Acceptance criteria

### Packaging

- `npm install` of the package on Windows x64 and arm64 resolves `tree-sitter` and `tree-sitter-bash` prebuilds and exits 0.
- `os` includes `win32`; metadata test passes.
- A missing binding produces the actionable error, not a raw stack trace.

### Shell

- With Git Bash: six background tools, bash commands run, `rm` deletes memory files.
- Without Git Bash: five tools, no `bash` in the tool list, no-bash prompt variant, one notice, status `not found`.
- With `shellPath` pointing at the WSL launcher: bash disabled, status `rejected`.
- Installing Git Bash mid-session enables bash on the next background run.

### Paths

- `C:\`, `C:/`, `/c/`, `/cygdrive/c/`, `/mnt/c/`, `~`, `~\`, `\\?\` all reach the same file for read, write, edit, and `rm`.
- Case-different and junction paths are rejected or accepted consistently by one containment primitive.
- `notes.md:stream.md` is rejected; `FOO.MD` is readable and deletable.
- A 242-character memory path fails startup with the budget message.
- A UNC memory root fails startup.

### Storage

- A publish while another handle holds the file retries and then either succeeds or emits the "open in another process" message.
- A read-only `MEMORY.md` is replaced and the result reports the cleared attribute.
- A junction inside the memory tree is not scanned and cannot be written through.
- A stale lock with a recycled PID and an old heartbeat is reclaimed.

### CI

- One required `windows-latest` Node 22 job is green and stable across repeated runs.
- POSIX-only skips appear with reasons and match the documented list.

### Docs

- Every claim in the privacy wording is true on both platforms.
- `docs/windows.md` and its `.zh.md` exist and link from the four affected docs.
- The troubleshooting table's strings match the implementation verbatim.

## 10. Out of scope

- PowerShell as a background shell or a new read-only PowerShell classifier.
- Explicit ACL hardening (`icacls` or native ACL APIs).
- Windows Server.
- WSL-specific changes; WSL is Linux.
- A broad cross-platform test rewrite; POSIX-only tests may be skipped explicitly.
- arm64 CI.
- An upstream PR without an explicit user request.

## 11. Implementation tickets

One child ticket per workstream, with the matching acceptance criteria copied in:

1. Packaging and install (`os`, preflight, install docs)
2. Shell detection and missing-bash degradation
3. Path normalization, containment, and restricted-bash operands
4. Storage, retries, reparse points, and locks
5. Windows CI, `.gitattributes`, skips, and new tests
6. Docs and security-claim rewrite, including `.zh.md` parity

Plus [Fix the Windows-only dream transcript assertion](https://github.com/fktpp2022/pi-project-memory/issues/14), which is independent and can land with the CI ticket.
