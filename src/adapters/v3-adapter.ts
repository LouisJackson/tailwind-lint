import { createRequire } from "node:module";
import * as path from "node:path";
import type { State } from "@tailwindcss/language-service";
import ansis from "ansis";
import { AdapterLoadError } from "../types";

const require = createRequire(import.meta.url || __filename);

interface JitContext {
	getClassList?: (options?: { includeMetadata?: boolean }) => unknown[];
	getVariants?: () => State["variants"];
}

function interopDefault<T>(module: T | { default: T }): T {
	return module && typeof module === "object" && "default" in module
		? module.default
		: (module as T);
}

export async function loadV3ClassMetadata(
	state: State,
	resolvePaths: string[],
	verbose = false,
): Promise<void> {
	try {
		const tailwindDir = path.dirname(
			require.resolve("tailwindcss/package.json", { paths: resolvePaths }),
		);
		const load = (id: string) =>
			require(require.resolve(id, { paths: [tailwindDir] }));
		const loadLib = (name: string) =>
			require(path.join(tailwindDir, "lib", "lib", name));

		const { createContext } = loadLib("setupContextUtils");
		const { generateRules } = loadLib("generateRules");

		state.jit = true;
		state.modules = {
			tailwindcss: {
				version: state.version || "unknown",
				module: load("tailwindcss"),
			},
			postcss: {
				version: load("postcss/package.json").version,
				module: load("postcss"),
			},
			postcssSelectorParser: { module: load("postcss-selector-parser") },
			jit: {
				generateRules: { module: generateRules },
				createContext: { module: createContext },
				expandApplyAtRules: {
					module: interopDefault(loadLib("expandApplyAtRules")),
				},
				evaluateTailwindFunctions: {
					module: interopDefault(loadLib("evaluateTailwindFunctions")),
				},
			},
		};

		extractConfigMetadata(state);

		const jitContext = createContext(state.config) as JitContext;
		state.jitContext = jitContext;
		state.classList = jitContext.getClassList?.({
			includeMetadata: true,
		}) as State["classList"];
		state.variants = jitContext.getVariants?.() ?? [];

		if (verbose) {
			console.log(ansis.dim("  ✓ Created v3 JIT context"));
		}
	} catch (error) {
		if (error instanceof Error) {
			throw new AdapterLoadError("v3", error);
		}
		throw new Error(`Failed to load v3 class metadata: ${String(error)}`);
	}
}

function extractConfigMetadata(state: State) {
	const { config } = state;
	if (!config || typeof config !== "object") return;

	const theme = (config as Record<string, unknown>).theme as
		| Record<string, unknown>
		| undefined;
	state.screens = Object.keys(
		(theme?.screens as Record<string, unknown>) ?? {},
	);
	state.blocklist = (config.blocklist as string[] | undefined) ?? [];

	if (config.corePlugins) {
		state.corePlugins = Array.isArray(config.corePlugins)
			? (config.corePlugins as string[])
			: Object.keys(config.corePlugins as Record<string, unknown>);
	}
}
