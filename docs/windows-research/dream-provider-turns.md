# Windows dream run stops after one provider turn

Research answer for [#13](https://github.com/fktpp2022/pi-project-memory/issues/13). No product code or tests were
changed for this investigation; the one temporary probe patch described below was reverted before the research commit.

- Worktree: `D:\Projects\pi-project-memory`
- Branch: `research/windows-dream`
- Base commit: `f88a96d` (`chore(deps): update dependency @biomejs/biome to v2.6.3 (#17)`)

## Question

Why does the dream consolidation run stop after 1 of 4 provider turns when reading a live transcript on native Windows,
while the same scenario passes on Unix? Is this a product bug, a fixture path assumption, or a provider/test
interaction?

## Method and host

| Item          | Value                                                     |
| ------------- | --------------------------------------------------------- |
| OS            | Microsoft Windows 11 (NT 10.0.26300.0), AMD64             |
| Shell         | PowerShell 5.1                                            |
| Node.js       | v26.8.1                                                   |
| pnpm          | 12.5.1                                                    |
| Git           | 2.55.0.windows.5                                          |
| Checkout      | `core.autocrlf=true` (default); `node_modules` via pnpm   |
| Isolated `pi` | not used — the failing test does not invoke the Pi binary |

Commands used:

```powershell
pnpm install --frozen-lockfile
node --import=tsx --test --test-name-pattern "dream reads live session transcripts" tests/lifecycle.test.ts
```

## Answer

**Test-only artifact: a JSON-escaping mismatch in one assertion inside the faux provider stub.** There is no product
bug in dream scheduling, transcript reading, mtime handling, or path containment.

`tests/lifecycle.test.ts:2098` compares a raw Windows path with a JSON-encoded string:

```ts
assert.ok(JSON.stringify(context.messages.at(-1)?.content).includes(harness.sessionDir));
```

On Windows the harness session directory is a native path such as
`C:\Users\Lenovo\AppData\Local\Temp\pi-memory-lifecycle-focused-XXXX\sessions` (`tests/lifecycle.test.ts:112-119`).
`JSON.stringify` escapes every backslash, so the encoded text contains `C:\\Users\\...` and never contains the raw
`C:\Users\...` substring. The assertion throws inside the first faux response.

The provider stub then hides that assertion: the faux core catches a thrown step and converts it into an assistant
message with `stopReason: "error"` (`node_modules/@earendil-works/pi-ai/dist/providers/faux.js:390-393`).
`runChildAgent` pushes that message, increments the turn counter, and breaks the loop on the error stop reason
(`src/models.ts:639-650`, break at line 648). The dream command reports only a warning notice
(`index.ts:1331-1332`). The test then fails at its first post-run assertion, `callCount === 4`
(`tests/lifecycle.test.ts:2116`), which is why the visible failure is `1 !== 4` instead of the real assertion text.

On Unix the session directory is `/tmp/pi-memory-lifecycle-focused-XXXX/sessions`. `JSON.stringify` does not escape
forward slashes, so the same assertion is true and the test takes all four turns. The platform difference is path
separator escaping only.

## Evidence

### 1. Reproduce the failure on this host

```text
> node --import=tsx --test --test-name-pattern "dream reads live session transcripts" tests/lifecycle.test.ts

✖ dream reads live session transcripts without staging or pre-parsing omitted files (299.5644ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1

✖ failing tests:

test at tests\lifecycle.test.ts:15:16501
✖ dream reads live session transcripts without staging or pre-parsing omitted files (299.5644ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 4

      at TestContext.<anonymous> (D:\Projects\pi-project-memory\tests\lifecycle.test.ts:2116:9)
```

### 2. Recover the assertion hidden by the faux provider

Temporary probe (not committed): wrapping `modelRegistry.streamSimple` in the test to log each assistant message's
`stopReason` and `errorMessage` produced:

```text
PROBE error The expression evaluated to a falsy value:
PROBE notices [{"message":"memory dream failed: The expression evaluated to a falsy value:\n\n  assert.ok(JSON.stringify(context.messages.at(-1)?.content).includes(harness.sessionDir))\n","level":"warning"}]
```

The first provider response is therefore returned as a failed assistant message, not executed as a tool call. The turn
loop stops at `turns = 1`; no read tool ever runs in that turn.

### 3. Isolate the escaping difference

```text
> node -e "const s='/tmp/pi-memory-lifecycle-focused-abc/sessions';console.log('posix-style includes:',JSON.stringify('Session transcripts: '+s).includes(s));const w='C:\\Users\\Lenovo\\AppData\\Local\\Temp\\x\\sessions';console.log('windows-style includes:',JSON.stringify('Session transcripts: '+w).includes(w))"

posix-style includes: true
windows-style includes: false
```

The dream prompt embeds the native session directory verbatim through `inlineCodePath` (`src/prompts.ts:229-238`); the
prompt itself is correct. Only the JSON comparison in the stub is wrong.

### 4. Confirm the rest of the test passes with only that assertion normalized

Temporary patch (not committed), replacing the raw substring with its JSON-escaped form:

```ts
assert.ok(JSON.stringify(context.messages.at(-1)?.content).includes(JSON.stringify(harness.sessionDir).slice(1, -1)));
```

```text
> node --import=tsx --test --test-name-pattern "dream reads live session transcripts" tests/lifecycle.test.ts

✔ dream reads live session transcripts without staging or pre-parsing omitted files (285.0948ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

With that one line changed, all four turns run on Windows: the live transcript is re-read with `live content`, the
malformed transcript read succeeds as a text read, the write outside the memory directory is rejected, the transcript
file is unchanged, `lastDreamAt` is recorded, and the "No memory changes needed." notice is emitted
(`tests/lifecycle.test.ts:2095-2119`). The temporary patch was reverted; `git status` shows no modified files.

## Why the other suspected causes do not apply

| Suspect                           | Finding                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mtime granularity / read snapshot | Not involved. The transcript lives outside `paths.memoryDir`, so `isMemoryFile` is false and the before/after baseline check is skipped (`src/child-tools.ts:206-223`). The mtime-based `readRegularUtf8` check (`src/child-tools.ts:65-73`) only runs for memory files. |
| Case-insensitive path equality    | Not involved. `resolveReadablePath` calls `realpath` on the path produced by `join()` from `mkdtemp`, so the string already matches the harness path; the failing comparison is about escaping, not case.                                                                |
| `/tmp` vs native temp path        | This is the trigger, but not a product defect. The harness uses `os.tmpdir()` (`tests/lifecycle.test.ts:112`), so the prompt contains native `\` separators on Windows; the test compares them against JSON-escaped text.                                                |
| Containment / read-baseline check | Not involved in the first turn. Reads outside the memory directory are allowed (`src/child-tools.ts:61-63, 200-229`); the write containment check that the test exercises runs in turn 3 and passes once the stub assertion is fixed.                                    |
| Turn budget                       | Not involved. `dream.maxTurns` defaults to 50 (`src/config.ts:21-27, 106-112`); the run stopped at 1 because the assistant message had `stopReason: "error"`.                                                                                                            |
| Product session enumeration       | Correct. The prompt lists the selected transcript IDs and the session directory; the first response's `/approved/` assertion passes.                                                                                                                                     |

The masking chain is worth recording because it makes any future stub assertion failure look like a turn-count bug:

1. `resolveResponse` awaits the async step (`faux.js:349-351`); a throw is caught at `faux.js:390-393` and converted to
   `createErrorMessage(...)`.
2. `state.callCount` is incremented before the step resolves (`faux.js:356`), so the test sees exactly one call.
3. `runChildAgent` breaks on `last.stopReason` in `["error", "aborted", "length"]` (`src/models.ts:647-648`).
4. `maybeDream` records `lastDreamError` and calls `notifyError` (`index.ts:1331-1332`), which only reaches the notice
   list the test inspects later.

## What is already correct

- `dreamPrompt` renders the memory directory and session directory as native paths; backslash rendering is valid text
  (`src/prompts.ts:229-238`).
- The child read tool resolves and reads live transcript files through `realpath` and returns the updated content on
  the next turn (`src/child-tools.ts:61-63, 200-229`).
- Dream turn accounting and loop termination are correct for genuine provider errors (`src/models.ts:625-675`).
- The write to a non-Markdown path outside the memory directory is rejected as expected; the test's turn-3/turn-4
  assertions pass on Windows once the stub assertion is fixed.
- No production path or permission behavior depends on the failed assertion.

## Recommended minimal fix

Test-only, one line in `tests/lifecycle.test.ts:2098`. Compare against the JSON-escaped form of the path, which works
on both Windows and Unix:

```ts
assert.ok(JSON.stringify(context.messages.at(-1)?.content).includes(JSON.stringify(harness.sessionDir).slice(1, -1)));
```

An equally small alternative avoids JSON round-tripping the assertion target and is clearer about intent:

```ts
const lastContent = context.messages.at(-1)?.content;
const lastText = Array.isArray(lastContent)
  ? lastContent.map((block: any) => (block.type === "text" ? block.text : "")).join("")
  : String(lastContent ?? "");
assert.ok(lastText.includes(harness.sessionDir));
```

Either change keeps the test's meaning (the dream prompt must name the live session directory) and removes the
platform-dependent escaping. No product change is needed.

Optional diagnosability improvement, not required for this ticket: have the test fail on the dream warning notice, or
wrap the faux steps so an assertion thrown inside a stub is re-thrown after `dream` returns instead of being converted
to a provider error. That would make future stub failures report their real message rather than `1 !== 4`.

## Open questions

- Should the test harness surface provider-stub assertion failures directly? The conversion to a `stopReason: "error"`
  message is upstream faux behavior; a small local wrapper in `tests/lifecycle.test.ts` could re-throw it.
- Are there other tests that compare raw paths against `JSON.stringify` output? A search finds only this occurrence
  (`rg "JSON\.stringify\(.*\)\.includes\(" tests`); the other path assertion at `tests/lifecycle.test.ts:629` checks a
  plain string and is unaffected.
- Does this block Windows support? No product behavior is at risk. It does block a green Windows test run, so the
  one-line test fix should land before Windows CI is declared green; it does not change the Windows support decision
  itself.
