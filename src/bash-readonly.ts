import type Parser from "tree-sitter";
import { loadNativeBinding } from "./native-binding.ts";

export type BashPathAccess = "read" | "cwd";

export interface BashPathIntent {
	value: string;
	access: BashPathAccess;
	glob: boolean;
	source: "argument" | "option" | "redirect";
}

export interface BashCommandInfo {
	name: string;
	argv: string[];
	env: Record<string, string>;
	pathIntents: BashPathIntent[];
	/** Ordered temporary cwd transitions selected by wrappers such as env -C. */
	workingDirectoryIntents?: BashPathIntent[];
	hasGlob: boolean;
}

export interface BashReadOnlyDecision {
	readOnly: boolean;
	reason: string;
	commands: BashCommandInfo[];
}

export interface BashClassifierOptions {
	platform?: NodeJS.Platform;
}

type ValueKind = "none" | "number" | "string" | "char" | "braces" | "eof";
type OptionSpec = Readonly<Record<string, ValueKind>>;

interface ParsedOptions {
	positionals: string[];
	occurrences: Map<string, string[]>;
}

interface NormalizedCommand {
	argv: string[];
	env: Record<string, string>;
	redirects: { op: string; target: string; literal: boolean }[];
	hasGlob: boolean;
}

let parser: Parser | undefined;

function bashParser(): Parser {
	if (!parser) {
		const ParserConstructor = loadNativeBinding("tree-sitter") as new () => Parser;
		const Bash = loadNativeBinding("tree-sitter-bash") as unknown as Parser.Language;
		parser = new ParserConstructor();
		parser.setLanguage(Bash);
	}
	return parser;
}

const SAFE_ENV = new Set([
	"GOEXPERIMENT",
	"GOOS",
	"GOARCH",
	"CGO_ENABLED",
	"GO111MODULE",
	"RUST_BACKTRACE",
	"RUST_LOG",
	"NODE_ENV",
	"PYTHONUNBUFFERED",
	"PYTHONDONTWRITEBYTECODE",
	"PYTEST_DISABLE_PLUGIN_AUTOLOAD",
	"PYTEST_DEBUG",
	"ANTHROPIC_API_KEY",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_TIME",
	"CHARSET",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TZ",
	"LS_COLORS",
	"LSCOLORS",
	"GREP_COLOR",
	"GREP_COLORS",
	"GCC_COLORS",
	"TIME_STYLE",
	"BLOCK_SIZE",
	"BLOCKSIZE",
	"COLUMNS",
	"LINES",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"CI",
	"DEBIAN_FRONTEND",
	"GIT_TERMINAL_PROMPT",
]);

const SPECIAL_SHELL_VARIABLES = new Set([
	"BASH_ALIASES",
	"BASH_CMDS",
	"SHELLOPTS",
	"BASHOPTS",
	"PWD",
	"OLDPWD",
	"DIRSTACK",
]);

const DIRECT_COMMANDS = new Set([
	"cal",
	"uptime",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"strings",
	"hexdump",
	"od",
	"nl",
	"id",
	"uname",
	"free",
	"df",
	"du",
	"locale",
	"groups",
	"nproc",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"cut",
	"paste",
	"tr",
	"column",
	"tac",
	"rev",
	"fold",
	"expand",
	"unexpand",
	"fmt",
	"comm",
	"cmp",
	"numfmt",
	"true",
	"false",
	"sleep",
	"which",
	"type",
	"expr",
	"seq",
	"tsort",
	"pr",
]);

const PROCESS_COMMAND_OPTIONS: Readonly<Record<string, OptionSpec>> = {
	netstat: {
		"-a": "none",
		"-L": "none",
		"-l": "none",
		"-n": "none",
		"-f": "string",
		"-g": "none",
		"-i": "none",
		"-I": "string",
		"-s": "none",
		"-r": "none",
		"-m": "none",
		"-v": "none",
	},
	pgrep: {
		"-d": "string",
		"--delimiter": "string",
		"-l": "none",
		"--list-name": "none",
		"-a": "none",
		"--list-full": "none",
		"-v": "none",
		"--inverse": "none",
		"-w": "none",
		"--lightweight": "none",
		"-c": "none",
		"--count": "none",
		"-f": "none",
		"--full": "none",
		"-g": "string",
		"--pgroup": "string",
		"-G": "string",
		"--group": "string",
		"-i": "none",
		"--ignore-case": "none",
		"-n": "none",
		"--newest": "none",
		"-o": "none",
		"--oldest": "none",
		"-O": "string",
		"--older": "string",
		"-P": "string",
		"--parent": "string",
		"-s": "string",
		"--session": "string",
		"-t": "string",
		"--terminal": "string",
		"-u": "string",
		"--euid": "string",
		"-U": "string",
		"--uid": "string",
		"-x": "none",
		"--exact": "none",
		"-r": "string",
		"--runstates": "string",
		"--ns": "string",
		"--nslist": "string",
		"-F": "string",
		"--pidfile": "string",
		"-L": "none",
		"--logpidfile": "none",
		"--help": "none",
		"-V": "none",
		"--version": "none",
	},
	ss: {
		"-h": "none",
		"--help": "none",
		"-V": "none",
		"--version": "none",
		"-n": "none",
		"--numeric": "none",
		"-a": "none",
		"--all": "none",
		"-l": "none",
		"--listening": "none",
		"-o": "none",
		"--options": "none",
		"-e": "none",
		"--extended": "none",
		"-m": "none",
		"--memory": "none",
		"-p": "none",
		"--processes": "none",
		"-i": "none",
		"--info": "none",
		"-s": "none",
		"--summary": "none",
		"-4": "none",
		"--ipv4": "none",
		"-6": "none",
		"--ipv6": "none",
		"-0": "none",
		"--packet": "none",
		"-t": "none",
		"--tcp": "none",
		"-M": "none",
		"--mptcp": "none",
		"-S": "none",
		"--sctp": "none",
		"-u": "none",
		"--udp": "none",
		"-d": "none",
		"--dccp": "none",
		"-w": "none",
		"--raw": "none",
		"-x": "none",
		"--unix": "none",
		"--tipc": "none",
		"--vsock": "none",
		"-f": "string",
		"--family": "string",
		"-A": "string",
		"--query": "string",
		"--socket": "string",
		"-Z": "none",
		"--context": "none",
		"-z": "none",
		"--contexts": "none",
		"-b": "none",
		"--bpf": "none",
		"-E": "none",
		"--events": "none",
		"-H": "none",
		"--no-header": "none",
		"-O": "none",
		"--oneline": "none",
		"--tipcinfo": "none",
		"--tos": "none",
		"--cgroup": "none",
		"--inet-sockopt": "none",
	},
};

const PATH_COMMAND_OPTIONS: Readonly<Record<string, OptionSpec>> = {
	base64: {
		"-d": "none",
		"-D": "none",
		"--decode": "none",
		"-b": "number",
		"--break": "number",
		"-w": "number",
		"--wrap": "number",
		"-i": "string",
		"--input": "string",
		"--ignore-garbage": "none",
		"-h": "none",
		"--help": "none",
		"--version": "none",
	},
	tree: {
		"-a": "none",
		"-d": "none",
		"-l": "none",
		"-f": "none",
		"-x": "none",
		"-L": "number",
		"-P": "string",
		"-I": "string",
		"--gitignore": "none",
		"--gitfile": "string",
		"--ignore-case": "none",
		"--matchdirs": "none",
		"--metafirst": "none",
		"--prune": "none",
		"--info": "none",
		"--infofile": "string",
		"--noreport": "none",
		"--charset": "string",
		"--filelimit": "number",
		"-q": "none",
		"-N": "none",
		"-Q": "none",
		"-p": "none",
		"-u": "none",
		"-g": "none",
		"-s": "none",
		"-h": "none",
		"--si": "none",
		"--du": "none",
		"-D": "none",
		"--timefmt": "string",
		"-F": "none",
		"--inodes": "none",
		"--device": "none",
		"-v": "none",
		"-t": "none",
		"-c": "none",
		"-U": "none",
		"-r": "none",
		"--dirsfirst": "none",
		"--filesfirst": "none",
		"--sort": "string",
		"-i": "none",
		"-A": "none",
		"-S": "none",
		"-n": "none",
		"-C": "none",
		"-X": "none",
		"-J": "none",
		"-H": "string",
		"--nolinks": "none",
		"--hintro": "string",
		"--houtro": "string",
		"-T": "string",
		"--hyperlink": "none",
		"--scheme": "string",
		"--authority": "string",
		"--fromfile": "none",
		"--fromtabfile": "none",
		"--fflinks": "none",
		"--help": "none",
		"--version": "none",
	},
};

const PS_OPTIONS: OptionSpec = {
	"-e": "none",
	"-A": "none",
	"-a": "none",
	"-d": "none",
	"-N": "none",
	"--deselect": "none",
	"-f": "none",
	"-F": "none",
	"-l": "none",
	"-j": "none",
	"-y": "none",
	"-w": "none",
	"-ww": "none",
	"--width": "number",
	"-c": "none",
	"-H": "none",
	"--forest": "none",
	"--headers": "none",
	"--no-headers": "none",
	"-n": "string",
	"--sort": "string",
	"-L": "none",
	"-T": "none",
	"-m": "none",
	"-C": "string",
	"-G": "string",
	"-g": "string",
	"-p": "string",
	"--pid": "string",
	"-q": "string",
	"--quick-pid": "string",
	"-s": "string",
	"--sid": "string",
	"-t": "string",
	"--tty": "string",
	"-U": "string",
	"-u": "string",
	"--user": "string",
	"--help": "none",
	"--info": "none",
	"-V": "none",
	"--version": "none",
};

const FD_OPTIONS: OptionSpec = {
	"-h": "none",
	"--help": "none",
	"-V": "none",
	"--version": "none",
	"-H": "none",
	"--hidden": "none",
	"-I": "none",
	"--no-ignore": "none",
	"--no-ignore-vcs": "none",
	"--no-ignore-parent": "none",
	"-s": "none",
	"--case-sensitive": "none",
	"-i": "none",
	"--ignore-case": "none",
	"-g": "none",
	"--glob": "none",
	"--regex": "none",
	"-F": "none",
	"--fixed-strings": "none",
	"-a": "none",
	"--absolute-path": "none",
	"-L": "none",
	"--follow": "none",
	"-p": "none",
	"--full-path": "none",
	"-0": "none",
	"--print0": "none",
	"-d": "number",
	"--max-depth": "number",
	"--min-depth": "number",
	"--exact-depth": "number",
	"-t": "string",
	"--type": "string",
	"-e": "string",
	"--extension": "string",
	"-S": "string",
	"--size": "string",
	"--changed-within": "string",
	"--changed-before": "string",
	"-o": "string",
	"--owner": "string",
	"-E": "string",
	"--exclude": "string",
	"--ignore-file": "string",
	"-c": "string",
	"--color": "string",
	"-j": "number",
	"--threads": "number",
	"--max-buffer-time": "string",
	"--max-results": "number",
	"-1": "none",
	"-q": "none",
	"--quiet": "none",
	"--show-errors": "none",
	"--strip-cwd-prefix": "none",
	"--one-file-system": "none",
	"--prune": "none",
	"--search-path": "string",
	"--base-directory": "string",
	"--path-separator": "string",
	"--batch-size": "number",
	"--no-require-git": "none",
	"--hyperlink": "string",
	"--and": "string",
	"--format": "string",
};

const DATE_OPTIONS: OptionSpec = {
	"-d": "string",
	"--date": "string",
	"-r": "string",
	"--reference": "string",
	"-u": "none",
	"--utc": "none",
	"--universal": "none",
	"-I": "none",
	"--iso-8601": "string",
	"-R": "none",
	"--rfc-email": "none",
	"--rfc-3339": "string",
	"--debug": "none",
	"--help": "none",
	"--version": "none",
};

const HOSTNAME_OPTIONS: OptionSpec = {
	"-f": "none",
	"--fqdn": "none",
	"--long": "none",
	"-s": "none",
	"--short": "none",
	"-i": "none",
	"--ip-address": "none",
	"-I": "none",
	"--all-ip-addresses": "none",
	"-a": "none",
	"--alias": "none",
	"-d": "none",
	"--domain": "none",
	"-A": "none",
	"--all-fqdns": "none",
	"-v": "none",
	"--verbose": "none",
	"-h": "none",
	"--help": "none",
	"-V": "none",
	"--version": "none",
};

const TPUT_OPTIONS: OptionSpec = { "-T": "string", "-V": "none", "-x": "none" };

const LSOF_OPTIONS: OptionSpec = {
	"-?": "none",
	"-h": "none",
	"-v": "none",
	"-a": "none",
	"-b": "none",
	"-C": "none",
	"-l": "none",
	"-n": "none",
	"-N": "none",
	"-O": "none",
	"-P": "none",
	"-Q": "none",
	"-R": "none",
	"-t": "none",
	"-U": "none",
	"-V": "none",
	"-X": "none",
	"-H": "none",
	"-E": "none",
	"-F": "none",
	"-g": "none",
	"-i": "none",
	"-K": "none",
	"-L": "none",
	"-o": "none",
	"-r": "none",
	"-s": "none",
	"-S": "none",
	"-T": "none",
	"-x": "none",
	"-A": "string",
	"-c": "string",
	"-d": "string",
	"-e": "string",
	"-k": "string",
	"-p": "string",
	"-u": "string",
};

const DOCKER_LOG_OPTIONS: OptionSpec = {
	"--follow": "none",
	"-f": "none",
	"--tail": "string",
	"-n": "string",
	"--timestamps": "none",
	"-t": "none",
	"--since": "string",
	"--until": "string",
	"--details": "none",
};
const DOCKER_INSPECT_OPTIONS: OptionSpec = {
	"--format": "string",
	"-f": "string",
	"--type": "string",
	"--size": "none",
	"-s": "none",
};

const GH_JSON_REPO: OptionSpec = { "--json": "string", "--repo": "string", "-R": "string" };
const GH_LIST: OptionSpec = { "--limit": "number", "-L": "number", "--json": "string" };
const GH_ISSUE_SEARCH: OptionSpec = {
	"--app": "string",
	"--assignee": "string",
	"--author": "string",
	"--closed": "string",
	"--commenter": "string",
	"--comments": "string",
	"--created": "string",
	"--include-prs": "none",
	"--interactions": "string",
	"--involves": "string",
	"--json": "string",
	"--label": "string",
	"--language": "string",
	"--limit": "number",
	"-L": "number",
	"--locked": "none",
	"--match": "string",
	"--mentions": "string",
	"--milestone": "string",
	"--no-assignee": "none",
	"--no-label": "none",
	"--no-milestone": "none",
	"--no-project": "none",
	"--order": "string",
	"--owner": "string",
	"--project": "string",
	"--reactions": "string",
	"--repo": "string",
	"-R": "string",
	"--sort": "string",
	"--state": "string",
	"--team-mentions": "string",
	"--updated": "string",
	"--visibility": "string",
};
const GH_COMMAND_OPTIONS: Readonly<Record<string, OptionSpec>> = {
	"pr view": { ...GH_JSON_REPO, "--comments": "none" },
	"pr list": {
		...GH_JSON_REPO,
		"--state": "string",
		"-s": "string",
		"--author": "string",
		"--assignee": "string",
		"--label": "string",
		"--limit": "number",
		"-L": "number",
		"--base": "string",
		"--head": "string",
		"--search": "string",
		"--draft": "none",
		"--app": "string",
	},
	"pr diff": { "--color": "string", "--name-only": "none", "--patch": "none", "--repo": "string", "-R": "string" },
	"pr checks": {
		...GH_JSON_REPO,
		"--watch": "none",
		"--required": "none",
		"--fail-fast": "none",
		"--interval": "number",
	},
	"pr status": { ...GH_JSON_REPO, "--conflict-status": "none", "-c": "none" },
	"issue view": { ...GH_JSON_REPO, "--comments": "none" },
	"issue list": {
		...GH_JSON_REPO,
		"--state": "string",
		"-s": "string",
		"--assignee": "string",
		"--author": "string",
		"--label": "string",
		"--limit": "number",
		"-L": "number",
		"--milestone": "string",
		"--search": "string",
		"--app": "string",
	},
	"issue status": GH_JSON_REPO,
	"repo view": { "--json": "string" },
	"run list": {
		...GH_JSON_REPO,
		"--branch": "string",
		"-b": "string",
		"--status": "string",
		"-s": "string",
		"--workflow": "string",
		"-w": "string",
		"--limit": "number",
		"-L": "number",
		"--event": "string",
		"-e": "string",
		"--user": "string",
		"-u": "string",
		"--created": "string",
		"--commit": "string",
		"-c": "string",
	},
	"run view": {
		...GH_JSON_REPO,
		"--log": "none",
		"--log-failed": "none",
		"--exit-status": "none",
		"--verbose": "none",
		"-v": "none",
		"--job": "string",
		"-j": "string",
		"--attempt": "number",
		"-a": "number",
	},
	"auth status": { "--active": "none", "-a": "none", "--hostname": "string", "-h": "string", "--json": "string" },
	"release list": {
		...GH_LIST,
		"--exclude-drafts": "none",
		"--exclude-pre-releases": "none",
		"--order": "string",
		"-O": "string",
		"--repo": "string",
		"-R": "string",
	},
	"release view": GH_JSON_REPO,
	"workflow list": { ...GH_LIST, "--all": "none", "-a": "none", "--repo": "string", "-R": "string" },
	"workflow view": {
		"--ref": "string",
		"-r": "string",
		"--yaml": "none",
		"-y": "none",
		"--repo": "string",
		"-R": "string",
	},
	"label list": {
		...GH_LIST,
		"--order": "string",
		"--search": "string",
		"-S": "string",
		"--sort": "string",
		"--repo": "string",
		"-R": "string",
	},
	"search repos": {
		...GH_LIST,
		"--archived": "none",
		"--created": "string",
		"--followers": "string",
		"--forks": "string",
		"--good-first-issues": "string",
		"--help-wanted-issues": "string",
		"--include-forks": "string",
		"--language": "string",
		"--license": "string",
		"--match": "string",
		"--number-topics": "string",
		"--order": "string",
		"--owner": "string",
		"--size": "string",
		"--sort": "string",
		"--stars": "string",
		"--topic": "string",
		"--updated": "string",
		"--visibility": "string",
	},
	"search issues": GH_ISSUE_SEARCH,
	"search prs": {
		...GH_ISSUE_SEARCH,
		"--base": "string",
		"-B": "string",
		"--checks": "string",
		"--draft": "none",
		"--head": "string",
		"-H": "string",
		"--merged": "none",
		"--merged-at": "string",
		"--review": "string",
		"--review-requested": "string",
		"--reviewed-by": "string",
	},
	"search commits": {
		...GH_LIST,
		"--author": "string",
		"--author-date": "string",
		"--author-email": "string",
		"--author-name": "string",
		"--committer": "string",
		"--committer-date": "string",
		"--committer-email": "string",
		"--committer-name": "string",
		"--hash": "string",
		"--merge": "none",
		"--order": "string",
		"--owner": "string",
		"--parent": "string",
		"--repo": "string",
		"-R": "string",
		"--sort": "string",
		"--tree": "string",
		"--visibility": "string",
	},
	"search code": {
		...GH_LIST,
		"--extension": "string",
		"--filename": "string",
		"--language": "string",
		"--match": "string",
		"--owner": "string",
		"--repo": "string",
		"-R": "string",
		"--size": "string",
	},
};

const GLOB_SAFE_COMMANDS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"grep",
	"egrep",
	"fgrep",
	"diff",
	"du",
	"df",
	"echo",
	"strings",
	"hexdump",
	"od",
	"nl",
	"cut",
	"column",
	"tr",
	"tac",
	"rev",
	"cmp",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"sha256sum",
	"sha1sum",
	"md5sum",
	"cd",
]);

const GREP_OPTIONS: OptionSpec = {
	"-e": "string",
	"--regexp": "string",
	"-f": "string",
	"--file": "string",
	"-F": "none",
	"--fixed-strings": "none",
	"-G": "none",
	"--basic-regexp": "none",
	"-E": "none",
	"--extended-regexp": "none",
	"-P": "none",
	"--perl-regexp": "none",
	"-i": "none",
	"--ignore-case": "none",
	"--no-ignore-case": "none",
	"-v": "none",
	"--invert-match": "none",
	"-w": "none",
	"--word-regexp": "none",
	"-x": "none",
	"--line-regexp": "none",
	"-c": "none",
	"--count": "none",
	"--color": "string",
	"--colour": "string",
	"-L": "none",
	"--files-without-match": "none",
	"-l": "none",
	"--files-with-matches": "none",
	"-m": "number",
	"--max-count": "number",
	"-o": "none",
	"--only-matching": "none",
	"-q": "none",
	"--quiet": "none",
	"--silent": "none",
	"-s": "none",
	"--no-messages": "none",
	"-b": "none",
	"--byte-offset": "none",
	"-H": "none",
	"--with-filename": "none",
	"-h": "none",
	"--no-filename": "none",
	"--label": "string",
	"-n": "none",
	"--line-number": "none",
	"-T": "none",
	"--initial-tab": "none",
	"-u": "none",
	"--unix-byte-offsets": "none",
	"-Z": "none",
	"--null": "none",
	"-z": "none",
	"--null-data": "none",
	"-A": "number",
	"--after-context": "number",
	"-B": "number",
	"--before-context": "number",
	"-C": "number",
	"--context": "number",
	"--group-separator": "string",
	"--no-group-separator": "none",
	"-a": "none",
	"--text": "none",
	"--binary-files": "string",
	"-I": "none",
	"-D": "string",
	"--devices": "string",
	"-d": "string",
	"--directories": "string",
	"--exclude": "string",
	"--exclude-from": "string",
	"--exclude-dir": "string",
	"--include": "string",
	"-r": "none",
	"--recursive": "none",
	"-R": "none",
	"--dereference-recursive": "none",
	"--line-buffered": "none",
	"-U": "none",
	"--binary": "none",
	"--help": "none",
	"-V": "none",
	"--version": "none",
};

const RG_OPTIONS: OptionSpec = {
	"-e": "string",
	"--regexp": "string",
	"-f": "string",
	"-i": "none",
	"--ignore-case": "none",
	"-S": "none",
	"--smart-case": "none",
	"-F": "none",
	"--fixed-strings": "none",
	"-w": "none",
	"--word-regexp": "none",
	"-v": "none",
	"--invert-match": "none",
	"-c": "none",
	"--count": "none",
	"-l": "none",
	"--files-with-matches": "none",
	"--files-without-match": "none",
	"-n": "none",
	"--line-number": "none",
	"-o": "none",
	"--only-matching": "none",
	"-A": "number",
	"--after-context": "number",
	"-B": "number",
	"--before-context": "number",
	"-C": "number",
	"--context": "number",
	"-H": "none",
	"-h": "none",
	"--heading": "none",
	"--no-heading": "none",
	"-q": "none",
	"--quiet": "none",
	"--column": "none",
	"-g": "string",
	"--glob": "string",
	"-t": "string",
	"--type": "string",
	"-T": "string",
	"--type-not": "string",
	"--type-list": "none",
	"--hidden": "none",
	"--no-ignore": "none",
	"-u": "none",
	"-m": "number",
	"--max-count": "number",
	"-d": "number",
	"--max-depth": "number",
	"-a": "none",
	"--text": "none",
	"-L": "none",
	"--follow": "none",
	"--color": "string",
	"--json": "none",
	"--stats": "none",
	"--help": "none",
	"--version": "none",
	"--debug": "none",
};

const SORT_OPTIONS: OptionSpec = {
	"-b": "none",
	"--ignore-leading-blanks": "none",
	"-d": "none",
	"--dictionary-order": "none",
	"-f": "none",
	"--ignore-case": "none",
	"-g": "none",
	"--general-numeric-sort": "none",
	"-h": "none",
	"--human-numeric-sort": "none",
	"-i": "none",
	"--ignore-nonprinting": "none",
	"-M": "none",
	"--month-sort": "none",
	"-n": "none",
	"--numeric-sort": "none",
	"-R": "none",
	"--random-sort": "none",
	"-r": "none",
	"--reverse": "none",
	"--sort": "string",
	"-s": "none",
	"--stable": "none",
	"-u": "none",
	"--unique": "none",
	"-V": "none",
	"--version-sort": "none",
	"-z": "none",
	"--zero-terminated": "none",
	"-k": "string",
	"--key": "string",
	"-t": "string",
	"--field-separator": "string",
	"-c": "none",
	"--check": "none",
	"-C": "none",
	"--check-char-order": "none",
	"-m": "none",
	"--merge": "none",
	"-S": "string",
	"--buffer-size": "string",
	"--parallel": "number",
	"--batch-size": "number",
	"--help": "none",
	"--version": "none",
};

const FILE_OPTIONS: OptionSpec = {
	"-b": "none",
	"--brief": "none",
	"-i": "none",
	"--mime": "none",
	"--mime-type": "none",
	"--mime-encoding": "none",
	"--apple": "none",
	"--check-encoding": "none",
	"-c": "none",
	"--exclude": "string",
	"--exclude-quiet": "string",
	"-0": "none",
	"--print0": "none",
	"-F": "string",
	"--separator": "string",
	"--help": "none",
	"--version": "none",
	"-v": "none",
	"-h": "none",
	"--no-dereference": "none",
	"-L": "none",
	"--dereference": "none",
	"-k": "none",
	"--keep-going": "none",
	"-l": "none",
	"--list": "none",
	"-n": "none",
	"--no-buffer": "none",
	"-p": "none",
	"--preserve-date": "none",
	"-r": "none",
	"--raw": "none",
	"-s": "none",
	"--special-files": "none",
};

const SED_OPTIONS: OptionSpec = {
	"-e": "string",
	"--expression": "string",
	"-n": "none",
	"--quiet": "none",
	"--silent": "none",
	"-E": "none",
	"--regexp-extended": "none",
	"-r": "none",
	"--posix": "none",
	"-l": "number",
	"--line-length": "number",
	"-z": "none",
	"--zero-terminated": "none",
	"-s": "none",
	"--separate": "none",
	"-u": "none",
	"--unbuffered": "none",
	"--debug": "none",
	"--help": "none",
	"--version": "none",
};

const COMMON_FILE_OPTIONS: Readonly<Record<string, { spec: OptionSpec; fileOptions?: string[] }>> = {
	cat: {
		spec: {
			"-A": "none",
			"--show-all": "none",
			"-b": "none",
			"--number-nonblank": "none",
			"-e": "none",
			"-E": "none",
			"--show-ends": "none",
			"-n": "none",
			"--number": "none",
			"-s": "none",
			"--squeeze-blank": "none",
			"-t": "none",
			"-T": "none",
			"--show-tabs": "none",
			"-u": "none",
			"--help": "none",
			"--version": "none",
		},
	},
	head: {
		spec: {
			"-c": "string",
			"--bytes": "string",
			"-n": "string",
			"--lines": "string",
			"-q": "none",
			"--quiet": "none",
			"--silent": "none",
			"-v": "none",
			"--verbose": "none",
			"-z": "none",
			"--zero-terminated": "none",
			"--help": "none",
			"--version": "none",
		},
	},
	tail: {
		spec: {
			"-c": "string",
			"--bytes": "string",
			"-n": "string",
			"--lines": "string",
			"-q": "none",
			"--quiet": "none",
			"--silent": "none",
			"-v": "none",
			"--verbose": "none",
			"-z": "none",
			"--zero-terminated": "none",
			"-f": "none",
			"--follow": "string",
			"--retry": "none",
			"--pid": "number",
			"--sleep-interval": "string",
			"--max-unchanged-stats": "number",
			"--help": "none",
			"--version": "none",
		},
	},
	wc: {
		spec: {
			"-c": "none",
			"--bytes": "none",
			"-m": "none",
			"--chars": "none",
			"-l": "none",
			"--lines": "none",
			"-L": "none",
			"--max-line-length": "none",
			"-w": "none",
			"--words": "none",
			"--files0-from": "string",
			"--help": "none",
			"--version": "none",
		},
		fileOptions: ["--files0-from"],
	},
	stat: {
		spec: {
			"-L": "none",
			"--dereference": "none",
			"-f": "none",
			"--file-system": "none",
			"-c": "string",
			"--format": "string",
			"--printf": "string",
			"-t": "none",
			"--terse": "none",
			"--help": "none",
			"--version": "none",
		},
	},
};

const XARGS_OPTIONS: OptionSpec = {
	"-I": "braces",
	"--replace": "braces",
	"-n": "number",
	"--max-args": "number",
	"-L": "number",
	"--max-lines": "number",
	"-P": "number",
	"--max-procs": "number",
	"-s": "number",
	"--max-chars": "number",
	"-E": "eof",
	"--eof": "eof",
	"-0": "none",
	"--null": "none",
	"-r": "none",
	"--no-run-if-empty": "none",
	"-d": "char",
	"--delimiter": "char",
	"-t": "none",
	"--verbose": "none",
	"-x": "none",
	"--exit": "none",
};

const HASH_OPTIONS: OptionSpec = {
	"-b": "none",
	"--binary": "none",
	"--text": "none",
	"-c": "none",
	"--check": "none",
	"--tag": "none",
	"-t": "none",
	"-z": "none",
	"--zero": "none",
	"--ignore-missing": "none",
	"--quiet": "none",
	"--status": "none",
	"--strict": "none",
	"-w": "none",
	"--warn": "none",
	"--help": "none",
	"--version": "none",
};

const AKI_OPTIONS: OptionSpec = {
	"-h": "none",
	"--help": "none",
	"-k": "none",
	"--keyword": "none",
	"-s": "none",
	"--semantic": "none",
	"--no-adaptive": "none",
	"-n": "number",
	"--limit": "number",
	"-o": "number",
	"--offset": "number",
	"--source": "string",
	"--exclude-source": "string",
	"-a": "string",
	"--after": "string",
	"-b": "string",
	"--before": "string",
	"--collection": "string",
	"--drive": "string",
	"--folder": "string",
	"--descendants": "none",
	"-m": "string",
	"--meta": "string",
	"-t": "string",
	"--threshold": "string",
	"--kw-weight": "string",
	"--sem-weight": "string",
	"-j": "none",
	"--json": "none",
	"-c": "none",
	"--chunk": "none",
	"--preview": "none",
	"-d": "none",
	"--full-doc": "none",
	"-v": "none",
	"--verbose": "none",
	"--stats": "none",
	"-S": "number",
	"--summarize": "number",
	"--explain": "none",
	"--examine": "string",
	"--url": "string",
	"--multi-turn": "number",
	"--multi-turn-model": "string",
	"--multi-turn-context": "string",
	"--no-rerank": "none",
	"--audit": "none",
	"--local": "none",
	"--staging": "none",
};

const WRAPPERS = new Set(["command", "builtin", "noglob", "time", "nohup", "timeout", "nice", "stdbuf", "env"]);

const TPUT_MUTATING_CAPABILITIES = new Set([
	"init",
	"reset",
	"rs1",
	"rs2",
	"rs3",
	"is1",
	"is2",
	"is3",
	"iprog",
	"if",
	"rf",
	"clear",
	"flash",
	"mc0",
	"mc4",
	"mc5",
	"mc5i",
	"mc5p",
	"pfkey",
	"pfloc",
	"pfx",
	"pfxl",
	"smcup",
	"rmcup",
]);
const MAN_SEARCH_OPTIONS = new Set(["-k", "-f", "--apropos", "--whatis"]);
const MAN_SECTION_OPTIONS = new Set(["-S", "-s"]);
const TEST_FILE_OPERATORS = new Set([
	"-b",
	"-c",
	"-d",
	"-e",
	"-f",
	"-g",
	"-h",
	"-k",
	"-L",
	"-N",
	"-O",
	"-p",
	"-r",
	"-s",
	"-S",
	"-u",
	"-w",
	"-x",
	"-nt",
	"-ot",
	"-ef",
]);
const NON_PATH_DIRECT_COMMANDS = new Set([
	"id",
	"uname",
	"free",
	"locale",
	"groups",
	"nproc",
	"true",
	"false",
	"sleep",
	"which",
	"type",
	"expr",
	"seq",
	"cal",
]);

function fail(reason: string, commands: BashCommandInfo[] = []): BashReadOnlyDecision {
	return { readOnly: false, reason, commands };
}

function containsType(node: Parser.SyntaxNode, types: ReadonlySet<string>): boolean {
	return types.has(node.type) || node.namedChildren.some((child) => containsType(child, types));
}

function containsBackgroundOperator(node: Parser.SyntaxNode): boolean {
	if (node.type === "&" || node.text === "&") return true;
	return node.children.some(containsBackgroundOperator);
}

const DYNAMIC_VALUE_NODE_TYPES = new Set([
	"command_substitution",
	"process_substitution",
	"simple_expansion",
	"expansion",
	"arithmetic_expansion",
	"brace_expression",
]);
const ARGUMENT_NODE_TYPES = new Set(["command_name", "word", "number", "raw_string", "string", "concatenation"]);

function staticValue(node: Parser.SyntaxNode): string | null {
	if (containsType(node, DYNAMIC_VALUE_NODE_TYPES)) return null;
	const raw = node.text;
	if (node.type === "ansi_c_string" || node.type === "translated_string") return null;
	if (node.type === "command_name" || node.type === "concatenation") {
		const values = node.namedChildren.map(staticValue);
		return values.every((value): value is string => value !== null) ? values.join("") : null;
	}
	if (node.type === "raw_string") return raw.length >= 2 ? raw.slice(1, -1) : "";
	if (node.type === "string") {
		if (raw.length < 2) return "";
		return raw
			.slice(1, -1)
			.replace(/\\([\\"$`])/g, "$1")
			.replace(/\\\n/g, "");
	}
	if (node.type === "word") {
		if (raw.startsWith("~")) return null;
		return raw.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
	}
	return raw;
}

function hasUnquotedGlob(node: Parser.SyntaxNode): boolean {
	// A concatenation may contain both unquoted `word` nodes and quoted
	// `raw_string`/`string` siblings. Only the unquoted fragment participates
	// in pathname expansion, so a quoted sibling must not hide its glob.
	return (node.type === "word" && /[*?[]/.test(node.text)) || node.namedChildren.some(hasUnquotedGlob);
}

function assignment(node: Parser.SyntaxNode): { name: string; value: string } | null {
	const nameNode = node.childForFieldName("name");
	const name = (nameNode?.type === "subscript" ? nameNode.childForFieldName("name") : nameNode)?.text;
	const valueNode = node.childForFieldName("value");
	if (!name) return null;
	if (!valueNode) return { name, value: "" };
	const value = staticValue(valueNode);
	return value === null ? null : { name, value };
}

function normalizeTestCommand(node: Parser.SyntaxNode): NormalizedCommand | null {
	const argv = [node.text.startsWith("[[") ? "[[" : "["];
	const visit = (current: Parser.SyntaxNode): boolean => {
		if (current.namedChildCount === 0) {
			if (!["word", "number", "raw_string", "string", "test_operator"].includes(current.type)) return true;
			const value = staticValue(current);
			if (value === null) return false;
			argv.push(value);
			return true;
		}
		return current.namedChildren.every(visit);
	};
	if (!node.namedChildren.every(visit)) return null;
	return { argv, env: {}, redirects: [], hasGlob: hasUnquotedGlob(node) };
}

function normalizeCommand(node: Parser.SyntaxNode): NormalizedCommand | null {
	const env: Record<string, string> = {};
	const argv: string[] = [];
	let previousEnd: number | undefined;
	for (const child of node.namedChildren) {
		if (child.type === "variable_assignment") {
			const parsed = assignment(child);
			if (!parsed) return null;
			env[parsed.name] = parsed.value;
			continue;
		}
		if (ARGUMENT_NODE_TYPES.has(child.type)) {
			const value = staticValue(child);
			if (value === null) return null;
			const gap =
				previousEnd === undefined
					? ""
					: node.text.slice(previousEnd - node.startIndex, child.startIndex - node.startIndex);
			if (/^(?:\\\n)+$/.test(gap)) argv[argv.length - 1] += value;
			else argv.push(value);
			previousEnd = child.endIndex;
		}
	}
	if (argv.length === 0) return null;
	return { argv, env, redirects: [], hasGlob: hasUnquotedGlob(node) };
}

/** Parse one literal command without assignments, redirects, or shell expansion. */
export function parseStaticBashCommand(command: string): string[] | null {
	let tree: Parser.Tree;
	try {
		tree = bashParser().parse(command);
	} catch {
		return null;
	}
	if (tree.rootNode.hasError || containsBackgroundOperator(tree.rootNode)) return null;
	const nodes = tree.rootNode.namedChildren.filter((node) => node.type !== "comment");
	if (nodes.length !== 1 || nodes[0]?.type !== "command") return null;
	const node = nodes[0];
	if (node.namedChildren.some((child) => !ARGUMENT_NODE_TYPES.has(child.type))) return null;
	return normalizeCommand(node)?.argv ?? null;
}

const UNSUPPORTED_SHELL_NODE_TYPES = new Set([
	"subshell",
	"compound_statement",
	"function_definition",
	"command_substitution",
	"simple_expansion",
	"expansion",
	"arithmetic_expansion",
	"process_substitution",
	"if_statement",
	"while_statement",
	"until_statement",
	"for_statement",
	"c_style_for_statement",
	"case_statement",
]);

function collectCommands(root: Parser.SyntaxNode): NormalizedCommand[] | null {
	if (root.hasError || containsType(root, UNSUPPORTED_SHELL_NODE_TYPES)) return null;
	const commands: NormalizedCommand[] = [];
	const visit = (node: Parser.SyntaxNode, inheritedRedirects: NormalizedCommand["redirects"] = []): boolean => {
		if (node.type === "redirected_statement") {
			const redirects = [...inheritedRedirects];
			for (const child of node.namedChildren) {
				if (!child.type.endsWith("_redirect")) continue;
				const op =
					child.children.find((part) => !part.isNamed)?.text ??
					child.text.match(/^(?:\d*)(<<<?|>>?|<|>&|<&|&>>?)/)?.[1] ??
					"";
				const destination = child.childForFieldName("destination") ?? child.namedChildren.at(-1);
				const target = destination ? staticValue(destination) : "";
				if (target === null) return false;
				redirects.push({ op, target, literal: true });
			}
			const body =
				node.childForFieldName("body") ?? node.namedChildren.find((child) => !child.type.endsWith("_redirect"));
			return body ? visit(body, redirects) : false;
		}
		if (node.type === "variable_assignment") {
			const parsed = assignment(node);
			if (!parsed) return false;
			// Bash's internal shell state may be absent from process.env. Reject it
			// explicitly, including array elements that can remap approved commands.
			if (SPECIAL_SHELL_VARIABLES.has(parsed.name)) return false;
			if (!SAFE_ENV.has(parsed.name) && Object.hasOwn(process.env, parsed.name)) return false;
			return true;
		}
		if (node.type === "test_command" || node.type === "command") {
			const command = node.type === "test_command" ? normalizeTestCommand(node) : normalizeCommand(node);
			if (!command) return false;
			command.redirects.push(...inheritedRedirects);
			commands.push(command);
			return true;
		}
		for (const child of node.namedChildren) if (!visit(child, inheritedRedirects)) return false;
		return true;
	};
	return visit(root) ? commands : null;
}

function validValue(kind: ValueKind, value: string): boolean {
	if (value.includes("__CMDSUB_OUTPUT__") || value.includes("__TRACKED_VAR__")) return false;
	switch (kind) {
		case "none":
			return value === "";
		case "number":
			return /^\d+$/.test(value);
		case "char":
			return [...value].length === 1;
		case "braces":
			return value.length > 0;
		case "eof":
			return value === "EOF";
		case "string":
			return value.length > 0 && !value.startsWith("-");
	}
}

function parseOptions(
	args: string[],
	spec: OptionSpec,
	options?: { gitCounts?: boolean; stopAtPositional?: boolean },
): ParsedOptions | null {
	const positionals: string[] = [];
	const occurrences = new Map<string, string[]>();
	let parsing = true;
	const record = (name: string, value: string) => occurrences.set(name, [...(occurrences.get(name) ?? []), value]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (parsing && arg === "--") {
			parsing = false;
			continue;
		}
		if (!parsing || arg === "-" || !arg.startsWith("-")) {
			positionals.push(arg);
			if (options?.stopAtPositional) parsing = false;
			continue;
		}
		if (options?.gitCounts && /^-\d+$/.test(arg)) {
			record("-n", arg.slice(1));
			continue;
		}
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const name = equals >= 0 ? arg.slice(0, equals) : arg;
			const kind = spec[name];
			if (!kind) return null;
			if (kind === "none") {
				if (equals >= 0) return null;
				record(name, "");
				continue;
			}
			const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
			if (value === undefined || !validValue(kind, value)) return null;
			record(name, value);
			continue;
		}
		let cursor = 1;
		while (cursor < arg.length) {
			const name = `-${arg[cursor]}`;
			const kind = spec[name];
			if (!kind) return null;
			if (kind === "none") {
				record(name, "");
				cursor++;
				continue;
			}
			const attached = arg.slice(cursor + 1);
			const value = attached || args[++index];
			if (value === undefined || !validValue(kind, value)) return null;
			record(name, value);
			cursor = arg.length;
		}
	}
	return { positionals, occurrences };
}

function optionValues(parsed: ParsedOptions, names: string[]): string[] {
	return names.flatMap((name) => parsed.occurrences.get(name) ?? []);
}

function path(value: string, source: BashPathIntent["source"], access: BashPathAccess = "read"): BashPathIntent {
	return { value, source, access, glob: /[*?[]/.test(value) };
}

function splitEnvString(value: string): string[] | null {
	const result: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let started = false;
	for (const character of value) {
		if (escaped) {
			current += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) result.push(current);
			current = "";
			started = false;
			continue;
		}
		current += character;
		started = true;
	}
	if (escaped || quote) return null;
	if (started) result.push(current);
	return result;
}

function stripWrappers(argv: string[]): {
	argv: string[];
	workingDirectoryIntents: BashPathIntent[];
} | null {
	let current = [...argv];
	const workingDirectoryIntents: BashPathIntent[] = [];
	for (;;) {
		const name = current[0];
		if (!name || !WRAPPERS.has(name)) return { argv: current, workingDirectoryIntents };
		current = current.slice(1);
		if (name === "command") while (current[0] === "-p") current.shift();
		else if (name === "timeout") {
			while (current[0]?.startsWith("-")) {
				if (current[0] === "--") {
					current.shift();
					break;
				}
				if (["-k", "--kill-after", "-s", "--signal"].includes(current[0] ?? "")) current.splice(0, 2);
				else current.shift();
			}
			if (!/^\d+(?:\.\d+)?[smhd]?$/.test(current[0] ?? "")) return null;
			current.shift();
		} else if (name === "nice") {
			if (current[0] === "-n" && /^-?\d+$/.test(current[1] ?? "")) current.splice(0, 2);
			else if (/^-\d+$/.test(current[0] ?? "")) current.shift();
		} else if (name === "stdbuf") {
			let consumed = false;
			while (/^-[ioe](?:.+)?$/.test(current[0] ?? "") || /^--(?:input|output|error)=.+/.test(current[0] ?? "")) {
				consumed = true;
				if (/^-[ioe]$/.test(current[0] ?? "")) current.splice(0, 2);
				else current.shift();
			}
			if (!consumed) return null;
		} else if (name === "env") {
			while (current[0]?.startsWith("-")) {
				const option = current[0] ?? "";
				if (option === "--") {
					current.shift();
					break;
				}
				if (["-u", "--unset"].includes(option)) {
					if (!current[1] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(current[1] ?? "")) return null;
					current.splice(0, 2);
					continue;
				}
				if (["-C", "--chdir"].includes(option)) {
					const directory = current[1];
					if (!directory) return null;
					workingDirectoryIntents.push(path(directory, "option", "cwd"));
					current.splice(0, 2);
					continue;
				}
				if (option.startsWith("-C") && option.length > 2) {
					workingDirectoryIntents.push(path(option.slice(2), "option", "cwd"));
					current.shift();
					continue;
				}
				if (option.startsWith("--chdir=")) {
					const directory = option.slice("--chdir=".length);
					if (!directory) return null;
					workingDirectoryIntents.push(path(directory, "option", "cwd"));
					current.shift();
					continue;
				}
				if (
					["-S", "--split-string"].includes(option) ||
					(option.startsWith("-S") && option.length > 2) ||
					option.startsWith("--split-string=")
				) {
					const attached = option.startsWith("-S") && option.length > 2 ? option.slice(2) : undefined;
					const value = attached ?? (option.includes("=") ? option.slice(option.indexOf("=") + 1) : current[1]);
					if (value === undefined || /[$#\\]/.test(value)) return null;
					const split = splitEnvString(value);
					if (!split || split.length === 0) return null;
					current.splice(0, attached !== undefined || option.includes("=") ? 1 : 2, ...split);
					break;
				}
				if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(option)) {
					current.shift();
					continue;
				}
				return null;
			}
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? "")) {
				const variable = current[0]?.slice(0, current[0].indexOf("="));
				if (!variable || !SAFE_ENV.has(variable)) return null;
				current.shift();
			}
		}
		if (current[0] === "--") current.shift();
	}
}

function dangerousGhArgument(value: string): boolean {
	if (value.includes("~") || value.includes("://") || value.includes("@")) return true;
	return (value.match(/\//g) ?? []).length >= 2;
}

const SED_PRINTING_FLAGS = new Set([
	"-n",
	"--quiet",
	"--silent",
	"-E",
	"--regexp-extended",
	"-r",
	"-z",
	"--zero-terminated",
	"--posix",
]);
const SED_SUBSTITUTION_FLAGS = new Set(["-E", "--regexp-extended", "-r", "--posix"]);

function safeSedScripts(scripts: string[], parsed: ParsedOptions, quiet: boolean, hasFiles: boolean): boolean {
	if (scripts.length === 0) return false;
	const flags = [...parsed.occurrences.keys()];
	if (quiet && flags.every((flag) => SED_PRINTING_FLAGS.has(flag)))
		return scripts.every((script) => script.split(";").every((part) => /^(?:\d+|\d+,\d+)?p$/.test(part.trim())));
	if (hasFiles || scripts.length !== 1 || !flags.every((flag) => SED_SUBSTITUTION_FLAGS.has(flag))) return false;
	const script = scripts[0]?.trim() ?? "";
	if (!script.startsWith("s/") || /[\r\n;{}]/.test(script)) return false;
	if ([...script].some((character) => character.charCodeAt(0) === 0 || character.charCodeAt(0) > 127)) return false;
	const comment = script.indexOf("#");
	if (comment >= 0 && !(comment > 0 && script[comment - 1] === "s")) return false;
	if (/s\\|\\[|#%@]|\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d|[/\d$]!/.test(script)) return false;
	if (!/^s\/[^/]*\/[^/]*\/[^/]*$/.test(script) || /\/[^/]*\s+[wWeE]/.test(script)) return false;
	let delimiters = 0;
	let lastDelimiter = -1;
	for (let index = 2; index < script.length; index++) {
		if (script[index] === "\\") {
			index++;
			continue;
		}
		if (script[index] === "/") {
			delimiters++;
			lastDelimiter = index;
		}
	}
	return delimiters === 2 && /^[gpimIM]*[1-9]?[gpimIM]*$/.test(script.slice(lastDelimiter + 1));
}

function safePrintf(args: string[], unknownOperands = false): boolean {
	let index = 0;
	if (args[0] === "--") index++;
	else if (args[0]?.startsWith("-")) return false;
	const format = args[index++];
	if (format === undefined || format.includes("$") || /\\[uU]|%[^%a-zA-Z]*[lLhqjzZt]*\\[0-7xX]/.test(format))
		return false;
	const withoutEscapedPercents = format.replaceAll("%%", "");
	const evaluatesNumbers =
		/%[-+ 0#']*[0-9.*]*[lLhqjzZt]*[diouxXeEfFgGaAn]/.test(withoutEscapedPercents) ||
		/%[^%a-zA-Z]*\*/.test(withoutEscapedPercents);
	if (!evaluatesNumbers) return true;
	if (unknownOperands) return false;
	const numeric = /^[-+]?(?:0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)$/;
	return args
		.slice(index)
		.every((value) => !value.includes("[") && !value.includes("`") && !value.includes("$(") && numeric.test(value));
}

const PASSIVE_GIT_SUBCOMMANDS = new Set([
	"diff",
	"log",
	"show",
	"shortlog",
	"status",
	"blame",
	"ls-files",
	"merge-base",
	"rev-parse",
	"rev-list",
	"describe",
	"cat-file",
	"for-each-ref",
	"grep",
	"show-ref",
	"name-rev",
	"ls-tree",
]);

function gitResult(ok: boolean): { ok: boolean; positionals: string[]; paths: BashPathIntent[] } {
	return { ok, positionals: [], paths: [] };
}

function classifyGit(argv: string[]): { ok: boolean; positionals: string[]; paths: BashPathIntent[] } {
	const sub = argv[1];
	if (
		!sub ||
		argv
			.slice(1)
			.some(
				(value) =>
					value === "-c" ||
					value.startsWith("--config-env") ||
					value.startsWith("--exec-path") ||
					value === "--show-signature" ||
					["--exec", "--ext-diff", "--textconv", "--contents", "--output", "--filters", "--open-files-in-pager"].some(
						(flag) => value === flag || value.startsWith(`${flag}=`),
					) ||
					/%G[a-zA-Z]?/.test(value) ||
					/signature/i.test(value),
			)
	)
		return gitResult(false);
	if (PASSIVE_GIT_SUBCOMMANDS.has(sub)) {
		const paths: BashPathIntent[] = [];
		for (let index = 2; index < argv.length; index++) {
			const value = argv[index] ?? "";
			if (["-O", "--order-file", "--exclude-from"].includes(value)) {
				const operand = argv[++index];
				if (!operand) return gitResult(false);
				paths.push(path(operand, "option"));
			} else if (value.startsWith("--order-file=") || value.startsWith("--exclude-from="))
				paths.push(path(value.slice(value.indexOf("=") + 1), "option"));
		}
		const separator = argv.indexOf("--", 2);
		const values = separator >= 0 ? argv.slice(separator + 1) : [];
		if (sub === "diff" && argv.includes("--no-index")) {
			const noIndexPaths = argv.slice(2).filter((value) => !value.startsWith("-"));
			paths.push(...noIndexPaths.map((value) => path(value, "argument")));
		} else if (sub === "grep" && argv.includes("--no-index")) {
			const noIndexOperands = argv.slice(2).filter((value) => !value.startsWith("-"));
			paths.push(...noIndexOperands.slice(1).map((value) => path(value, "argument")));
		} else paths.push(...values.map((value) => path(value, "argument")));
		return { ok: true, positionals: values, paths };
	}
	if (sub === "config" && argv[2] === "--get") {
		const parsed = parseOptions(argv.slice(3), {
			"--local": "none",
			"--global": "none",
			"--system": "none",
			"--worktree": "none",
			"--default": "string",
			"--type": "string",
			"--bool": "none",
			"--int": "none",
			"--bool-or-int": "none",
			"--path": "none",
			"--expiry-date": "none",
			"-z": "none",
			"--null": "none",
			"--name-only": "none",
			"--show-origin": "none",
			"--show-scope": "none",
		});
		return gitResult(!!parsed && parsed.positionals.length === 1);
	}
	if (sub === "remote") {
		if (argv[2] === "show")
			return gitResult(argv.includes("-n") && argv.filter((value) => !value.startsWith("-")).length === 4);
		return gitResult(argv.slice(2).every((value) => value === "-v" || value === "--verbose"));
	}
	if (sub === "reflog")
		return gitResult(!argv.slice(2).some((value) => ["expire", "delete", "drop", "write"].includes(value)));
	if (sub === "stash") return gitResult(argv[2] === "list" || argv[2] === "show");
	if (sub === "worktree") return gitResult(argv[2] === "list");
	if (sub === "tag" || sub === "branch") {
		const shared: OptionSpec = {
			"-l": "none",
			"--list": "none",
			"--contains": "string",
			"--no-contains": "string",
			"--merged": sub === "tag" ? "string" : "none",
			"--no-merged": sub === "tag" ? "string" : "none",
			"--sort": "string",
			"--points-at": "string",
			"--column": "none",
			"--no-column": "none",
			"-i": "none",
			"--ignore-case": "none",
		};
		const parsed = parseOptions(
			argv.slice(2),
			sub === "tag"
				? { ...shared, "-n": "number", "--format": "string" }
				: {
						...shared,
						"-a": "none",
						"--all": "none",
						"-r": "none",
						"--remotes": "none",
						"-v": "none",
						"-vv": "none",
						"--verbose": "none",
						"--color": "none",
						"--no-color": "none",
						"--abbrev": "number",
						"--no-abbrev": "none",
						"--show-current": "none",
					},
		);
		if (!parsed) return gitResult(false);
		const lists = parsed.occurrences.has("-l") || parsed.occurrences.has("--list");
		const merged = parsed.occurrences.has("--merged") || parsed.occurrences.has("--no-merged");
		const unsafeFormat = optionValues(parsed, ["--format", "--sort"]).some(
			(value) => value.includes("%") || value.includes("$") || value.includes("`"),
		);
		return gitResult(!unsafeFormat && (parsed.positionals.length === 0 || lists || (sub === "branch" && merged)));
	}
	if (sub === "ls-remote") {
		if (argv.some((value) => value.startsWith("--server-option") || value === "-o")) return gitResult(false);
		const parsed = parseOptions(argv.slice(2), {
			"--branches": "none",
			"-b": "none",
			"--tags": "none",
			"-t": "none",
			"--heads": "none",
			"-h": "none",
			"--refs": "none",
			"--quiet": "none",
			"-q": "none",
			"--exit-code": "none",
			"--get-url": "none",
			"--symref": "none",
			"--sort": "string",
		});
		return gitResult(!!parsed && parsed.positionals.length === 0);
	}
	return gitResult(false);
}

function classifyCommand(command: NormalizedCommand, platform: NodeJS.Platform): BashCommandInfo | null {
	if (Object.keys(command.env).some((name) => !SAFE_ENV.has(name))) return null;
	for (const redirect of command.redirects) {
		if (/^\/dev\/(?:tcp|udp)\//.test(redirect.target)) return null;
		if (["<", "<<", "<<<", "<&"].includes(redirect.op)) continue;
		if ([">", ">>"].includes(redirect.op) && redirect.target === "/dev/null") continue;
		if (redirect.op === ">&" && /^\d+$/.test(redirect.target)) continue;
		return null;
	}
	const wrapper = stripWrappers(command.argv);
	if (!wrapper) return null;
	const { argv } = wrapper;
	const name = argv[0];
	if (!name) return null;
	const args = argv.slice(1);
	const intents: BashPathIntent[] = command.redirects
		.filter((redirect) => redirect.op === "<" && redirect.target)
		.map((redirect) => path(redirect.target, "redirect"));

	const info: BashCommandInfo = {
		name,
		argv,
		env: command.env,
		pathIntents: intents,
		hasGlob: false,
	};
	if (wrapper.workingDirectoryIntents.length > 0) info.workingDirectoryIntents = wrapper.workingDirectoryIntents;
	if (command.hasGlob && !GLOB_SAFE_COMMANDS.has(name)) return null;
	if (command.hasGlob)
		intents.push(...args.filter((value) => /[*?[]/.test(value)).map((value) => path(value, "argument")));
	if (["pwd", "whoami", "alias"].includes(name)) {
		if (args.length !== 0) return null;
		return info;
	}
	if (name === "echo" || name === "ls") {
		if (name === "ls")
			intents.push(...args.filter((value) => !value.startsWith("-")).map((value) => path(value, "argument")));
		return info;
	}
	if (name === "cd") {
		if (args.length > 1) return null;
		if (args[0] !== undefined) intents.push(path(args[0], "argument", "cwd"));
		return { ...info, hasGlob: command.hasGlob };
	}
	if (name === "python" || name === "python3") return args.length === 1 && args[0] === "--version" ? info : null;
	if (name === "node") return args.length === 1 && ["-v", "--version"].includes(args[0] ?? "") ? info : null;
	if (name === "claude") return args.length === 1 && ["-h", "--help"].includes(args[0] ?? "") ? info : null;
	if (name === "ip") return args.length === 1 && args[0] === "addr" ? info : null;
	if (name === "history") return args.length === 0 || (args.length === 1 && /^\d+$/.test(args[0] ?? "")) ? info : null;
	if (name === "arch")
		return args.length === 0 || (args.length === 1 && ["-h", "--help"].includes(args[0] ?? "")) ? info : null;
	if (name === "ifconfig")
		return args.length === 0 || (args.length === 1 && /^[a-zA-Z]/.test(args[0] ?? "")) ? info : null;
	if (name === "printf") return safePrintf(args) ? info : null;
	if (name === "date") {
		const parsed = parseOptions(args, DATE_OPTIONS);
		if (!parsed || parsed.positionals.some((value) => !value.startsWith("+"))) return null;
		intents.push(...optionValues(parsed, ["-r", "--reference"]).map((value) => path(value, "option")));
		return info;
	}
	if (name === "hostname") {
		const parsed = parseOptions(args, HOSTNAME_OPTIONS);
		return parsed && parsed.positionals.length === 0 ? info : null;
	}
	if (name === "ps") {
		const parsed = parseOptions(args, PS_OPTIONS);
		if (!parsed || parsed.positionals.length > 0) return null;
		const clusteredEnvironmentFlag = args.some((value) => /^-[a-zA-Z]*e/.test(value));
		const ordinaryCluster = args.every((value) => value === "--forest" || /^-[AacdeFfjlwHLTm]+$/.test(value));
		const modifiers = args.flatMap((value) => (value === "--forest" ? [value] : (value.match(/[HLTm]/g) ?? [])));
		if (clusteredEnvironmentFlag && !(ordinaryCluster && modifiers.length <= 1)) return null;
		return info;
	}
	const processOptions = PROCESS_COMMAND_OPTIONS[name];
	if (processOptions) {
		const parsed = parseOptions(args, processOptions);
		if (!parsed) return null;
		if (name === "ss") {
			const keyword =
				/^(?:dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
			const takesOperand = /^(?:state|exclude|dport|sport|dev|fwmark|cgroup)$/;
			const tokens = parsed.positionals
				.join(" ")
				.split(/[\s()=!<>&|,]+/)
				.filter(Boolean);
			let operand = false;
			for (const token of tokens) {
				if (operand) {
					operand = false;
					continue;
				}
				if (keyword.test(token)) {
					operand = takesOperand.test(token);
					continue;
				}
				if (/[g-zG-Z]/.test(token) || (/[a-fA-F]/.test(token) && (token.includes(".") || !token.includes(":"))))
					return null;
			}
		}
		if (name === "pgrep") {
			if (parsed.positionals.length !== 1) return null;
			intents.push(...optionValues(parsed, ["-F", "--pidfile"]).map((value) => path(value, "option")));
		} else if (name !== "ss" && parsed.positionals.length > 0) return null;
		return info;
	}
	if (name === "lsof") {
		const parsed = parseOptions(args, LSOF_OPTIONS);
		if (
			!parsed ||
			args.some(
				(value, index) =>
					value.startsWith("+m") ||
					(/^-[a-zA-Z]*i\S*@/.test(value) &&
						/[a-zA-Z]/.test(value.slice(value.indexOf("@") + 1).split(":")[0] ?? "")) ||
					(/^-[a-zA-Z]*i$/.test(value) &&
						((args[index + 1] ?? "").includes("~") ||
							((args[index + 1] ?? "").includes("@") &&
								/[a-zA-Z]/.test(
									(args[index + 1] ?? "").slice((args[index + 1] ?? "").indexOf("@") + 1).split(":")[0] ?? "",
								)))),
			)
		)
			return null;
		intents.push(...optionValues(parsed, ["-A"]).map((value) => path(value, "option")));
		return info;
	}
	if (name === "tput") {
		const parsed = parseOptions(args, TPUT_OPTIONS);
		if (
			!parsed ||
			parsed.positionals.length === 0 ||
			parsed.positionals.some((value) => TPUT_MUTATING_CAPABILITIES.has(value))
		)
			return null;
		return info;
	}
	if (name === "base64" || name === "tree") {
		const commandOptions = PATH_COMMAND_OPTIONS[name];
		if (!commandOptions) return null;
		const parsed = parseOptions(args, commandOptions);
		if (!parsed) return null;
		intents.push(...parsed.positionals.map((value) => path(value, "argument")));
		if (name === "base64")
			intents.push(...optionValues(parsed, ["-i", "--input"]).map((value) => path(value, "option")));
		else intents.push(...optionValues(parsed, ["--gitfile", "--infofile"]).map((value) => path(value, "option")));
		return info;
	}
	if (name === "fd" || name === "fdfind") {
		const parsed = parseOptions(args, FD_OPTIONS);
		if (!parsed) return null;
		const roots = parsed.positionals.slice(1);
		intents.push(...roots.map((value) => path(value, "argument")));
		intents.push(
			...optionValues(parsed, ["--ignore-file", "--search-path", "--base-directory"]).map((value) =>
				path(value, "option"),
			),
		);
		return info;
	}
	if (name === "aki") {
		const parsed = parseOptions(args, AKI_OPTIONS);
		if (!parsed || args.some((value) => /(?:^|[=:])~(?:\{|\/)/.test(value))) return null;
		return info;
	}
	if (name === "man") {
		const parsed = parseOptions(args, {
			"-a": "none",
			"--all": "none",
			"-d": "none",
			"-f": "none",
			"--whatis": "none",
			"-h": "none",
			"-k": "none",
			"--apropos": "none",
			"-w": "none",
			"-S": "string",
			"-s": "string",
		});
		if (!parsed) return null;
		const separator = args.indexOf("--");
		const optionArgs = separator < 0 ? args : args.slice(0, separator);
		const searchRequested = optionArgs.some((value) =>
			value.startsWith("--") ? MAN_SEARCH_OPTIONS.has(value) : value.startsWith("-") && /[kf]/.test(value.slice(1)),
		);
		let searchSeen = false;
		let operands = false;
		for (let index = 0; index < args.length; index++) {
			const value = args[index] ?? "";
			if (!operands && value === "--") {
				operands = true;
				continue;
			}
			if (!operands && value.startsWith("-") && value !== "-") {
				if (MAN_SEARCH_OPTIONS.has(value)) searchSeen = true;
				else if (MAN_SECTION_OPTIONS.has(value)) index++;
				continue;
			}
			operands = true;
			if (searchRequested && value.startsWith("-")) return null;
			if (!searchSeen && /[/\\~]/.test(value)) return null;
		}
		return info;
	}
	if (name === "help") {
		const parsed = parseOptions(args, { "-d": "none" });
		if (!parsed || parsed.positionals.some((value) => /[/\\]/.test(value))) return null;
		return info;
	}
	if (name === "test" || name === "[" || name === "[[") {
		if (args.some((value) => ["-a", "-o"].includes(value) || value.includes("["))) return null;
		for (let index = 0; index < args.length; index++) {
			if (["-v", "-R"].includes(args[index] ?? "") && !/^[A-Za-z_]\w*$/.test(args[index + 1] ?? "")) return null;
		}
		for (let index = 0; index < args.length; index++) {
			const operator = args[index] ?? "";
			if (!TEST_FILE_OPERATORS.has(operator)) continue;
			if (["-nt", "-ot", "-ef"].includes(operator) && args[index - 1])
				intents.push(path(args[index - 1] ?? "", "argument"));
			if (args[index + 1]) intents.push(path(args[index + 1] ?? "", "argument"));
		}
		return info;
	}
	if (name === "find") {
		if (
			args.some((value) =>
				[
					"-delete",
					"-rm",
					"-exec",
					"-execdir",
					"-ok",
					"-okdir",
					"-fprint",
					"-fprint0",
					"-fls",
					"-fprintf",
					"-files0-from",
				].includes(value),
			)
		)
			return null;
		let index = 0;
		while (["-H", "-P", "-E", "-X", "-d", "-s", "-x"].includes(args[index] ?? "") || /^-O\d+$/.test(args[index] ?? ""))
			index++;
		if (args[index] === "-D") {
			if (!args[index + 1]) return null;
			index += 2;
		}
		while (args[index] === "-f") {
			const operand = args[index + 1];
			if (!operand) return null;
			intents.push(path(operand, "option"));
			index += 2;
		}
		while (index < args.length && !(args[index] ?? "").startsWith("-") && !["!", "("].includes(args[index] ?? ""))
			intents.push(path(args[index++] ?? "", "argument"));
		for (; index < args.length; index++) {
			const value = args[index] ?? "";
			const newer = /^-newer([aBcmt])?([aBcmt])?$/.exec(value);
			if (["-anewer", "-cnewer", "-samefile"].includes(value) || (newer && newer[2] !== "t")) {
				const operand = args[++index];
				if (!operand) return null;
				intents.push(path(operand, "option"));
			}
		}
		return { ...info, hasGlob: command.hasGlob };
	}
	if (["grep", "egrep", "fgrep", "rg"].includes(name)) {
		const parsed = parseOptions(args, name === "rg" ? RG_OPTIONS : GREP_OPTIONS);
		if (!parsed) return null;
		const patternOptions = optionValues(
			parsed,
			name === "rg" ? ["-e", "--regexp", "-f"] : ["-e", "--regexp", "-f", "--file"],
		);
		const patternFromOption = patternOptions.length > 0;
		const files = patternFromOption ? parsed.positionals : parsed.positionals.slice(1);
		intents.push(...files.map((value) => path(value, "argument")));
		intents.push(...optionValues(parsed, ["-f", "--file", "--exclude-from"]).map((value) => path(value, "option")));
		return info;
	}
	if (name === "sort" || name === "file") {
		const parsed = parseOptions(args, name === "sort" ? SORT_OPTIONS : FILE_OPTIONS);
		if (!parsed) return null;
		intents.push(...parsed.positionals.map((value) => path(value, "argument")));
		return info;
	}
	if (name === "sed") {
		const parsed = parseOptions(args, SED_OPTIONS);
		if (!parsed) return null;
		const scripts = optionValues(parsed, ["-e", "--expression"]);
		const quiet =
			parsed.occurrences.has("-n") || parsed.occurrences.has("--quiet") || parsed.occurrences.has("--silent");
		const effectiveScripts = scripts.length > 0 ? scripts : parsed.positionals.slice(0, 1);
		const files = scripts.length > 0 ? parsed.positionals : parsed.positionals.slice(1);
		if (!safeSedScripts(effectiveScripts, parsed, quiet, files.length > 0)) return null;
		intents.push(...files.map((value) => path(value, "argument")));
		return info;
	}
	if (["sha256sum", "sha1sum", "md5sum"].includes(name)) {
		const parsed = parseOptions(args, HASH_OPTIONS);
		if (!parsed) return null;
		intents.push(...parsed.positionals.map((value) => path(value, "argument")));
		return info;
	}
	if (name === "uniq") {
		const parsed = parseOptions(args, {
			"-c": "none",
			"--count": "none",
			"-d": "none",
			"--repeated": "none",
			"-D": "none",
			"--all-repeated": "none",
			"-i": "none",
			"--ignore-case": "none",
			"-u": "none",
			"--unique": "none",
			"-z": "none",
			"--zero-terminated": "none",
			"-f": "number",
			"--skip-fields": "number",
			"-s": "number",
			"--skip-chars": "number",
			"-w": "number",
			"--check-chars": "number",
			"--help": "none",
			"--version": "none",
		});
		if (!parsed || parsed.positionals.length > 1) return null;
		intents.push(...parsed.positionals.map((value) => path(value, "argument")));
		return info;
	}
	if (name === "jq") {
		if (
			args.some((value) =>
				["-f", "-L", "--from-file", "--rawfile", "--slurpfile", "--run-tests", "--library-path"].some(
					(option) => value === option || value.startsWith(`${option}=`),
				),
			)
		)
			return null;
		if (args.some((value) => /\b(?:env|include|import)\b|\$ENV/.test(value))) return null;
		const positionals = args.filter((value) => !value.startsWith("-"));
		intents.push(...positionals.slice(1).map((value) => path(value, "argument")));
		return info;
	}
	if (name === "diff" || name === "du") {
		const fileOptions = name === "diff" ? ["--from-file", "--to-file"] : ["--files0-from", "--exclude-from"];
		for (let index = 0; index < args.length; index++) {
			const value = args[index] ?? "";
			if (fileOptions.includes(value)) {
				const operand = args[++index];
				if (!operand) return null;
				intents.push(path(operand, "option"));
			} else if (fileOptions.some((option) => value.startsWith(`${option}=`)))
				intents.push(path(value.slice(value.indexOf("=") + 1), "option"));
			else if (!value.startsWith("-")) intents.push(path(value, "argument"));
		}
		return info;
	}
	if (name === "git") {
		const git = classifyGit(argv);
		if (!git.ok) return null;
		intents.push(...git.paths);
		return info;
	}
	if (name === "gh") {
		const commandKey = args.slice(0, 2).join(" ");
		const spec = GH_COMMAND_OPTIONS[commandKey];
		if (!spec) return null;
		const parsed = parseOptions(args.slice(2), spec);
		if (!parsed || args.slice(2).some(dangerousGhArgument)) return null;
		return info;
	}
	if (name === "docker") {
		const dockerSelectors = [
			"-H",
			"-c",
			"-r",
			"--host",
			"--context",
			"--config",
			"--tlscacert",
			"--tlscert",
			"--tlskey",
			"--url",
			"--connection",
			"--identity",
			"--remote",
			"--module",
			"--out",
		];
		if (
			args.some((value) =>
				dockerSelectors.some(
					(selector) =>
						value === selector ||
						value.startsWith(`${selector}=`) ||
						(selector.length === 2 && value.length > 2 && value.startsWith(selector)),
				),
			)
		)
			return null;
		const subcommand = args[0];
		if (subcommand === "ps" || subcommand === "images") return info;
		if (subcommand === "logs" || subcommand === "inspect") {
			const parsed = parseOptions(args.slice(1), subcommand === "logs" ? DOCKER_LOG_OPTIONS : DOCKER_INSPECT_OPTIONS);
			if (!parsed || parsed.positionals.length === 0) return null;
			return info;
		}
		return null;
	}
	const common = COMMON_FILE_OPTIONS[name];
	if (common) {
		const parsed = parseOptions(args, common.spec);
		if (parsed) {
			intents.push(...parsed.positionals.map((value) => path(value, "argument")));
			intents.push(...optionValues(parsed, common.fileOptions ?? []).map((value) => path(value, "option")));
		} else {
			// Claude classifies these command names directly, while its separate path
			// layer handles operands. Unknown option spellings stay read-only here,
			// but every non-option is conservatively treated as a path.
			intents.push(...args.filter((value) => !value.startsWith("-")).map((value) => path(value, "argument")));
		}
		return info;
	}
	if (name === "xargs") {
		if (platform === "win32") return null;
		const parsed = parseOptions(args, XARGS_OPTIONS, { stopAtPositional: true });
		if (parsed?.positionals.length === 0) return info;
		const target = parsed?.positionals[0];
		if (!target) return null;
		const replacement = optionValues(parsed, ["-I", "--replace"])[0];
		if (replacement && target.includes(replacement)) return null;
		// Validate the nested command and fixed operands before execution. Native
		// xargs expands stdin later; there is no runtime path rewriting or runner.
		const nested = classifyCommand({ argv: parsed.positionals, env: {}, redirects: [], hasGlob: false }, platform);
		if (!nested) return null;
		if (nested.name === "printf") {
			const args = nested.argv.slice(1);
			const format = args[args[0] === "--" ? 1 : 0];
			if (!safePrintf(args, true) || (replacement && format?.includes(replacement))) return null;
		}
		// Unknown input must not introduce options that execute programs or write.
		if (
			["rg", "sort", "file", "jq", "awk", "sed", "find", "fd", "git", "gh", "docker", "date", "xargs"].includes(
				nested.name,
			) &&
			!nested.argv.includes("--")
		)
			return null;
		intents.push(...nested.pathIntents.filter((intent) => !replacement || !intent.value.includes(replacement)));
		if (nested.workingDirectoryIntents?.length) info.workingDirectoryIntents = nested.workingDirectoryIntents;
		return info;
	}
	if (DIRECT_COMMANDS.has(name)) {
		if (!NON_PATH_DIRECT_COMMANDS.has(name))
			intents.push(...args.filter((value) => !value.startsWith("-")).map((value) => path(value, "argument")));
		return info;
	}
	return null;
}

export function classifyReadOnlyBash(command: string, options: BashClassifierOptions = {}): BashReadOnlyDecision {
	if (command.length > 10_000) return fail("Command too long for read-only analysis");
	let tree: Parser.Tree;
	try {
		tree = bashParser().parse(command);
	} catch {
		return fail("Bash parser failed");
	}
	const normalized = collectCommands(tree.rootNode);
	if (containsBackgroundOperator(tree.rootNode)) return fail("Background operator is not read-only");
	if (!normalized || normalized.length === 0) return fail("Not a simple read-only command");
	const commands: BashCommandInfo[] = [];
	for (const candidate of normalized) {
		const classified = classifyCommand(candidate, options.platform ?? process.platform);
		if (!classified) return fail(`Command is not read-only: ${candidate.argv.join(" ")}`, commands);
		commands.push(classified);
	}
	return { readOnly: true, reason: "All commands are read-only", commands };
}
