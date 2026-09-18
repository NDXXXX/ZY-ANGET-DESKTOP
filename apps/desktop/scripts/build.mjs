import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(appRoot, "dist");

await rm(distDir, { recursive: true, force: true });

await Promise.all([
	esbuild({
		entryPoints: [resolve(appRoot, "src/main/index.ts")],
		bundle: true,
		external: ["electron"],
		format: "cjs",
		outfile: resolve(distDir, "main/index.cjs"),
		platform: "node",
		sourcemap: true,
		target: "node22",
	}),
	esbuild({
		entryPoints: [resolve(appRoot, "src/preload/index.ts")],
		bundle: true,
		external: ["electron"],
		format: "cjs",
		outfile: resolve(distDir, "preload/index.cjs"),
		platform: "node",
		sourcemap: true,
		target: "node22",
	}),
	viteBuild({
		base: "./",
		configFile: false,
		plugins: [react()],
		root: resolve(appRoot, "src/renderer"),
		build: {
			emptyOutDir: true,
			outDir: resolve(distDir, "renderer"),
		},
	}),
]);
