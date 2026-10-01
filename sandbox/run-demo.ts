/**
 * Local, offline demonstrations of three dependency failure modes and their mitigations.
 * Everything runs against a private Verdaccio registry on 127.0.0.1 with no uplinks.
 * Your real ~/.npmrc and npm cache are never touched.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLockfileAt } from "../src/lockfile/parse.js";

const SANDBOX = dirname(fileURLToPath(import.meta.url));
const WORK = join(SANDBOX, ".work");
const REGISTRY_DATA = join(SANDBOX, ".registry");
const REGISTRY = "http://127.0.0.1:4873/";
const USERCONFIG = join(WORK, "npmrc");
const GLOBALCONFIG = join(WORK, "npmrc-global"); // empty on purpose
const CACHE = join(WORK, "npm-cache"); // the "developer machine" cache
const APP = join(WORK, "app");
const MARKER = "SANDBOX-MARKER.txt";

// ---------- small helpers ----------

const results: Array<{ scenario: string; check: string; ok: boolean }> = [];
let currentScenario = "";

function section(title: string) {
  currentScenario = title;
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}
function step(text: string) {
  console.log(`\n→ ${text}`);
}
function expect(ok: boolean, check: string) {
  results.push({ scenario: currentScenario, check, ok });
  console.log(`  ${ok ? "✔" : "✘"} ${check}`);
}

/** Environment with every inherited npm_config_* removed, so nothing leaks in from `npm run`. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toLowerCase().startsWith("npm_config_")) env[k] = v;
  }
  return env;
}

/** Run npm fully isolated. Returns { ok, output } instead of throwing. */
function npm(args: string, cwd: string, cache = CACHE) {
  const cmd =
    `npm ${args} --registry=${REGISTRY} --userconfig="${USERCONFIG}" ` +
    `--globalconfig="${GLOBALCONFIG}" --cache="${cache}" ` +
    `--no-audit --no-fund --no-update-notifier --loglevel=error`;
  try {
    const output = execSync(cmd, { cwd, env: cleanEnv(), encoding: "utf8", stdio: "pipe" });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function runApp(): string {
  return execSync("node index.js", { cwd: APP, encoding: "utf8" }).trim();
}

function installedVersion(): string | undefined {
  const p = join(APP, "node_modules", "tiny-pad", "package.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version : undefined;
}

function wipeInstall(keepLockfile: boolean) {
  rmSync(join(APP, "node_modules"), { recursive: true, force: true });
  if (!keepLockfile) rmSync(join(APP, "package-lock.json"), { force: true });
}

// ---------- the toy package, in three releases ----------

type Variant = "original" | "changed" | "postinstall";

function writeTinyPad(version: string, variant: Variant): string {
  const dir = join(WORK, "pkgs", `tiny-pad-${version}`);
  mkdirSync(dir, { recursive: true });

  // 1.0.0 pads with spaces. Later releases "helpfully" switch the default to zeros:
  // a small, plausible change that silently alters every app's output.
  const defaultChar = variant === "original" ? '" "' : '"0"';
  writeFileSync(
    join(dir, "index.js"),
    `module.exports = function pad(str, len, ch) {
  str = String(str);
  ch = ch === undefined ? ${defaultChar} : String(ch);
  while (str.length < len) str = ch + str;
  return str;
};
`,
  );

  const pkg: Record<string, unknown> = {
    name: "tiny-pad",
    version,
    main: "index.js",
    license: "MIT",
    description: "SANDBOX DEMO PACKAGE - never published to the public registry",
  };

  if (variant === "postinstall") {
    // Harmless on purpose: it only writes a text file into the installing project.
    // The point is that it COULD have done anything the user account can do.
    writeFileSync(
      join(dir, "postinstall.js"),
      `const fs = require("fs");
const path = require("path");
const target = path.join(process.env.INIT_CWD || process.cwd(), ${JSON.stringify(MARKER)});
fs.writeFileSync(target,
  "tiny-pad's postinstall script ran at " + new Date().toISOString() + ".\\n" +
  "It wrote this file into your project. It could have run any command your account can.\\n");
`,
    );
    pkg.scripts = { postinstall: "node postinstall.js" };
  }

  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

function publish(version: string, variant: Variant) {
  const dir = writeTinyPad(version, variant);
  const r = npm("publish", dir);
  if (!r.ok) throw new Error(`publish tiny-pad@${version} failed:\n${r.output}`);
  console.log(`  published tiny-pad@${version} (${variant}) to the local registry`);
}

// ---------- registry lifecycle ----------

async function startRegistry(): Promise<ChildProcess> {
  const bin = join(SANDBOX, "node_modules", "verdaccio", "bin", "verdaccio");
  if (!existsSync(bin)) {
    throw new Error('Verdaccio is not installed. Run "npm install" inside the sandbox folder first.');
  }
  const child = spawn(process.execPath, [bin, "--config", join(SANDBOX, "verdaccio.yaml")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${REGISTRY}-/ping`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`Verdaccio did not start on ${REGISTRY}. Is port 4873 in use?\n${log}`);
}

/** Create a throwaway registry user (what `npm adduser` does) and write an isolated npmrc. */
async function login() {
  const res = await fetch(`${REGISTRY}-/user/org.couchdb.user:demo`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "demo", password: "sandbox-only-password", type: "user", roles: [] }),
  });
  const body = (await res.json()) as { token?: string };
  if (!res.ok || !body.token) throw new Error(`Could not create sandbox user: ${JSON.stringify(body)}`);
  const host = REGISTRY.replace(/^https?:/, "");
  writeFileSync(USERCONFIG, `registry=${REGISTRY}\n${host}:_authToken=${body.token}\n`);
  writeFileSync(GLOBALCONFIG, "");
}

// ---------- scenarios ----------

function scenarioSilentUpdate(): { lockfile: string; baseline: string } {
  section("Scenario 1: a silent update arrives through a semver range");

  step("Baseline: the app installs tiny-pad@^1.0.0 and commits its lockfile");
  publish("1.0.0", "original");
  npm("install", APP);
  const baseline = runApp();
  const lockfile = readFileSync(join(APP, "package-lock.json"), "utf8");
  console.log(`  app output: ${JSON.stringify(baseline)}`);
  expect(installedVersion() === "1.0.0", "baseline installs tiny-pad@1.0.0");

  step("The maintainer publishes 1.0.1, changing the default pad character");
  publish("1.0.1", "changed");

  step("Unprotected: a fresh install without the lockfile (e.g. lockfile not committed)");
  wipeInstall(false);
  npm("install --prefer-online", APP);
  const drifted = runApp();
  console.log(`  installed tiny-pad@${installedVersion()}, app output: ${JSON.stringify(drifted)}`);
  expect(installedVersion() === "1.0.1", "the caret range silently pulls in 1.0.1");
  expect(drifted !== baseline, "the app's output changed without any change to the app's code");

  step("Mitigation: restore the committed lockfile and use `npm ci`");
  wipeInstall(false);
  writeFileSync(join(APP, "package-lock.json"), lockfile);
  npm("ci", APP);
  const pinned = runApp();
  console.log(`  installed tiny-pad@${installedVersion()}, app output: ${JSON.stringify(pinned)}`);
  expect(installedVersion() === "1.0.0", "npm ci installs exactly what the lockfile says");
  expect(pinned === baseline, "the app's output is unchanged");

  return { lockfile, baseline };
}

async function scenarioInstallScript() {
  section("Scenario 2: installing a package runs its code");
  const markerPath = join(APP, MARKER);

  step("The maintainer publishes 1.1.0 with a postinstall script");
  publish("1.1.0", "postinstall");

  step("Detection first: resolve a lockfile WITHOUT installing, then scan it with deps-xray");
  rmSync(markerPath, { force: true });
  wipeInstall(false);
  npm("install --package-lock-only --prefer-online", APP);
  const graph = await parseLockfileAt(join(APP, "package-lock.json"));
  const flagged = [...graph.nodes.values()].filter((n) => n.hasInstallScript).map((n) => n.id);
  console.log(`  packages with install scripts: ${flagged.join(", ") || "(none)"}`);
  expect(flagged.includes("tiny-pad@1.1.0"), "deps-xray flags tiny-pad@1.1.0 from the lockfile alone");
  expect(!existsSync(markerPath), "nothing has run yet: --package-lock-only executes no package code");

  step("Unprotected: a normal fresh install");
  wipeInstall(false);
  npm("install --prefer-online", APP);
  console.log(`  installed tiny-pad@${installedVersion()}`);
  expect(existsSync(markerPath), `the postinstall script ran and wrote ${MARKER} into the project`);
  if (existsSync(markerPath)) console.log(`  ${readFileSync(markerPath, "utf8").trim().replace(/\n/g, "\n  ")}`);

  step("Mitigation: install with --ignore-scripts");
  rmSync(markerPath, { force: true });
  wipeInstall(false);
  npm("install --prefer-online --ignore-scripts", APP);
  console.log(`  installed tiny-pad@${installedVersion()}, app output: ${JSON.stringify(runApp())}`);
  expect(!existsSync(markerPath), "no script ran, but the package is installed and works");
}

function scenarioVanishingPackage(lockfile: string, baseline: string) {
  section("Scenario 3: the package disappears from the registry");

  step("The maintainer unpublishes tiny-pad entirely");
  const r = npm("unpublish tiny-pad --force", APP);
  if (!r.ok) throw new Error(`unpublish failed:\n${r.output}`);
  console.log("  tiny-pad removed from the local registry");

  step("Unprotected: a new machine (empty cache) tries to install");
  wipeInstall(false);
  const freshCache = join(WORK, "npm-cache-new-machine");
  rmSync(freshCache, { recursive: true, force: true });
  const fresh = npm("install", APP, freshCache);
  const reason = fresh.output.split("\n").find((l) => /E404|404|not found/i.test(l)) ?? "";
  console.log(`  install ${fresh.ok ? "succeeded" : "failed"}${reason ? `: ${reason.trim()}` : ""}`);
  expect(!fresh.ok, "the build breaks: there is nothing left to download");

  step("Mitigation: committed lockfile + an existing cache/mirror, installed offline");
  wipeInstall(false);
  writeFileSync(join(APP, "package-lock.json"), lockfile);
  const offline = npm("ci --offline", APP);
  console.log(`  npm ci --offline ${offline.ok ? "succeeded" : "failed"}`);
  expect(offline.ok && installedVersion() === "1.0.0", "the lockfile's exact tarball is restored from cache");
  expect(offline.ok && runApp() === baseline, "the app still works with the package gone upstream");
}

// ---------- main ----------

async function main() {
  console.log("deps-xray sandbox: local-only dependency failure demos");
  console.log(`registry: ${REGISTRY} (no uplinks; nothing reaches the public npm registry)`);

  rmSync(WORK, { recursive: true, force: true });
  rmSync(REGISTRY_DATA, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(join(SANDBOX, "demo-app"), APP, { recursive: true });

  const registry = await startRegistry();
  const stop = () => registry.kill();
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    await login();
    const { lockfile, baseline } = scenarioSilentUpdate();
    await scenarioInstallScript();
    scenarioVanishingPackage(lockfile, baseline);
  } finally {
    stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(70)}\nSummary: ${results.length - failed.length}/${results.length} checks behaved as expected`);
  for (const f of failed) console.log(`  ✘ [${f.scenario}] ${f.check}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`\nSandbox error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});