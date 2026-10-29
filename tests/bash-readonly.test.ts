import assert from "node:assert/strict";
import test from "node:test";
import { classifyReadOnlyBash } from "../src/bash-readonly.ts";
import { skipOnWindows, WINDOWS_XARGS_REASON } from "./helpers.ts";

function allows(command: string): void {
	const result = classifyReadOnlyBash(command);
	assert.equal(result.readOnly, true, `${command}: ${result.reason}`);
}

function denies(command: string): void {
	const result = classifyReadOnlyBash(command);
	assert.equal(result.readOnly, false, command);
}

test("classifies simple and compound read-only Bash", () => {
	for (const command of [
		"cat README.md",
		"cat *.md | grep memory && wc -l README.md",
		"LANG=C grep -n memory README.md",
		"printf hello",
		"find . -name '*.md'",
		"sort -k2 README.md",
		"sed -n '1,20p' README.md",
		"jq '.name' package.json",
		"git status --short",
		"git branch --list",
		"time cat README.md",
		"timeout 5s rg memory README.md",
		"nice -n 5 cat README.md",
		"stdbuf -oL grep memory README.md",
		"env LANG=C cat README.md",
	])
		allows(command);
});

test("fails closed for unsafe shell syntax and commands", () => {
	for (const command of [
		"rm file.md",
		"unknown-command",
		"(cat README.md)",
		"cat README.md &",
		"cat $(pwd)/README.md",
		"cat <<EOF\n$(touch /tmp/pwn)\nEOF",
		"cat <<EOF\n$HOME\nEOF",
		"cat <<EOF\n$((1 + 1))\nEOF",
		"cat ~/README.md",
		"PATH=. cat README.md",
		"PATH=/tmp; cat README.md",
		"PATH=/tmp && cat README.md",
		"cat README.md > out",
		"cat </dev/tcp/example.com/80",
		"python -c 'print(1)'",
		"awk '{print}' README.md",
	])
		denies(command);
});

test("rejects assignments to special shell state, including array elements", () => {
	for (const name of ["BASH_ALIASES", "BASH_CMDS", "SHELLOPTS", "BASHOPTS", "PWD", "OLDPWD", "DIRSTACK"]) {
		for (const target of [name, `${name}[cat]`]) {
			denies(`${target}=/bin/rm; cat README.md`);
			denies(`${target}+=/bin/rm; cat README.md`);
			denies(`${target}=/bin/rm cat README.md`);
		}
	}
	denies("PATH[0]=/tmp; cat README.md");
	allows("PI_MEMORY_TEST_VALUE=hello; cat README.md");
});

test("parses typed options and file-valued operands", () => {
	allows("grep --regexp=memory README.md");
	allows("grep -eneedle README.md");
	allows("rg -A3 --glob='*.ts' memory src");
	allows("sort --key=2 README.md");
	allows("file --mime README.md");
	allows("head -n 10 README.md");
	denies("sort -o/tmp/out README.md");
	denies("sort --compress-program=/bin/sh README.md");
	denies("file -m/etc/passwd README.md");
	denies("find . -exec cat {} ';'");
	denies("find . -delete");
	denies("uniq input output");
	denies("xargs --arg-file=/etc/passwd echo");
	allows("sha256sum -c checksums.txt");
	allows("wc --files0-from files.txt");
	denies("sed -e 's/a/b/' -e 'w /tmp/pwn' README.md");
	allows("find -L /etc -name passwd");
	allows("find . -follow -name passwd");
	allows("ls -LR .");
	allows("du -L .");
	allows("grep -R needle .");
	allows("rg -L needle .");
	allows("rg --glob='/etc/*' needle .");
	allows("rg --glob='../*' needle .");
	allows("rg needle");
	for (const command of [
		"grep -e /etc/*'conf' README.md",
		"rg -e /etc/*'conf' README.md",
		"file -F /etc/*'conf' README.md",
	]) {
		const mixedGlob = classifyReadOnlyBash(command);
		if (mixedGlob.readOnly)
			assert.equal(
				mixedGlob.commands[0]?.pathIntents.some((intent) => intent.value === "/etc/*conf"),
				true,
			);
	}
	allows("git diff --no-ext-diff --no-index /etc/passwd /etc/hosts");
	allows("git grep --no-index root /etc/passwd");
	allows("grep -r needle .");
	allows("tail -F file.md");
	allows("tail --follow=name file.md");
	allows("tail --retry file.md");
	allows("tail --pid=123 file.md");
	const find = classifyReadOnlyBash("find -E /etc -name passwd");
	assert.equal(find.readOnly, true);
	assert.equal(find.commands[0]?.pathIntents[0]?.value, "/etc");
	const findReference = classifyReadOnlyBash("find . -neweram /etc/passwd");
	assert.equal(findReference.readOnly, true);
	assert.equal(findReference.commands[0]?.pathIntents[1]?.value, "/etc/passwd");
});

test("validates printf arithmetic operands", () => {
	allows("printf '%s\\n' 'array[$(touch /tmp/pwn)]'");
	allows("printf '%d\\n' 42");
	allows("printf '%f\\n' -1.25");
	allows("printf -- '%d\\n' -1");
	denies("printf '%d\\n' 1+1");
	denies("printf '%d\\n' 'array[1]'");
	denies("printf '%d\\n' 'array[$(touch /tmp/pwn)]'");
	denies("printf '%*s' 1+1 text");
});

test("validates xargs inner-command rules", (t) => {
	if (skipOnWindows(t, WINDOWS_XARGS_REASON)) return;
	denies("xargs printf '%d\\n'");
	allows("xargs printf '%s\\n'");
	allows("xargs");
	allows("xargs cat");
	allows("xargs -I{} head -n 1 -- {}");
	allows("xargs -I@ cat -- @");
	allows("xargs sort --");
	denies("xargs sort");
	denies("xargs rg needle");
	denies("xargs rm");
	denies("xargs sh -c");
	denies("xargs -I{} {}");
	denies("xargs -I{} printf {}");
	for (const option of ["-L 1", "-P 2", "-s 100", "-t", "-x"]) allows(`xargs ${option} echo`);
});

test("classifies Claude's extended read-only command table", () => {
	for (const command of [
		"claude --help",
		"ip addr",
		"history 10",
		"arch --help",
		"ifconfig en0",
		"man printf",
		"help printf",
		"netstat -an",
		"ps -ef",
		"ps -ww",
		"base64 README.md",
		"tree -l --charset=utf-8 -L 2 .",
		"date -u +%FT%TZ",
		"hostname -s",
		"lsof -n",
		"pgrep -f node",
		"tput cols",
		"ss -lnt",
		"ss state established",
		"fd -e ts memory src",
		"fdfind -e ts memory src",
		"sha256sum --text README.md",
		"sha1sum --text README.md",
		"md5sum --text README.md",
		"aki --limit 5 memory",
		"test -f README.md",
		"[ -f README.md ]",
		"[[ README.md -nt old.md ]]",
		"docker ps",
		"docker images -q",
		"docker logs --tail 10 app",
		"docker inspect app",
	])
		allows(command);
	denies("date tomorrow");
	denies("hostname new-name");
	denies("lsof -iTCP@example.com:443");
	denies("tput reset");
	denies("tput rs1");
	denies("test left -a right");
	denies("docker --host tcp://example.invalid:2375 ps");
	denies("aki --source=~/private memory");
	allows("fd --follow memory .");
});

test("classifies git and other command-specific rules", () => {
	allows("git log --oneline -10");
	allows("git diff --no-ext-diff -- README.md");
	allows("git config --get user.name");
	allows("git remote -v");
	allows("git remote show -n origin");
	allows("git ls-remote --sort version:refname");
	allows("git tag --list 'v*'");
	allows("git diff -- README.md");
	denies("git branch new-branch HEAD");
	denies("git tag new-tag HEAD");
	denies("git remote add origin x");
	denies("git blame --contents /etc/passwd -- README.md");
	denies("git stash show --output=/tmp/pwn");
	denies("git -c diff.external=/bin/sh diff");
	for (const command of [
		"gh pr view 12 --json title,state",
		"gh pr list --state open --limit 20",
		"gh pr diff 12 --name-only",
		"gh pr checks 12 --required",
		"gh pr status --json currentBranch",
		"gh issue view 12 --comments",
		"gh issue list --label bug --limit 20",
		"gh issue status --json assigned",
		"gh repo view --json nameWithOwner",
		"gh run list --branch main --limit 10",
		"gh run view 123 --log-failed",
		"gh auth status --active",
		"gh release list --exclude-drafts",
		"gh release view v1.0.0 --json name",
		"gh workflow list --all",
		"gh workflow view test.yml --yaml",
		"gh label list --limit 20",
		"gh search repos memory --language typescript",
		"gh search issues bug --state open",
		"gh search prs memory --merged",
		"gh search commits fix --author dev",
		"gh search code selector --extension ts",
	])
		allows(command);
	for (const command of [
		"gh pr create",
		"gh issue close 12",
		"gh api repos/o/r/issues -f title=x",
		"gh pr view https://github.com/o/r/pull/1",
		"gh pr view @file",
		"gh run view owner/repo/actions/runs/1",
	])
		denies(command);
	allows("docker ps");
	allows("docker logs container");
	allows("docker inspect container");
});

test("returns path intents for the execution policy", () => {
	const grep = classifyReadOnlyBash("grep -f patterns.txt needle src/a.ts");
	assert.equal(grep.readOnly, true);
	assert.deepEqual(
		grep.commands[0]?.pathIntents.map((intent) => [intent.value, intent.source]),
		[
			["needle", "argument"],
			["src/a.ts", "argument"],
			["patterns.txt", "option"],
		],
	);
	const grepGlob = classifyReadOnlyBash("grep --include /etc/* needle .");
	assert.equal(grepGlob.readOnly, true);
	assert.equal(
		grepGlob.commands[0]?.pathIntents.some((intent) => intent.value === "/etc/*"),
		true,
	);
	const escaped = classifyReadOnlyBash("cat README\\ file.md");
	assert.equal(escaped.readOnly, true);
	assert.equal(escaped.commands[0]?.pathIntents[0]?.value, "README file.md");
	const redirect = classifyReadOnlyBash("cat < README.md");
	assert.equal(redirect.readOnly, true);
	assert.deepEqual(redirect.commands[0]?.pathIntents[0]?.value, "README.md");
	const envCwd = classifyReadOnlyBash("env -C sub env --chdir=nested cat file.md");
	assert.equal(envCwd.readOnly, true);
	assert.deepEqual(
		envCwd.commands[0]?.workingDirectoryIntents?.map((intent) => intent.value),
		["sub", "nested"],
	);
	denies("env -S 'rm file.md'");
	denies("env -S 'sh -c touch /tmp/pwn'");
	denies(`env -S 'cat \${HOME}/secret'`);
	allows("env -S 'cat README.md'");
	allows("cd sub && cat file.md");
	allows("cd sub || cat file.md");
	allows("cd sub; cat file.md");
	allows("cd sub | cat file.md");
	const pidfile = classifyReadOnlyBash("pgrep --pidfile=run/server.pid node");
	assert.equal(pidfile.readOnly, true);
	assert.equal(pidfile.commands[0]?.pathIntents[0]?.value, "run/server.pid");
});

test("sed follows Claude printing and stdin substitution rules", () => {
	for (const command of [
		"printf old | sed 's/old/new/'",
		"sed 's/error/warning/g'",
		"sed -E 's/old/new/2g'",
		"sed -n '1p;3p' file.txt",
		"sed -n '1,10p; 20p' file.txt",
	])
		allows(command);
	for (const command of [
		"sed 's/old/new/' file.txt",
		"sed 's/old/new/e'",
		"sed 's/old/new/w output.txt'",
		"sed 's/old/new/;e touch output.txt'",
		"sed -i 's/old/new/' file.txt",
		"sed -n '1p;w output.txt' file.txt",
		"sed -n '1p;e touch output.txt' file.txt",
	])
		denies(command);
});

test("cd, man searches, and interface names match Claude argument checks", () => {
	for (const command of [
		"cd",
		"cd; pwd",
		"cd; cat .ssh/config",
		"ifconfig eth0:1",
		"ifconfig eth0.100",
		"man -k 'foo/bar'",
		"man -f 'foo~bar'",
		"man --apropos 'foo/bar'",
		"man --whatis 'foo/bar'",
		"man -S 3 -k 'foo/bar'",
	])
		allows(command);
	for (const command of [
		"cd one two",
		"ifconfig eth0 up",
		"ifconfig 123",
		"man 'foo/bar'",
		"man -w 'foo/bar'",
		"man -k -- -danger",
		"man -ak 'foo/bar'",
	])
		denies(command);
});
