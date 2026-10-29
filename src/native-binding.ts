import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const NATIVE_BINDINGS = ["tree-sitter", "tree-sitter-bash"] as const;

export type NativeBindingName = (typeof NATIVE_BINDINGS)[number];

export interface NativeBindingEnvironment {
	platform?: NodeJS.Platform;
	arch?: string;
}

const NATIVE_LOAD_ERROR_CODES = new Set(["MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"]);

function nativeLoadErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Map a native module load failure to an actionable install error, or undefined for unrelated failures. */
export function nativeBindingLoadError(
	name: NativeBindingName,
	error: unknown,
	environment: NativeBindingEnvironment = {},
): Error | undefined {
	const code = nativeLoadErrorCode(error);
	if (!code || !NATIVE_LOAD_ERROR_CODES.has(code)) return undefined;
	const platform = environment.platform ?? process.platform;
	const arch = environment.arch ?? process.arch;
	const target = `${platform}-${arch}`;
	return new Error(
		`Native binding "${name}" failed to load for ${target}. ` +
			`Reinstall pi-project-memory with a supported Node line: Node 22, 24, or 26 (Node >= 22.19.0). ` +
			`The ${target} tree-sitter prebuild is missing or was built for a different Node ABI. ` +
			`Original error (${code}): ${errorMessage(error)}`,
		{ cause: error },
	);
}

export function loadNativeBinding(name: NativeBindingName, environment: NativeBindingEnvironment = {}): unknown {
	try {
		return require(name);
	} catch (error) {
		throw nativeBindingLoadError(name, error, environment) ?? error;
	}
}

/** Fail extension startup when the tree-sitter bindings cannot load; never degrade. */
export function preflightNativeBindings(
	load: (name: NativeBindingName) => unknown = (name) => require(name),
	environment: NativeBindingEnvironment = {},
): void {
	for (const name of NATIVE_BINDINGS) {
		try {
			load(name);
		} catch (error) {
			throw nativeBindingLoadError(name, error, environment) ?? error;
		}
	}
}
