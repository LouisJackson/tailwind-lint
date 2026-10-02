import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { glob } from "tinyglobby";
import {
	DEFAULT_IGNORE_PATTERNS,
	TAILWIND_V4_IMPORT_REGEX,
	TAILWIND_VITE_PLUGIN_REGEX,
	V3_CONFIG_PATHS,
	V4_CSS_FOLDERS,
	V4_CSS_NAMES,
	VITE_CONFIG_PATHS,
} from "../constants";
import type { TailwindConfig } from "../types";
import { fileExists } from "./fs";

const require = createRequire(import.meta.url || __filename);
const CONFIG_DISCOVERY_MAX_DEPTH = 8;
const PROJECT_ROOT_MARKERS = ["package.json", ".git"];

const VITE_CONFIG_NAME_REGEX = /^vite\.config\.[cm]?[jt]s$/;

export const isCssConfigFile = (filePath: string) => filePath.endsWith(".css");

export function findProjectRoot(startDir: string) {
	let current = path.resolve(startDir);

	while (true) {
		if (
			PROJECT_ROOT_MARKERS.some((marker) =>
				fileExists(path.join(current, marker)),
			)
		) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(startDir);
		}
		current = parent;
	}
}

export async function loadTailwindConfig(
	configPath: string,
): Promise<TailwindConfig> {
	if (isCssConfigFile(configPath)) {
		return {};
	}

	if (!path.isAbsolute(configPath)) {
		throw new Error(
			`Config path must be absolute for security reasons: ${configPath}`,
		);
	}

	try {
		delete require.cache[configPath];

		const configModule = require(configPath) as
			| TailwindConfig
			| { default: TailwindConfig };
		const config = (
			"default" in configModule ? configModule.default : configModule
		) as TailwindConfig;

		if (typeof config !== "object" || config === null) {
			throw new Error("Config must be an object");
		}

		return config;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		if (errorMessage.includes("Cannot find module")) {
			throw new Error(
				`Failed to load config from ${configPath}.\n` +
					"The config file may have missing dependencies. Check that all imports are installed.",
			);
		}

		if (
			errorMessage.includes("SyntaxError") ||
			errorMessage.includes("Unexpected token")
		) {
			throw new Error(
				`Failed to parse config from ${configPath}.\n` +
					"The config file has syntax errors. Check your JavaScript/TypeScript syntax.",
			);
		}

		throw new Error(
			`Failed to load config from ${configPath}: ${errorMessage}`,
		);
	}
}

export type TailwindConfigKind = "css" | "js" | "vite";

export interface TailwindConfigTarget {
	kind: TailwindConfigKind;
	path: string;
	root: string;
}

export interface TailwindConfigDiscovery {
	targets: TailwindConfigTarget[];
	packageRoots: string[];
}

export function toConfigTarget(configPath: string): TailwindConfigTarget {
	return {
		kind: configKind(configPath),
		path: configPath,
		root: findProjectRoot(path.dirname(configPath)),
	};
}

function configKind(configPath: string): TailwindConfigKind {
	if (isCssConfigFile(configPath)) return "css";
	return VITE_CONFIG_NAME_REGEX.test(path.basename(configPath)) ? "vite" : "js";
}

export async function findTailwindConfigs(
	cwd: string,
): Promise<TailwindConfigDiscovery> {
	const root = path.resolve(cwd);
	const files = await glob(
		[
			"**/package.json",
			"**/*.css",
			...[...V3_CONFIG_PATHS, ...VITE_CONFIG_PATHS].map((p) => `**/${p}`),
		],
		{
			cwd: root,
			absolute: true,
			ignore: DEFAULT_IGNORE_PATTERNS,
			deep: CONFIG_DISCOVERY_MAX_DEPTH,
		},
	);

	const isPackageJson = (file: string) =>
		path.basename(file) === "package.json";
	const packageRoots = await findPackageRoots(
		root,
		files.filter(isPackageJson).map(path.dirname),
	);

	const deepestFirst = [...packageRoots].sort((a, b) => b.length - a.length);
	const candidatesByRoot = new Map(
		packageRoots.map((packageRoot) => [packageRoot, [] as string[]]),
	);
	for (const file of files) {
		if (isPackageJson(file)) continue;
		const owner = deepestFirst.find((packageRoot) =>
			isInsideDir(packageRoot, file),
		);
		if (owner) candidatesByRoot.get(owner)?.push(file);
	}

	const targets = await Promise.all(
		[...candidatesByRoot].map(([packageRoot, candidates]) =>
			pickConfig(packageRoot, candidates),
		),
	);

	return {
		targets: targets.filter((target) => target !== undefined),
		packageRoots,
	};
}

async function findPackageRoots(root: string, packageDirs: string[]) {
	const workspaces = await readWorkspacePatterns(root);
	if (!workspaces) {
		return [...new Set([root, ...packageDirs])];
	}

	const toPackageJson = (pattern: string) =>
		`${pattern.replace(/\/+$/, "")}/package.json`;
	const workspacePackageJsons = await glob(
		workspaces.filter((p) => !p.startsWith("!")).map(toPackageJson),
		{
			cwd: root,
			absolute: true,
			ignore: [
				...DEFAULT_IGNORE_PATTERNS,
				...workspaces
					.filter((p) => p.startsWith("!"))
					.map((p) => toPackageJson(p.slice(1))),
			],
		},
	);

	return [...new Set([root, ...workspacePackageJsons.map(path.dirname)])];
}

async function readWorkspacePatterns(root: string) {
	const [packageJson, pnpmWorkspace] = await Promise.all([
		readText(path.join(root, "package.json")),
		readText(path.join(root, "pnpm-workspace.yaml")),
	]);

	const patterns = [
		...parsePackageJsonWorkspaces(packageJson),
		...parsePnpmWorkspacePackages(pnpmWorkspace),
	];
	return patterns.length > 0 ? patterns : undefined;
}

function parsePackageJsonWorkspaces(content: string): string[] {
	try {
		const { workspaces } = JSON.parse(content) as {
			workspaces?: string[] | { packages?: string[] };
		};
		const patterns = Array.isArray(workspaces)
			? workspaces
			: workspaces?.packages;
		return (patterns ?? []).filter((p) => typeof p === "string");
	} catch {
		return [];
	}
}

function parsePnpmWorkspacePackages(content: string) {
	const patterns: string[] = [];
	let inPackages = false;

	for (const line of content.split(/\r?\n/)) {
		if (/^packages\s*:/.test(line)) {
			inPackages = true;
		} else if (/^[^\s#]/.test(line)) {
			inPackages = false;
		} else if (inPackages) {
			const item = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/);
			if (item) patterns.push(item[1]);
		}
	}

	return patterns;
}

export function nestedRootIgnores(root: string, roots: string[]) {
	return roots
		.filter((other) => other !== root && isInsideDir(root, other))
		.map((other) => `${path.relative(root, other)}/**`);
}

export function isInsideDir(dir: string, filePath: string) {
	const relative = path.relative(dir, filePath);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pickConfig(
	root: string,
	candidates: string[],
): Promise<TailwindConfigTarget | undefined> {
	const target = (kind: TailwindConfigKind, configPath: string) => ({
		kind,
		path: configPath,
		root,
	});
	const candidateSet = new Set(candidates);
	const existing = (paths: string[]) =>
		paths.map((p) => path.join(root, p)).filter((p) => candidateSet.has(p));
	const byName = (names: string[]) =>
		candidates.filter((c) => names.includes(path.basename(c)));

	const preferredCss = existing(
		V4_CSS_FOLDERS.flatMap((folder) =>
			V4_CSS_NAMES.map((name) => path.join(folder, name)),
		),
	);
	const preferredCssMatch = await findFirstMatch(
		preferredCss,
		TAILWIND_V4_IMPORT_REGEX,
	);
	if (preferredCssMatch) return target("css", preferredCssMatch);

	const rootV3 = existing(V3_CONFIG_PATHS)[0];
	if (rootV3) return target("js", rootV3);

	const otherCss = sortCssCandidates(
		root,
		candidates.filter((c) => isCssConfigFile(c) && !preferredCss.includes(c)),
	);
	const cssMatch = await findFirstMatch(otherCss, TAILWIND_V4_IMPORT_REGEX);
	if (cssMatch) return target("css", cssMatch);

	const nestedV3 = sortByPathDepth(byName(V3_CONFIG_PATHS))[0];
	if (nestedV3) return target("js", nestedV3);

	const viteConfigs = [
		...existing(VITE_CONFIG_PATHS),
		...sortByPathDepth(byName(VITE_CONFIG_PATHS)),
	];
	const viteMatch = await findFirstMatch(
		[...new Set(viteConfigs)],
		TAILWIND_VITE_PLUGIN_REGEX,
	);
	if (viteMatch) return target("vite", viteMatch);

	return undefined;
}

async function findFirstMatch(paths: string[], regex: RegExp) {
	const contents = await Promise.all(paths.map(readText));
	return paths.find((_, index) => regex.test(contents[index]));
}

async function readText(filePath: string) {
	try {
		return await readFile(filePath, "utf-8");
	} catch {
		return "";
	}
}

function sortByPathDepth(paths: string[]) {
	return [...paths].sort((a, b) => {
		const depthA = splitDepth(a);
		const depthB = splitDepth(b);
		if (depthA !== depthB) return depthA - depthB;
		return a.localeCompare(b);
	});
}

function sortCssCandidates(cwd: string, paths: string[]) {
	return [...paths].sort((a, b) => {
		const scoreA = cssCandidateScore(cwd, a);
		const scoreB = cssCandidateScore(cwd, b);
		if (scoreA !== scoreB) return scoreA - scoreB;
		return a.localeCompare(b);
	});
}

function cssCandidateScore(cwd: string, candidate: string) {
	const relative = path.relative(cwd, candidate);
	const normalized = relative.split(path.sep).join("/");
	const base = path.basename(candidate);
	const depth = splitDepth(normalized);

	const nameScore = V4_CSS_NAMES.includes(base) ? 0 : 20;
	const folderScore = isPreferredCssFolder(normalized) ? 0 : 10;

	return depth * 100 + nameScore + folderScore;
}

function isPreferredCssFolder(relativePath: string) {
	const folder = path.dirname(relativePath).replace(/\\/g, "/");
	const withSlash = folder === "." ? "./" : `./${folder}/`;
	return V4_CSS_FOLDERS.includes(withSlash);
}

function splitDepth(value: string) {
	return value.split(/[\\/]/).filter(Boolean).length;
}
