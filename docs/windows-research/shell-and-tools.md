# Windows shell and background tool contract (Pi 1.4.0)

> Research ticket: [#2, "Windows shell and background tool contract"](https://github.com/fktpp2022/pi-project-memory/issues/2).
> Date: 2026-10-29.
> Scope: Pi 1.4.0 running as a native Windows process, and the six background tools created by `src/child-tools.ts`.
> Out of scope: implementation changes, and Pi running inside WSL (Linux host).

**Citation key.** `PKG/...` is the installed Pi 1.4.0 package at
`C:\Users\Lenovo\.pi\agent\install\releases\1.4.0\node_modules\@earendil-works\pi-coding-agent\`.
`REPO/...` is this worktree. `PROBE n` refers to the commands and outputs in
[Appendix A](#appendix-a-probes). File citations are `path:line` or `path:line-range`.

## 1. Environment and method

| Item                  | Value                                      | Source                                                                        |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Pi                    | 1.4.0                                      | `pi --version` (PROBE 1)                                                      |
| OS                    | Windows 11 Pro, `10.0.26300`, 64-bit AMD64 | `[System.Environment]::OSVersion.VersionString`; `Get-ComputerInfo` (PROBE 1) |
| Node.js               | `v26.8.1`                                  | `node --version` (PROBE 1)                                                    |
| Windows PowerShell    | `5.1.26100.9711`                           | `$PSVersionTable.PSVersion` (PROBE 1)                                         |
| PowerShell 7 (`pwsh`) | `7.6.9`                                    | PowerShell tool probe (PROBE 2)                                               |
| Git for Windows       | `2.55.0.windows.5`                         | `git --version` (PROBE 1)                                                     |
| Git Bash              | `5.3.15(2)-release (x86_64-pc-cygwin)`     | `bash --version` (PROBE 1)                                                    |
| `fd`                  | `10.5.0`                                   | `fd --version` (PROBE 1)                                                      |
| `rg`                  | `15.2.0`                                   | `rg --version` (PROBE 1)                                                      |

`where.exe bash.exe` returns, in order, `C:\Windows\System32\bash.exe`,
`C:\Users\Lenovo\AppData\Local\Microsoft\WindowsApps\bash.exe`, and two Hermes Git
installations (PROBE 1). Despite that, `getShellConfig()` resolves to
`C:\Program Files\Git\bin\bash.exe` with `args: ["-c"]`, because the known Git Bash
location is checked before `PATH` (`PKG/dist/utils/shell.js:84-103`; PROBE 2). "Bash is on
`PATH`" is therefore not the same fact as "Git Bash is installed".

Method: I read the installed `dist` source and the packaged `docs`, then imported the dist
modules into Node and exercised the real tool factories and resolvers. The worktree has no
`node_modules`, so repository-level child-tool execution was not possible; repository
behavior below comes from source plus a `node:path` probe. No probe wrote to the real
`~/.pi`; the read/find/grep probes only read existing files (PROBE 3, PROBE 4).

## 2. How Pi 1.4 resolves and invokes Bash

### 2.1 Resolution order

`getShellConfig(customShellPath)` on `win32` resolves in this order
(`PKG/dist/utils/shell.js:76-119`; documented in `PKG/docs/windows.md:19-24`):

1. `shellPath`, if supplied and the file exists. A supplied path that does not exist
   throws `Custom shell path not found: <path>` (`PKG/dist/utils/shell.js:77-83`).
2. `%ProgramFiles%\Git\bin\bash.exe` (`PKG/dist/utils/shell.js:87-90`).
3. `%ProgramFiles(x86)%\Git\bin\bash.exe` (`PKG/dist/utils/shell.js:91-94`).
4. `where bash.exe`, using only the **first** line of output, then checking the file
   exists (`PKG/dist/utils/shell.js:33-52,100-104`). This is the Cygwin/MSYS2/WSL
   fallback (`PKG/docs/windows.md:24`).
5. Otherwise throw the "No bash shell found" error with the searched Git Bash paths
   (`PKG/dist/utils/shell.js:105-109`).

The existence check is `accessSync(path, F_OK)` rather than `existsSync`, deliberately to
accept Windows Store aliases (reparse points) that `existsSync`'s extra `stat` can reject
(`PKG/dist/utils/shell.js:20-32`).

### 2.2 The legacy WSL exception

`getBashShellConfig` treats an exact legacy WSL launcher path as a special case: if the
path is `%SystemRoot%\System32\bash.exe` or `%SystemRoot%\Sysnative\bash.exe` (or the
conventional `C:\Windows\...` form when `SystemRoot` is unknown), it returns
`args: ["-s"]` and `commandTransport: "stdin"`; every other shell gets `args: ["-c"]`
(`PKG/dist/utils/shell.js:6-19`). The documented reason is to avoid command-line quoting
problems with that launcher (`PKG/docs/windows.md:63`).

Consequences:

- A Store alias such as `...\WindowsApps\bash.exe` is **not** the legacy path, so it is
  treated as an ordinary Bash and invoked with `-c` (`PKG/dist/utils/shell.js:6-19`).
- If Git Bash is missing but `C:\Windows\System32\bash.exe` is on `PATH`, resolution
  succeeds and switches to stdin transport (PROBE 5). Whether commands actually work then
  depends on the WSL distribution being installed and usable; resolution alone does not
  prove that.

### 2.3 Spawn contract

For the normal `-c` case, the built-in Bash tool spawns:

```text
<bash> -c <command>
```

with `cwd` set to the session/tool cwd, `detached: false` on `win32`, `windowsHide: true`,
stdin ignored, and stdout/stderr piped (`PKG/dist/core/tools/bash.js:62-69`). For the
legacy WSL case it spawns `<bash> -s`, opens stdin, and writes the command to stdin
(`PKG/dist/core/tools/bash.js:62-73`).

Other details:

- The cwd must exist before spawn, or the tool throws
  `Working directory does not exist: ...` (`PKG/dist/core/tools/bash.js:56-61`).
- The environment is `getShellEnv()` unless the caller supplies one. It prepends the Pi
  managed-bin directory (`~/.pi/agent/bin`) to `PATH`, so `rg` and `fd` are available to
  Bash even when they are not on the user's `PATH` (`PKG/dist/utils/shell.js:147-158`;
  `PKG/dist/config.js:518-521`).
- A non-zero exit code is a normal result, not a thrown error; timeout and abort are the
  thrown cases (`PKG/dist/core/tools/bash.js:103-113`).
- The tool's output is truncated to the last 2000 lines or 50 KB, and full output is
  saved to a temp file when truncated (`PKG/dist/core/tools/bash.js:166`;
  `PKG/dist/core/tools/truncate.js:10-12`).

A live probe from a temporary cwd showed `$0=/usr/bin/bash`, `pwd` as `/tmp/opencode`,
and all of `D:/...`, `D:\...`, and `/d/...` readable from Git Bash (PROBE 2).

### 2.4 Extension-created Bash tools do not inherit shell settings

The six background tools are built by `createChildTools` (`REPO/src/child-tools.ts:170`).
Its Bash tool is:

```ts
const nativeBashShape = createBashTool(env.cwd, { exposeSessionEnvironment: false });
```

and later `createBashTool(prepared.cwd, prepared.options)` with
`prepared.options = { exposeSessionEnvironment: false }`
(`REPO/src/child-tools.ts:372,415`; `REPO/src/restricted-bash.ts:80-85`). No `shellPath`
or `commandPrefix` is passed.

`createBashTool` forwards only its own `options.shellPath` to `getShellConfig`, and only
its own `options.commandPrefix` as the prefix (`PKG/dist/core/tools/bash.js:158-161,173`).
For these shell settings, Pi itself reads the user's settings only when it builds the
built-in tool definitions and when it executes `!` commands
(`PKG/dist/core/agent-session.js:2963-2975,3158-3166`). The
documentation states the same boundary for extensions: `shellCommandPrefix` configures
Pi's built-in Bash execution, and an extension that provides its own shell operations
controls its own setup (`PKG/docs/shell-aliases.md:81-83`).

Therefore, on Windows:

- A user `shellPath` that points at Cygwin/MSYS2 Bash **works** for the built-in `bash`
  tool and `!`, but **does not** affect the background `bash` tool.
- A user `shellCommandPrefix` likewise does not apply to background Bash.
- The background Bash tool always uses the default resolver: Git Bash known locations,
  then `where bash.exe`.

### 2.5 Missing Bash and misconfigured `shellPath`

Resolution happens inside `exec`, not when the tool object is created
(`PKG/dist/core/tools/bash.js:55`). With the default tool selection, Pi therefore starts
normally, advertises `bash`, and only fails when Bash is actually invoked.

| Situation                                                         | Observed behavior                                                                                                  | Source                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| No Bash found (empty `PATH`, fake `ProgramFiles`)                 | Throws `No bash shell found. Options: ... Searched Git Bash in: ...` listing the two Git Bash paths                | `PKG/dist/utils/shell.js:105-109`; PROBE 5      |
| `shellPath` points to a missing file                              | Throws `Custom shell path not found: C:\definitely-not-here\bash.exe`                                              | `PKG/dist/utils/shell.js:78-83`; PROBE 2        |
| `shellPath` points to a directory                                 | Throws `spawn C:\Windows ENOENT`                                                                                   | PROBE 6                                         |
| `shellPath` points to a non-Bash executable                       | **No validation**: `cmd.exe` was spawned with `-c`; it printed its banner and exited 0 without running the command | `PKG/dist/utils/shell.js:17-19`; PROBE 6        |
| Git Bash absent, `System32\bash.exe` on `PATH`                    | Resolves to `{"shell":"C:\\Windows\\System32\\bash.exe","args":["-s"],"commandTransport":"stdin"}`                 | `PKG/dist/utils/shell.js:6-19,100-104`; PROBE 5 |
| `shellPath` points to a WSL launcher not at the exact legacy path | Treated as ordinary Bash and invoked with `-c`                                                                     | `PKG/dist/utils/shell.js:6-19`                  |

The last three rows matter for support: "Bash resolved" does not mean "Git Bash resolved",
and `shellPath` is not checked for being Bash at all.

## 3. The optional `powershell` tool

The `powershell` tool is a second shell tool with the same command/timeout schema and the
same output/truncation backend as `bash`; only its name, label, prompt, temp-file prefix,
and shell resolver differ (`PKG/dist/core/tools/powershell.js:15-28`;
`PKG/dist/core/tools/bash.js:28-31,158-171`).

Resolution order (`PKG/dist/utils/shell.js:121-145`; documented in
`PKG/docs/windows.md:38-43`):

1. `pwsh.exe` on `PATH`.
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`.
3. `powershell.exe` on `PATH`.
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.

It is started with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
(`PKG/dist/utils/shell.js:121`; `PKG/docs/windows.md:36`). Before every command it prepends
a UTF-8 console setup line:
`try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}`
(`PKG/dist/core/tools/powershell.js:4,9-13`). On this host it resolved to the WindowsApps
`pwsh.exe`, reported `7.6.9`, kept the Windows cwd, and preserved `héllo-✓` (PROBE 2).

Availability and selection:

- It is **not** one of the default tools; `DEFAULT_TOOL_NAMES` is
  `["read","bash","edit","write"]` (`PKG/dist/core/settings-manager.js:35`).
- It can be enabled with `defaultTools`/`--tools`, for example
  `["-bash","+powershell"]` (`PKG/docs/windows.md:45-55`; `PKG/docs/settings.md:42-60`).
- It is only available when Pi runs as a native Windows process; `getPowerShellConfig`
  throws `The powershell tool is only available on Windows.` on other platforms
  (`PKG/dist/utils/shell.js:123-126`; `PKG/docs/windows.md:55`).
- `!` and `!!` continue to use Bash even when the model-facing `bash` tool has been
  replaced by `powershell` (`PKG/docs/windows.md:55`).
- It has no effect on the extension's six background tools. The extension never creates or
  selects it (`REPO/src/child-tools.ts:6-16,439`), and `defaultTools`/`--tools` do not
  change tools passed explicitly to the child model (`REPO/src/models.ts:570-596,629`).

## 4. Native `read`, `find`, and `grep` on Windows

None of these three tools invokes Bash. `read` uses Node's filesystem API; `find` spawns
`fd`; `grep` spawns `rg` (`PKG/dist/core/tools/read.js:30-31,59-77`;
`PKG/dist/core/tools/find.js:119-161`; `PKG/dist/core/tools/grep.js:52-103`). They are
therefore independent of Git Bash, `shellPath`, and `shellCommandPrefix`.

### 4.1 `read`

- Path resolution is JavaScript, not a shell: `resolveReadPathAsync` calls
  `resolvePath` with Unicode-space normalization and `@` stripping
  (`PKG/dist/core/tools/read.js:73`; `PKG/dist/core/tools/path-utils.js:42-43`).
- On Windows, before resolving, `normalizeWindowsShellPath` converts `/c/...`,
  `/mnt/c/...`, and `/cygdrive/c/...` into `C:\...`; it also expands `~`, `~/`, and
  (on Windows) `~\` (`PKG/dist/utils/paths.js:49-86`).
- Text is decoded as UTF-8 (`buffer.toString("utf-8")`), and images are handled as
  attachments (`PKG/dist/core/tools/read.js:85-113`).
- Output is truncated to 2000 lines or 50 KB, with `offset`/`limit` available
  (`PKG/dist/core/tools/read.js:53,111-129`; `PKG/dist/core/tools/truncate.js:10-12`).

Probe: `read` accepted `D:\...`, `D:/...`, `/d/...`, and `/mnt/d/...` for the same file
(PROBE 3). A missing file throws an `ENOENT` access error (PROBE 4).

### 4.2 `find`

- `find` resolves the search directory with the same native path resolver
  (`PKG/dist/core/tools/find.js:65`), then spawns `fd` with
  `--glob --color=never --hidden`, adds `--max-results`, and adds `--full-path` when the
  pattern contains `/` (`PKG/dist/core/tools/find.js:119-160`).
- It detects a `.git` directory by walking upward; outside a Git repo it adds
  `--no-require-git` so `.gitignore` still applies (`PKG/dist/core/tools/find.js:129-145`).
- On Windows, path-containing patterns have their `/` replaced with `[/\\]` so fd can
  match native separators (`PKG/dist/core/tools/find.js:147-158`).
- Results are returned relative to the search directory with `/` separators
  (`PKG/dist/core/tools/find.js:13-14,204-210`).
- The default limit is 1000 results, and output is truncated at 50 KB
  (`PKG/dist/core/tools/find.js:28,39,146`; `PKG/dist/core/tools/truncate.js:11`).
- A non-zero `fd` exit is tolerated if it produced output; it is an error only when there
  is no output (`PKG/dist/core/tools/find.js:189-196`).

Probe: `find` accepted a Windows path, a forward-slash path, and `/c/...`; output used
`/` separators; a missing search path threw `[fd error]: Search path ... is not a
directory` (PROBE 4).

One observed quirk on this host: path-containing globs such as `src/**/*.ts` returned
`No files found matching pattern`, although the files exist. `src/*.ts`, `src/**`,
`**/*.ts`, and `*.ts` all returned results (PROBE 7). This is a `find`/`fd` behavior, not a
Bash or permission problem; it is safer for prompts to prefer `path` plus a basename glob,
or `**/*.ts`, than a multi-segment pattern.

### 4.3 `grep`

- `grep` resolves the search directory natively, then spawns `rg` with
  `--no-config --json --line-number --color=never --hidden`, optionally adding
  `--ignore-case`, `--fixed-strings`, and `--glob`, followed by `-- <pattern> <path>`
  (`PKG/dist/core/tools/grep.js:52-103`).
- `.gitignore` is respected (the tool description says so, and `rg` is run without a
  no-ignore flag); hidden files are included (`PKG/dist/core/tools/grep.js:21,34,93-102`).
- The default limit is 100 matches; long lines are truncated to 500 characters; output is
  truncated at 50 KB (`PKG/dist/core/tools/grep.js:18,24,34`;
  `PKG/dist/core/tools/truncate.js:11-12`).
- For a directory search, result paths are relative to the search directory with `/`
  separators; for a single-file search, the basename is used
  (`PKG/dist/core/tools/grep.js:69-76`).
- `rg` exit 0 (matches) and 1 (no matches) are accepted. Any other exit code rejects the
  **entire** call with the stderr text (`PKG/dist/core/tools/grep.js:182-191`).
- A missing search path produces `Path not found: <path>`
  (`PKG/dist/core/tools/grep.js:59-66`).

Probe: `grep` accepted a Windows path and `/c/...`, returned relative `/` paths, and
returned `No matches found` for a single file with no match (PROBE 4). A search over a
directory containing an access-denied entry made `rg` exit 2 with `os error 5`; the tool
rejected the whole call rather than returning the other matches (PROBE 4). This is a real
Windows ACL/reparse-point failure mode, whereas `find` tolerates a non-zero `fd` exit when
it still has output (`PKG/dist/core/tools/find.js:189-196`).

### 4.4 `fd`/`rg` discovery and offline behavior

`getToolPath` checks the Pi managed-bin directory first
(`~/.pi/agent/bin/<binary>.exe`), then probes `PATH` by running `<name> --version`, and
returns null if neither works (`PKG/dist/utils/tools-manager.js:64-93`). `ensureTool`
then downloads the binary from GitHub if it is still missing (`PKG/dist/utils/tools-manager.js:301-326`).
`PI_OFFLINE` disables that download and makes the tool return undefined
(`PKG/dist/utils/tools-manager.js:309-311`; `PKG/docs/environment-variables.md:81`), after
which `find`/`grep` throw their "not available and could not be downloaded" errors
(`PKG/dist/core/tools/find.js:124-126`; `PKG/dist/core/tools/grep.js:52-55`).

On this host `getToolPath("fd")` returned the managed
`C:\Users\Lenovo\.pi\agent\bin\fd.exe`, while `getToolPath("rg")` returned the bare name
`rg` because it is already on `PATH` (PROBE 4). With an empty managed-bin directory,
`PATH=C:\Windows\System32`, and `PI_OFFLINE=1`, the exact errors were
`ripgrep (rg) is not available and could not be downloaded` and
`fd is not available and could not be downloaded` (PROBE 8).

This means `read`/`write`/`edit` can work offline with no external binaries, but
`find`/`grep` cannot.

## 5. Path normalization: native tools versus the extension

Pi's native resolver converts MSYS/WSL drive paths on Windows
(`PKG/dist/utils/paths.js:49-86`), but the repository has its own `resolveToolPath`
(`REPO/src/paths.ts:16-23`). The two differ:

| Input                       | Native `read`/`find`/`grep` | `REPO/src/paths.ts` used by child `read`/`write`/`edit`/`rm` |
| --------------------------- | --------------------------- | ------------------------------------------------------------ |
| `C:\Projects\x.md`          | `C:\Projects\x.md`          | `C:\Projects\x.md`                                           |
| `C:/Projects/x.md`          | `C:\Projects\x.md`          | `C:\Projects\x.md`                                           |
| `/d/Projects/x.md`          | `D:\Projects\x.md`          | `D:\d\Projects\x.md` (wrong)                                 |
| `/mnt/d/Projects/x.md`      | `D:\Projects\x.md`          | `D:\mnt\d\Projects\x.md` (wrong)                             |
| `/cygdrive/d/Projects/x.md` | `D:\Projects\x.md`          | `D:\cygdrive\d\Projects\x.md` (wrong)                        |
| `~/x.md`                    | `<home>\x.md`               | `<home>\x.md`                                                |
| `~\x.md`                    | `<home>\x.md` (Windows)     | `<cwd>\~\x.md` (wrong)                                       |
| `@C:\Projects\x.md`         | `C:\Projects\x.md`          | `C:\Projects\x.md`                                           |
| `file:///D:/Projects/x.md`  | `D:\Projects\x.md`          | `D:\Projects\x.md`                                           |

The first four rows were confirmed with a `node:path` probe (PROBE 9); the native rows are
the code paths in `PKG/dist/utils/paths.js:49-86`, and the repository rows are
`REPO/src/paths.ts:16-23`.

The important asymmetry is **where** resolution happens:

- Child `read`, `write`, and `edit` call `resolveToolPath` **before** invoking the native
  tool (`REPO/src/child-tools.ts:61-63,106-113,205,271,323`). Native normalization
  therefore never sees the original string: `/d/...` becomes `D:\d\...` and fails.
- Child `find` and `grep` pass `params` straight to the native tool
  (`REPO/src/child-tools.ts:231-262`). Native normalization applies, so `/d/...`,
  `/mnt/d/...`, and `~\...` work there.
- Child `bash` runs under Git Bash, where `/d/...` and `/c/...` are valid shell paths, so
  Bash can reach files that child `read` cannot address with the same string.

## 6. Constraints on the six background tools

### 6.1 Inventory and declaration

`createChildTools` returns exactly six tools, in this order:
`read`, `write`, `edit`, `find`, `grep`, `bash` (`REPO/src/child-tools.ts:439`).

| Tool    | Construction                                                                                              | Shell dependency | Windows constraint                                              |
| ------- | --------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| `read`  | Native `createReadTool` with wrapped access/read operations (`REPO/src/child-tools.ts:190-229`)           | None             | Path goes through `resolveToolPath`; `/d/...` fails             |
| `write` | Native `createWriteTool` with capture operations, then `commitMemory` (`REPO/src/child-tools.ts:264-314`) | None             | Memory-directory containment; same path limitation              |
| `edit`  | Native `createEditTool` with capture operations, then `commitMemory` (`REPO/src/child-tools.ts:316-370`)  | None             | Memory-directory containment; same path limitation              |
| `find`  | Native `createFindTool` (`REPO/src/child-tools.ts:231-244`)                                               | `fd`             | Needs `fd` or a download; multi-segment glob quirk              |
| `grep`  | Native `createGrepTool`, wrapped in a 20 s signal (`REPO/src/child-tools.ts:246-262,161-167`)             | `rg`             | Needs `rg` or a download; one `rg` error rejects the call       |
| `bash`  | Native `createBashTool` with restricted command validation (`REPO/src/child-tools.ts:372-437`)            | Bash             | Ignores user `shellPath`/prefix; no Bash means every call fails |

`read`, `find`, and `grep` inherit the native descriptions and parameter schemas by object
spread; `write`, `edit`, and `bash` replace only `description` (`REPO/src/child-tools.ts:200-201,232-233,247-248,265-268,317-320,373-376`).
The Bash description advertises "validated read-only Bash commands" and `rm`
(`REPO/src/child-tools.ts:375-376`), while the native schema still exposes `command` and
`timeout` (`PKG/dist/core/tools/bash.js:28-31`).

With codemode off, non-fork mode declares exactly these six tools. With codemode on or
`only`, Pi's codemode loadout can hide some of the direct declarations and adds the
`codemode` tool (`REPO/src/child-codemode.ts:61-72`; `REPO/src/models.ts:570-596`). In
fork mode the child reuses the parent's message/tool declarations for prompt-cache reuse,
and only the task tools are executable; the prompt tells the model that other parent
tools may remain declared but will be denied (`REPO/src/models.ts:597-629`;
`REPO/src/child-codemode.ts:78`).

### 6.2 `bash` is the only shell-dependent tool, and it always needs Bash

The tool list always includes `bash`; there is no availability check in
`createChildTools` (`REPO/src/child-tools.ts:372-439`). If no Bash is resolvable, every
background `bash` call returns `bash failed: No bash shell found. ...` rather than the tool
being absent. The prompt and the declaration both tell the model that Bash is available
even when it is not.

Additional constraints:

- **Ignoring `shellPath` is a support hazard.** If Cygwin/MSYS2 Bash is reachable only
  through `shellPath` (not on `PATH` and not in `ProgramFiles`), a user who configured it
  as `PKG/docs/windows.md:67-73` suggests has a working built-in `bash` and `!`, but a
  failing background `bash`.
- **"Git Bash missing" does not always mean "no Bash".** The resolver can still return
  the legacy WSL launcher (PROBE 5), so the background tool may start and then fail inside
  WSL, or operate on WSL paths rather than Windows paths.
- **Timeout is extension-imposed.** Background Bash defaults to 120 seconds and rejects
  values above 600 seconds (`REPO/src/child-tools.ts:39-40,381-384,418`). The native tool
  itself has no default timeout (`PKG/dist/core/tools/bash.js:28-31`).
- **Session environment is stripped.** `exposeSessionEnvironment: false` removes
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and
  `PI_REASONING_LEVEL`; a probe confirmed `PI_SESSION_ID=unset PI_MODEL=unset`
  (`PKG/dist/core/tools/bash.js:135-154`; `REPO/src/child-tools.ts:372`; PROBE 2).
- **The validator is Bash/POSIX-centric.** Its command set includes `ls`, `find`, `cat`,
  `stat`, `wc`, `head`, `tail`, and similar utilities, and `xargs` is explicitly rejected
  on `win32` (`REPO/src/bash-readonly.ts:103-149,2404-2405`). This is consistent with
  Git Bash, not with `cmd.exe` or PowerShell builtins.

### 6.3 `read`/`write`/`edit` use a different path contract

The memory tools resolve paths with `REPO/src/paths.ts`, so on native Windows they accept
`C:\...` and `C:/...` but not `/d/...`, `/mnt/d/...`, `/cygdrive/d/...`, or `~\...`
(Section 5; PROBE 9). A parent model that has been working in Git Bash or WSL may emit
those forms; the child `read`/`write`/`edit` calls will fail even though child `find`,
`grep`, and `bash` accept them. Prompts should either use Windows drive paths for
`read`/`write`/`edit` or state the accepted forms explicitly.

`write` and `edit` additionally require the target to be inside the memory directory and
require a prior ordinary read baseline (`REPO/src/child-tools.ts:106-120,271-293,323-339`).
That is platform-independent, but it means the path-form divergence cannot be worked
around by writing to a translated path outside the memory root.

### 6.4 `find`/`grep` depend on external binaries and fail differently

- `find` needs `fd`; `grep` needs `rg`. Both can download on demand, but `PI_OFFLINE` or a
  failed download makes them unavailable (Section 4.4; PROBE 8).
- `grep` has a 20-second child wrapper signal (`REPO/src/child-tools.ts:161-167,250-260`).
  On a large Windows tree, a slow `rg` scan can be aborted even though `find` has no such
  cap.
- A single `rg` error (for example an ACL-denied file, `os error 5`) rejects the entire
  grep result, while `find` keeps output from a partially successful `fd` run
  (`PKG/dist/core/tools/grep.js:182-191`; `PKG/dist/core/tools/find.js:189-196`; PROBE 4).
- Path-containing `find` globs can silently return "No files found" on this host
  (PROBE 7). A prompt that tells the child to run `find` with `src/**/*.ts` can therefore
  produce a false negative.

### 6.5 `rm` cannot express a Windows path

The restricted Bash delete path requires every operand to start with `/`:

```ts
if (!raw.startsWith("/") || /[*?[]/.test(raw)) throw new Error("rm requires absolute, non-glob Markdown paths");
```

(`REPO/src/restricted-bash.ts:59`). It then resolves the operand with `path.resolve` and
checks containment (`REPO/src/restricted-bash.ts:60`; `REPO/src/paths.ts:254-260`).
On native Windows:

- `rm C:\...\note.md` is rejected immediately because it does not start with `/`.
- `rm /c/.../note.md` passes the first check but `path.resolve` produces
  `C:\c\...` (or `D:\c\...`), which is not inside the memory directory, so containment
  fails.
- `rm /d/.../note.md` produces `D:\d\...`, also outside the memory directory.

The result is that the documented delete capability is effectively unusable on native
Windows. This matters because both static prompts advertise it
(`REPO/src/prompts.ts:216,293`) and the Bash tool description advertises it
(`REPO/src/child-tools.ts:375-376`).

### 6.6 Prompt and declaration constraints

The extension has three layers of prompt text:

1. **Static role prompts.** The extraction prompt says the available tools include
   "read-only bash" and "bash rm of .md files inside the memory directory"
   (`REPO/src/prompts.ts:216`). The dream prompt says shell access is restricted to
   read-only commands "plus deleting `.md` files" (`REPO/src/prompts.ts:293`). Neither is
   conditional on platform or Bash availability.
2. **Generated background-tool block.** `backgroundToolPrompt` lists the actual tool
   objects and their descriptions, so omitting a tool removes its bullet automatically
   (`REPO/src/child-codemode.ts:75-79`). But its codemode paragraph still hard-codes
   "read, find, grep, write, edit, and restricted bash tools"
   (`REPO/src/child-codemode.ts:80-84`).
3. **Fixtures.** `tests/prompts.test.ts` compares the main, selector, extraction, and
   dream prompts word-for-word against `tests/fixtures/prompts/*.txt`
   (`REPO/tests/prompts.test.ts:67-75`). Any conditional Windows wording requires
   corresponding fixture changes.

Therefore, if the extension decides to omit `bash` when no Bash is resolvable, three
things must change together: the returned tool list, the codemode paragraph, and the two
static role prompts (plus fixtures). Removing only the tool leaves the model told to use a
tool that is not declared; changing only the prompts leaves a declared tool that always
fails.

`defaultTools`/`--tools` are not a substitute for this work. They change the parent's
built-in tool selection, not the six tools passed explicitly to the child
(`PKG/docs/settings.md:42-60`; `REPO/src/models.ts:570-596`). Enabling `powershell` does
not give the child a PowerShell tool either: the child's shell tool is still `bash`
(`REPO/src/child-tools.ts:6-16,439`).

### 6.7 Detection is possible

Pi exports `getShellConfig` and `getPowerShellConfig` from the package entry point
(`PKG/dist/index.js:53`), and exports `createBashTool` from the same entry point
(`PKG/dist/index.js:20`). `createBashTool` accepts `shellPath` and `commandPrefix` in its
options (`PKG/dist/core/tools/bash.js:158-161`). An extension can therefore:

- call `getShellConfig()` at child creation to decide whether to include `bash`, and
- pass a detected or configured `shellPath` into `createBashTool` if it wants to honor
  the user's setting.

The current code does neither (`REPO/src/child-tools.ts:372,415`;
`REPO/src/restricted-bash.ts:80-85`). This note is a capability statement, not a
recommendation to pass an arbitrary `shellCommandPrefix` through the restricted command
validator.

### 6.8 Adjacent observation (outside this ticket)

`package.json` declares `"os": ["darwin", "linux", "android"]` and omits `win32`
(`REPO/package.json:57-60`). That is a packaging/installability question separate from
the runtime shell contract, but it is likely to block ordinary Windows installation and
should be tracked separately.

## 7. Direct answers

**How does Pi 1.4+ resolve and invoke Bash on native Windows?**
It checks `shellPath`, then `%ProgramFiles%\Git\bin\bash.exe`, then
`%ProgramFiles(x86)%\Git\bin\bash.exe`, then the first `where bash.exe` result. Normal
Bash is spawned as `<bash> -c <command>`; the exact legacy WSL launcher is spawned as
`<bash> -s` with the command written to stdin. Resolution happens at execution time, not
at startup (`PKG/dist/utils/shell.js:6-19,76-119`;
`PKG/dist/core/tools/bash.js:55-73`; `PKG/docs/windows.md:19-24,63`).

**What does the optional `powershell` tool change?**
It adds a separate, opt-in model tool that runs commands through `pwsh.exe` or Windows
PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` and a UTF-8
output prefix. It does not replace `!`/`!!` (those remain Bash), it is Windows-only, and
it has no effect on the extension's background tools
(`PKG/dist/core/tools/powershell.js:4-28`; `PKG/dist/utils/shell.js:121-145`;
`PKG/docs/windows.md:34-55`).

**How do the native `read`, `find`, and `grep` tools behave?**
They do not use Bash. `read` is pure Node filesystem access with MSYS/WSL path
normalization and UTF-8 decoding; `find` spawns `fd`; `grep` spawns `rg`. Both external
tools are discovered in `~/.pi/agent/bin` and then `PATH`, and both can be downloaded
unless `PI_OFFLINE` is set. `find` respects `.gitignore`, returns relative `/` paths, and
defaults to 1000 results; `grep` respects `.gitignore`, returns relative `/` paths or a
basename for a single file, defaults to 100 matches, and rejects the whole call on an
`rg` exit other than 0 or 1 (Section 4; PROBE 3, PROBE 4, PROBE 8).

**What happens when Git Bash is absent, or `shellPath` points elsewhere?**
With the default tool selection, Pi still starts and advertises `bash`; the first
invocation fails. With no Bash at all it
throws the "No bash shell found" message listing the searched paths. With a missing
`shellPath` it throws `Custom shell path not found`. With a directory it throws a spawn
`ENOENT`. With a non-Bash executable there is no validation: `cmd.exe` was spawned with
`-c`, printed its banner, and exited 0. If Git Bash is absent but `System32\bash.exe` is
on `PATH`, resolution succeeds in legacy-WSL stdin mode, but actual usability depends on
WSL. The background `bash` tool uses this same default resolution and ignores the user's
`shellPath` entirely (Section 2.5; PROBE 2, PROBE 5, PROBE 6).

**What constraints does this impose on the six background tools and the prompts?**
`read`/`write`/`edit` are shell-independent but use a Windows-incompatible path resolver
for MSYS/WSL forms; `find`/`grep` are shell-independent but depend on downloadable `fd`/
`rg` and have different failure modes; `bash` always needs a resolvable Bash, ignores
`shellPath`/`shellCommandPrefix`, and is the only tool whose absence turns every call into
an error. `rm` cannot express a native Windows path and is effectively unusable. The
static extraction/dream prompts and the codemode paragraph hard-code Bash and `rm`, and
the prompt fixtures are locked, so any availability-based tool removal must update the
tool list, the generated block, the static prompts, and the fixtures together (Section 6).

## 8. Sources

### Installed Pi 1.4.0 package

Root: `C:\Users\Lenovo\.pi\agent\install\releases\1.4.0\node_modules\@earendil-works\pi-coding-agent\`.

- `docs/windows.md` — "Run Pi on Windows", especially lines 19-24 (resolution order),
  34-55 (PowerShell), 59-63 (WSL), 65-77 (custom Bash).
- `docs/shell-aliases.md:79-91` — extension vs built-in prefix behavior.
- `docs/settings.md:38-60` — `defaultTools`; `docs/settings.md:138-143` — `shellPath` and
  `shellCommandPrefix`.
- `docs/environment-variables.md:81` — `PI_OFFLINE`; `:1-10` — `PI_*` categories.
- `docs/cli.md:142-148` — built-in tool table.
- `dist/utils/shell.js` — `isLegacyWslBashPath` (6-19), `getShellConfig` (76-119),
  `POWERSHELL_ARGS`/`getPowerShellConfig` (121-145), `getShellEnv` (147-158).
- `dist/utils/paths.js:49-86` — `normalizeWindowsShellPath`, `normalizePath`,
  `resolvePath`.
- `dist/utils/tools-manager.js` — `getToolPath` (64-93), `ensureTool` (301-326).
- `dist/core/tools/bash.js` — schema (28-31), spawn (48-125), `shellPath`/`commandPrefix`
  (158-173), output description (166).
- `dist/core/tools/powershell.js` — UTF-8 prefix (4,9-13), tool config (15-28).
- `dist/core/tools/read.js` — path resolution (59-77), UTF-8/image read (85-113),
  truncation (123-129).
- `dist/core/tools/path-utils.js:42-97` — `resolveToCwd`, `resolveReadPathAsync`.
- `dist/core/tools/find.js` — fd args (119-160), output/exit handling (183-210), limit
  (28,39).
- `dist/core/tools/grep.js` — rg args (52-103), output paths (69-76), exit handling
  (182-191), limit (18,24).
- `dist/core/tools/truncate.js:10-12` — 2000 lines, 50 KB, 500-char grep lines.
- `dist/core/agent-session.js:2963-2975,3158-3166` — settings applied to built-in tools
  and `!`.
- `dist/core/settings-manager.js:35` — `DEFAULT_TOOL_NAMES`.
- `dist/index.js:20,53` — exported `createBashTool`, `getShellConfig`,
  `getPowerShellConfig`.
- `dist/core/sdk.js:29` — exported tool factories for custom cwd.

### Repository

- `src/child-tools.ts` — `createChildTools` (170), read (190-229), find (231-244),
  grep (246-262), write (264-314), edit (316-370), bash (372-437), return list (439),
  timeouts (39-40,381-384,418).
- `src/restricted-bash.ts:43-85` — delete parsing and `prepareRestrictedBash`.
- `src/bash-readonly.ts:103-149,1979,2404-2405,2454` — command allowlist and win32
  `xargs` denial.
- `src/paths.ts:16-23,254-260` — `resolveToolPath` and `assertContainedMarkdown`.
- `src/prompts.ts:209-224,287-296` — extraction and dream prompts.
- `src/child-codemode.ts:75-86` — generated background-tool prompt.
- `src/models.ts:545-596,597-629` — child tool construction, codemode, fork/non-fork
  declaration.
- `tests/prompts.test.ts:67-75` — fixed prompt fixtures.
- `package.json:57-60` — `os` field.

### Probes

All probes were run on 2026-10-29 from
`C:\Users\Lenovo\AppData\Local\Temp\opencode` with the installed Pi 1.4.0 dist and Node
v26.8.1. The scripts are listed in Appendix A.

## Appendix A: probes

### PROBE 1: environment

Commands: `pi --version`; `node --version`; `[System.Environment]::OSVersion.VersionString`;
`Get-ComputerInfo`; `$PSVersionTable.PSVersion`; `git --version`;
`"C:\Program Files\Git\bin\bash.exe" --version`; `fd --version`; `rg --version`;
`where.exe bash.exe`.

Key output: Pi `1.4.0`, Node `v26.8.1`, Windows `10.0.26300`, PowerShell
`5.1.26100.9711`, Git `2.55.0.windows.5`, Git Bash `5.3.15(2)-release`, fd `10.5.0`,
rg `15.2.0`. `where bash.exe` returned System32, WindowsApps, and Hermes paths.

### PROBE 2: shell resolution and tool execution

Script: `pi-windows-probe.mjs`. Imports `dist/utils/shell.js`,
`dist/core/tools/bash.js`, and `dist/core/tools/powershell.js`.

Key output:

```text
getShellConfig(): {"shell":"C:\\Program Files\\Git\\bin\\bash.exe","args":["-c"]}
getShellConfig(bogus) THREW: Custom shell path not found: C:\definitely-not-here\bash.exe
getPowerShellConfig(): {"shell":"C:\\Users\\Lenovo\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe","args":["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command"]}
bash identity: argv0=/usr/bin/bash; /usr/bin/bash; /tmp/opencode
bash windows path forms: three README reads succeeded
bash env: PI_SESSION_ID=unset PI_MODEL=unset
powershell identity: 7.6.9; C:\Users\Lenovo\AppData\Local\Temp\opencode
powershell unicode: héllo-✓
```

### PROBE 3: native read path forms

Script: `pi-windows-probe3.mjs`, using `createReadTool("D:\\Projects\\pi-project-memory")`.
`D:\...`, `D:/...`, `/d/...`, and `/mnt/d/...` all read the same README.

### PROBE 4: native find/grep behavior

Scripts: `pi-windows-tools-probe.mjs` and `pi-windows-probe3.mjs`.

Key output: `getToolPath(fd)` returned
`C:\Users\Lenovo\.pi\agent\bin\fd.exe`; `getToolPath(rg)` returned `rg`. `find` accepted
Windows, forward-slash, and `/c/...` paths; output used `/` separators. `grep` resolved
Windows and `/c/...` paths and ran `rg` (then hit the ACL error below); a directory search
containing an access-denied entry made `rg` exit 2 with `os error 5` and the tool threw
the stderr text; a missing path threw `Path not found: ...`; a single file with no match
returned `No matches found`.

### PROBE 5: missing Bash and legacy WSL fallback

With `ProgramFiles` and `ProgramFiles(x86)` pointed at nonexistent directories and
`PATH` emptied, `getShellConfig()` threw the "No bash shell found" message. With
`PATH=C:\Windows\System32`, it returned:

```json
{ "shell": "C:\\Windows\\System32\\bash.exe", "args": ["-s"], "commandTransport": "stdin" }
```

### PROBE 6: bad `shellPath`

`createBashTool(cwd, { shellPath: "C:\\Windows" })` threw `spawn C:\Windows ENOENT`.
`createBashTool(cwd, { shellPath: "C:\\Windows\\System32\\cmd.exe" })` returned exit 0
with the cmd banner and no command output.

### PROBE 7: `find` path-containing globs

Using `createFindTool("D:\\Projects\\pi-project-memory")`:

```text
src/*.ts             -> 5 results (limit reached)
src/**               -> 5 results (limit reached)
**/*.ts              -> 5 results (limit reached)
*.ts                 -> 5 results (limit reached)
src/**/*.ts          -> No files found matching pattern
```

Direct `fd` calls reproduced the same distinction. This is recorded as an observed
Windows `find`/`fd` quirk, not as a claimed universal rule.

### PROBE 8: offline `fd`/`rg`

With `PI_OFFLINE=1`, `PI_CODING_AGENT_DIR` pointing at an empty directory, and
`PATH=C:\Windows\System32`:

```text
grep THREW ripgrep (rg) is not available and could not be downloaded
find THREW fd is not available and could not be downloaded
```

### PROBE 9: repository path resolver

A `node:path` reproduction of `REPO/src/paths.ts:16-23`, with cwd
`D:\Projects\pi-project-memory`:

```text
/d/Projects/pi-project-memory/README.md       -> D:\d\Projects\pi-project-memory\README.md
/mnt/d/Projects/pi-project-memory/README.md   -> D:\mnt\d\Projects\pi-project-memory\README.md
/cygdrive/d/Projects/pi-project-memory/README.md -> D:\cygdrive\d\Projects\pi-project-memory\README.md
C:/Projects/pi-project-memory/README.md       -> C:\Projects\pi-project-memory\README.md
~\memory                                      -> D:\Projects\pi-project-memory\~\memory
~/memory                                      -> C:\Users\Lenovo\memory
```
