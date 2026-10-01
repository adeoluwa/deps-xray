#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { parseLockfileAt, LockfileError } from "./lockfile/parse.js";
import { computeStats } from "./graph/stats.js";
import { renderText } from "./report/text.js";

const HELP = `Usage: deps-xray [path/to/package-lock.json] [options]

Options:
  --prod           Only count dependencies that ship to production (skip dev-only)
  --all-platforms  Count OS/CPU-specific optional packages for every platform
  --json           Print machine-readable JSON instead of the text report
  --top <n>        How many items to list per section (default 10)
  -h, --help       Show this help`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prod: { type: "boolean", default: false },
      "all-platforms": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      top: { type: "string", default: "10" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const top = Number.parseInt(values.top, 10);
  if (!Number.isInteger(top) || top < 1)
    throw new LockfileError(
      `--top must be a positive integer, got ${values.top}`,
    );

  const lockPath = resolve(positionals[0] ?? "package-lock.json");
  const graph = await parseLockfileAt(lockPath);
  const stats = computeStats(graph, {
    prodOnly: values.prod,
    allPlatforms: values["all-platforms"],
    top,
  });

  console.log(
    values.json ? JSON.stringify(stats, null, 2) : renderText(stats, top),
  );
}

main().catch((err: unknown) => {
  if (err instanceof LockfileError) {
    console.error(`deps-xray: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
