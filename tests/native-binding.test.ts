import assert from "node:assert/strict";
import test from "node:test";
import { preflightNativeBindings } from "../src/native-binding.ts";

function nativeLoadError(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

test("preflight fails extension load with an actionable error for a missing binding on win32", () => {
	const original = nativeLoadError("MODULE_NOT_FOUND", "Cannot find module 'tree-sitter'");
	assert.throws(
		() =>
			preflightNativeBindings(
				() => {
					throw original;
				},
				{ platform: "win32", arch: "x64" },
			),
		(error: Error) => {
			assert.match(error.message, /tree-sitter/);
			assert.match(error.message, /win32-x64/);
			assert.match(error.message, /Node 22, 24, or 26/);
			assert.equal(error.cause, original);
			return true;
		},
	);
});

test("preflight names the target architecture for a dlopen failure on win32 arm64", () => {
	const original = nativeLoadError("ERR_DLOPEN_FAILED", "was compiled against a different Node.js version");
	assert.throws(
		() =>
			preflightNativeBindings(
				(name) => {
					if (name === "tree-sitter-bash") throw original;
					return {};
				},
				{ platform: "win32", arch: "arm64" },
			),
		(error: Error) => {
			assert.match(error.message, /win32-arm64/);
			assert.match(error.message, /Node 22, 24, or 26/);
			assert.equal(error.cause, original);
			return true;
		},
	);
});

test("preflight loads every native binding before extension startup", () => {
	const loaded: string[] = [];
	preflightNativeBindings((name) => {
		loaded.push(name);
		return {};
	});
	assert.deepEqual(loaded, ["tree-sitter", "tree-sitter-bash"]);
});

test("preflight preserves unrelated load failures", () => {
	const original = new Error("permission denied");
	assert.throws(
		() =>
			preflightNativeBindings(() => {
				throw original;
			}),
		(error: Error) => error === original,
	);
});
