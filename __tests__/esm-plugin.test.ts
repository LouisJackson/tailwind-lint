import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lint } from "../src/linter";

const v4Fixture = path.resolve(__dirname, "fixtures/v4");

// ESM-only plugin package: options-aware main entry plus an "exports" subpath
const PLUGIN_FILES: Record<string, string> = {
	"package.json": JSON.stringify({
		name: "esm-only-plugin",
		version: "1.0.0",
		type: "module",
		exports: {
			".": "./index.js",
			"./extra": { default: "./extra/index.js" },
		},
	}),
	"index.js": `
const plugin = (options = {}) => ({
	handler: ({ addUtilities }) => {
		addUtilities({ [\`.\${options.prefix ?? "esm"}-box\`]: { display: "block" } });
	},
});
plugin.__isOptionsFunction = true;
export default plugin;
`,
	"extra/index.js": `
export default ({ addUtilities }) => {
	addUtilities({ ".extra-box": { display: "block" } });
};
`,
};

describe("ESM-only plugins (v4)", () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-lint-esm-plugin-"));
		const modules = path.join(dir, "node_modules");
		fs.mkdirSync(modules);
		fs.symlinkSync(
			path.join(v4Fixture, "node_modules/tailwindcss"),
			path.join(modules, "tailwindcss"),
			"dir",
		);
		for (const [file, content] of Object.entries(PLUGIN_FILES)) {
			const target = path.join(modules, "esm-only-plugin", file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}

		fs.writeFileSync(
			path.join(dir, "app.css"),
			`@import "tailwindcss";
@plugin "esm-only-plugin" {
	prefix: custom;
}
@plugin "esm-only-plugin/extra";
`,
		);
		fs.writeFileSync(
			path.join(dir, "index.html"),
			'<div class="custom-box block"></div>\n<div class="extra-box block"></div>\n',
		);
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("loads ESM plugins with options and exports subpaths", async () => {
		const result = await lint({
			cwd: dir,
			configPath: "app.css",
			patterns: ["index.html"],
			autoDiscover: false,
		});

		const messages = result.files[0].diagnostics.map((d) => d.message);
		expect(messages).toContainEqual(
			"'custom-box' applies the same CSS properties as 'block'.",
		);
		expect(messages).toContainEqual(
			"'extra-box' applies the same CSS properties as 'block'.",
		);
	});
});
