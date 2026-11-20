import { build, context } from "esbuild";

const serve = process.argv.includes("--serve");
const watch = serve || process.argv.includes("--watch");

const card = {
  entryPoints: ["src/index.ts"],
  outfile: "dist/mammotion-mow-planner-card.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "eof",
  logLevel: "info",
};
const demo = {
  ...card,
  entryPoints: ["demo/demo.ts"],
  outfile: "demo/demo.js",
  minify: false,
  sourcemap: "inline",
};

if (!watch) {
  await build(card);
} else {
  const contexts = await Promise.all([context(card), context(demo)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  if (serve) {
    const { port } = await contexts[1].serve({ servedir: ".", host: "127.0.0.1", port: 5173 });
    console.log(`demo: http://localhost:${port}/demo/`);
  }
}
