import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Lang, parse } from "@ast-grep/napi";
import { type BuildOptions, getPackagePath } from "@opennextjs/aws/build/helper.js";
import { getCrossPlatformPathRegex } from "@opennextjs/aws/utils/regex.js";
import { build, Plugin } from "esbuild";

import { patchOptionalDependencies } from "./patches/ast/optional-deps.js";
import * as patches from "./patches/index.js";
import { normalizePath, patchCodeWithValidations } from "./utils/index.js";

/** The dist directory of the Cloudflare adapter package */
const packageDistDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Bundle the Open Next server.
 */
export async function bundleServer(buildOpts: BuildOptions): Promise<void> {
  patches.copyPackageCliFiles(packageDistDir, buildOpts);

  const { appPath, outputDir, monorepoRoot } = buildOpts;
  const serverFiles = path.join(
    outputDir,
    "server-functions/default",
    getPackagePath(buildOpts),
    ".next/required-server-files.json"
  );
  const nextConfig = JSON.parse(fs.readFileSync(serverFiles, "utf-8")).config;

  console.log(`\x1b[35m⚙️ Bundling the OpenNext server...\n\x1b[0m`);

  patches.patchWranglerDeps(buildOpts);
  await patches.updateWebpackChunksFile(buildOpts);
  patches.patchVercelOgLibrary(buildOpts);

  const outputPath = path.join(outputDir, "server-functions", "default");
  const packagePath = getPackagePath(buildOpts);
  const openNextServer = path.join(outputPath, packagePath, `index.mjs`);
  const openNextServerBundle = path.join(outputPath, packagePath, `handler.mjs`);

  await build({
    entryPoints: [openNextServer],
    bundle: true,
    outfile: openNextServerBundle,
    format: "esm",
    target: "esnext",
    minify: false,
    plugins: [createFixRequiresESBuildPlugin(buildOpts)],
    external: ["./middleware/handler.mjs", "caniuse-lite"],
    alias: {
      // Note: we apply an empty shim to next/dist/compiled/ws because it generates two `eval`s:
      //   eval("require")("bufferutil");
      //   eval("require")("utf-8-validate");
      "next/dist/compiled/ws": path.join(buildOpts.outputDir, "cloudflare-templates/shims/empty.js"),
      // Note: we apply an empty shim to next/dist/compiled/edge-runtime since (amongst others) it generated the following `eval`:
      //   eval(getModuleCode)(module, module.exports, throwingRequire, params.context, ...Object.values(params.scopedContext));
      //   which comes from https://github.com/vercel/edge-runtime/blob/6e96b55f/packages/primitives/src/primitives/load.js#L57-L63
      // QUESTION: Why did I encountered this but mhart didn't?
      "next/dist/compiled/edge-runtime": path.join(
        buildOpts.outputDir,
        "cloudflare-templates/shims/empty.js"
      ),
      // `@next/env` is a library Next.js uses for loading dotenv files, for obvious reasons we need to stub it here
      // source: https://github.com/vercel/next.js/tree/0ac10d79720/packages/next-env
      "@next/env": path.join(buildOpts.outputDir, "cloudflare-templates/shims/env.js"),
    },
    define: {
      // config file used by Next.js, see: https://github.com/vercel/next.js/blob/68a7128/packages/next/src/build/utils.ts#L2137-L2139
      "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG": `${JSON.stringify(nextConfig)}`,
      // Next.js tried to access __dirname so we need to define it
      __dirname: '""',
      // Note: we need the __non_webpack_require__ variable declared as it is used by next-server:
      // https://github.com/vercel/next.js/blob/be0c3283/packages/next/src/server/next-server.ts#L116-L119
      __non_webpack_require__: "require",
      // Ask mhart if he can explain why the `define`s below are necessary
      "process.env.NEXT_RUNTIME": '"nodejs"',
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_MINIMAL": "true",
    },
    // We need to set platform to node so that esbuild doesn't complain about the node imports
    platform: "node",
    banner: {
      js: `
// __dirname is used by unbundled js files (which don't inherit the __dirname present in the define field)
// so we also need to set it on the global scope
// Note: this was hit in the next/dist/compiled/@opentelemetry/api module
globalThis.__dirname ??= "";

// Do not crash on cache not supported
// https://github.com/cloudflare/workerd/pull/2434
// compatibility flag "cache_option_enabled" -> does not support "force-cache"
const curFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (init) {
    delete init.cache;
  }
  return curFetch(input, init);
};
import __cf_stream from 'node:stream';
fetch = globalThis.fetch;
const CustomRequest = class extends globalThis.Request {
  constructor(input, init) {
    if (init) {
      delete init.cache;
      // https://github.com/cloudflare/workerd/issues/2746
      // https://github.com/cloudflare/workerd/issues/3245
      Object.defineProperty(init, "body", {
        value: init.body instanceof __cf_stream.Readable ? ReadableStream.from(init.body) : init.body;
      });
    }
    super(input, init);
  }
};
globalThis.Request = CustomRequest;
Request = globalThis.Request;
// Makes the edge converter returns either a Response or a Request.
globalThis.__dangerous_ON_edge_converter_returns_request = true;
globalThis.__BUILD_TIMESTAMP_MS__ = ${Date.now()};
`,
    },
  });

  await updateWorkerBundledCode(openNextServerBundle, buildOpts);

  const isMonorepo = monorepoRoot !== appPath;
  if (isMonorepo) {
    fs.writeFileSync(
      path.join(outputPath, "handler.mjs"),
      `export * from "./${normalizePath(packagePath)}/handler.mjs";`
    );
  }

  console.log(`\x1b[35mWorker saved in \`${getOutputWorkerPath(buildOpts)}\` 🚀\n\x1b[0m`);
}

/**
 * This function applies patches required for the code to run on workers.
 */
async function updateWorkerBundledCode(workerOutputFile: string, buildOpts: BuildOptions): Promise<void> {
  const code = await readFile(workerOutputFile, "utf8");

  const patchedCode = await patchCodeWithValidations(code, [
    ["require", patches.patchRequire],
    ["`buildId` function", (code) => patches.patchBuildId(code, buildOpts)],
    ["`loadManifest` function", (code) => patches.patchLoadManifest(code, buildOpts)],
    ["next's require", (code) => patches.inlineNextRequire(code, buildOpts)],
    ["`findDir` function", (code) => patches.patchFindDir(code, buildOpts)],
    ["`evalManifest` function", (code) => patches.inlineEvalManifest(code, buildOpts)],
    ["cacheHandler", (code) => patches.patchCache(code, buildOpts)],
    [
      "'require(this.middlewareManifestPath)'",
      (code) => patches.inlineMiddlewareManifestRequire(code, buildOpts),
    ],
    ["exception bubbling", patches.patchExceptionBubbling],
    ["`loadInstrumentationModule` function", patches.patchLoadInstrumentationModule],
    [
      "`patchAsyncStorage` call",
      (code) =>
        code
          // TODO: implement for cf (possibly in @opennextjs/aws)
          .replace("patchAsyncStorage();", "//patchAsyncStorage();"),
    ],
    [
      '`eval("require")` calls',
      (code) => code.replaceAll('eval("require")', "require"),
      { isOptional: true },
    ],
    [
      "`require.resolve` call",
      // workers do not support dynamic require nor require.resolve
      (code) => code.replace('require.resolve("./cache.cjs")', '"unused"'),
    ],
  ]);

  const bundle = parse(Lang.TypeScript, patchedCode).root();

  const { edits } = patchOptionalDependencies(bundle);

  await writeFile(workerOutputFile, bundle.commitEdits(edits));
}

function createFixRequiresESBuildPlugin(options: BuildOptions): Plugin {
  return {
    name: "replaceRelative",
    setup(build) {
      // Note: we (empty) shim require-hook modules as they generate problematic code that uses requires
      build.onResolve(
        { filter: getCrossPlatformPathRegex(String.raw`^\./require-hook$`, { escape: false }) },
        () => ({
          path: path.join(options.outputDir, "cloudflare-templates/shims/empty.js"),
        })
      );
    },
  };
}

/**
 * Gets the path of the worker.js file generated by the build process
 *
 * @param buildOpts the open-next build options
 * @returns the path of the worker.js file that the build process generates
 */
export function getOutputWorkerPath(buildOpts: BuildOptions): string {
  return path.join(buildOpts.outputDir, "worker.js");
}
