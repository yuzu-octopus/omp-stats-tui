import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

// Exact host surfaces retained by omp 18.6.1's compiled module registry.
// Do not use package-root external patterns: they also externalize private
// subpaths such as pi-utils/file-lock, whose source cannot load in compiled omp.
const HOST_IMPORTS: Record<string, true> = {
	"@oh-my-pi/pi-coding-agent": true,
	"@oh-my-pi/pi-tui": true,
	"@oh-my-pi/pi-tui/chrome": true,
	"@oh-my-pi/pi-tui/theme": true,
	"@oh-my-pi/pi-tui/charts/table-data": true,
	"@oh-my-pi/pi-tui/charts/chart-plan": true,
	"@oh-my-pi/pi-tui/charts/chart-svg": true,
	"@oh-my-pi/pi-tui/theme/color": true,
	"@oh-my-pi/pi-utils": true,
	"@oh-my-pi/pi-natives": true,
	"@oh-my-pi/pi-ai": true,
	"@oh-my-pi/pi-ai/auth-broker": true,
	"@oh-my-pi/pi-catalog/models": true,
	"@oh-my-pi/pi-catalog/models.json": true,
	"@oh-my-pi/pi-catalog/compat/revision": true,
	"@oh-my-pi/pi-catalog/compat/taxonomy": true,
};

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const worker = await Bun.build({
	entrypoints: [resolve(root, "scripts/data-worker.ts")],
	outdir,
	target: "bun",
	format: "esm",
	external: ["@oh-my-pi/pi-natives", "@oh-my-pi/pi-coding-agent/judgment/standalone"],
});
if (!worker.success) throw new AggregateError(worker.logs, "Unable to bundle data-worker");
const result = await Bun.build({
	entrypoints: [resolve(root, "src/index.ts")],
	outdir,
	target: "bun",
	format: "esm",
	define: { __STATS_READ_WORKER__: JSON.stringify("./data-worker.js") },
	naming: { entry: "[name].[ext]", asset: "[name].[hash].[ext]" },
	plugins: [{
		name: "omp-host-public-imports",
		setup(build) {
			build.onResolve({ filter: /^@oh-my-pi\// }, args => {
				if (Object.hasOwn(HOST_IMPORTS, args.path)) return { path: args.path, external: true };
			});
		},
	}],
});

if (!result.success) throw new AggregateError(result.logs, "Unable to build stats-tui distribution");
for (const output of result.outputs) console.log(output.path);
