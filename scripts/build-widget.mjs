import { build } from "esbuild";
import { readFileSync, mkdirSync } from "fs";
import zlib from "zlib";

const result = await build({
  entryPoints: ["app/widget/index.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "__LOYALTY_WIDGET__",
  outfile: "public/loyalty-widget.js",
  metafile: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// Write metafile for bundle inspection
mkdirSync(".superpowers/sdd", { recursive: true });
import { writeFileSync } from "fs";
writeFileSync(".superpowers/sdd/widget-meta.json", JSON.stringify(result.metafile, null, 2));

// Enforce <12 KB gzipped
const raw = readFileSync("public/loyalty-widget.js");
const gzipped = zlib.gzipSync(raw);
const kb = (gzipped.length / 1024).toFixed(2);
console.log(`Widget bundle: ${kb} KB gzipped`);
if (gzipped.length > 12 * 1024) {
  console.error(`ERROR: bundle exceeds 12 KB limit (${kb} KB). Reduce widget size.`);
  process.exit(1);
}
