import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import electronPath from "electron";
import { build as esbuild } from "esbuild";
import { createServer } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(appRoot, "dist");

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
]);

const server = await createServer({
	configFile: false,
	plugins: [react()],
	root: resolve(appRoot, "src/renderer"),
	server: { host: "127.0.0.1" },
});
await server.listen();

const devServerUrl = server.resolvedUrls?.local[0];
if (!devServerUrl) throw new Error("Vite did not provide a local development URL");

const electronEnv = { ...process.env, PI_DESKTOP_DEV_SERVER_URL: devServerUrl };
delete electronEnv.ELECTRON_RUN_AS_NODE;

const electron = spawn(electronPath, [appRoot], {
	env: electronEnv,
	stdio: "inherit",
});

const shutdown = async () => {
	electron.kill("SIGTERM");
	await server.close();
};

electron.once("exit", async (code) => {
	await server.close();
	process.exit(code ?? 0);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
