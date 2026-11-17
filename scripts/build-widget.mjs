// scripts/build-widget.mjs
// Builds the two storefront bundles into the theme app extension's assets:
//   app/widget/core.ts → extensions/hg-loyalty/assets/hg-core.js  (every page, deferred)
//   app/widget/hub.ts  → extensions/hg-loyalty/assets/hg-hub.js   (on first open only)
// The build fails if either bundle grows past its gzip budget.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import zlib from "node:zlib";

const OUT = "extensions/hg-loyalty/assets";
const BUNDLES = [
  { name: "core", entry: "app/widget/core.ts", outfile: `${OUT}/hg-core.js`, budgetKb: 8 },
  { name: "hub", entry: "app/widget/hub.ts", outfile: `${OUT}/hg-hub.js`, budgetKb: 22 },
];

mkdirSync(OUT, { recursive: true });

// One source for the cart line's CSS: the Liquid snippet. The core bundle
// injects the same rules when no app block has printed them on the page.
const lineCss = readFileSync("extensions/hg-loyalty/snippets/hg-line-css.liquid", "utf8")
  .replace(/<\/?style[^>]*>/g, "")
  .replace(/\s*\n\s*/g, "")
  .trim();
if (!lineCss || /[<{%]%|\{\{/.test(lineCss)) {
  console.error("ERROR hg-line-css.liquid must contain plain CSS only");
  process.exit(1);
}

let failed = false;
for (const b of BUNDLES) {
  await build({
    entryPoints: [b.entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2018"],
    legalComments: "none",
    outfile: b.outfile,
    define: { "process.env.NODE_ENV": '"production"', __HG_LINE_CSS__: JSON.stringify(lineCss) },
  });
  const raw = readFileSync(b.outfile);
  const gz = zlib.gzipSync(raw, { level: 9 }).length;
  const line = `${b.name}: ${(raw.length / 1024).toFixed(2)} KB raw, ${(gz / 1024).toFixed(2)} KB gzipped (budget ${b.budgetKb} KB)`;
  if (gz > b.budgetKb * 1024) {
    console.error(`ERROR ${line}`);
    failed = true;
  } else {
    console.log(line);
  }
}
if (failed) process.exit(1);
