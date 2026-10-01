# deps-xray

**Dependencies: other people's code — a source of, and a threat to, software.**

Modern applications are built mostly from code their authors never wrote. A project that
chooses two packages can end up installing hundreds, maintained by people its developers have
never heard of, sitting many links away from anything they deliberately picked. That code is a
huge source of productivity, and it is also a large, mostly invisible attack surface.

deps-xray is a proof of concept that makes this visible. It has three parts:

| Part | Status | What it does |
| --- | --- | --- |
| **1. Dependency X-ray** | ✅ Done | Measures what you chose versus what you actually install |
| **2. Risk score** | 🔜 Next | Combines registry, vulnerability, and project-health data into a per-package score |
| **3. Failure-mode sandbox** | ✅ Done | Reproduces three real-world dependency failures, offline, with working mitigations |

This repository accompanies a short paper and a blog post on the same topic.

---

## Contents

- [Quick start](#quick-start)
- [The X-ray](#the-x-ray)
- [The sandbox](#the-sandbox)
- [Example results](#example-results)
- [Methodology](#methodology)
- [Project structure](#project-structure)
- [Saving results](#saving-results)
- [Development](#development)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Safety](#safety)

---

## Quick start

Requirements: **Node.js 20 or newer** and npm 7 or newer.

```bash
git clone <this-repo>
cd deps-xray
npm install
npm test

# X-ray this project's own dependencies
npx tsx src/cli.ts
```

To X-ray any other project:

```bash
npx tsx src/cli.ts path/to/package-lock.json
```

> **Windows / PowerShell users:** call the CLI with `npx tsx src/cli.ts ...` rather than
> `npm run xray -- ...`. PowerShell can swallow the `--` separator, so your flags never reach
> the tool. If arrows (`→`, `←`) appear garbled, run
> `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` once per session.

---

## The X-ray

The X-ray reads a `package-lock.json`, rebuilds the dependency graph exactly as Node would
resolve it, and reports:

- **Direct vs. installed:** how many packages you chose, how many you actually get, and the
  multiplier between them.
- **Depth:** how many hops the farthest package sits from your project, with the full chain
  printed so you can see exactly how it got there.
- **Install scripts:** packages that run code on your machine during `npm install`.
- **Duplicates:** packages installed in more than one version (each copy is separate code to
  patch when a vulnerability lands).
- **Blast radius:** the packages the most other packages depend on.
- **Licenses:** what licenses you have accepted, knowingly or not.
- **Unresolved dependencies:** declared dependencies missing from the lockfile, a sign it may
  be broken.

### Options

| Option | Effect |
| --- | --- |
| `--prod` | Only count dependencies that ship to production (skip dev-only packages) |
| `--all-platforms` | Also count OS/CPU-specific optional packages for every platform (see [Methodology](#methodology)) |
| `--json` | Print machine-readable JSON instead of the text report |
| `--top <n>` | How many items to list per section (default 10) |
| `-h`, `--help` | Show help |

### X-ray a project without installing it

You don't need to install a project, or run any of its code, to analyse it:

```bash
cd some-project
npm install --package-lock-only
```

This resolves the full dependency tree and writes `package-lock.json`, but downloads nothing
and runs **no install scripts**. There is no `node_modules` folder afterwards. This is the safe
way to inspect a project before trusting it.

### Zero runtime dependencies

deps-xray itself has no runtime dependencies. Argument parsing uses Node's built-in
`node:util` `parseArgs`, and file access uses `node:fs`. Run `npx tsx src/cli.ts --prod` on
this repository and the answer is **0 packages**.

---

## The sandbox

The `sandbox/` folder reproduces three real-world dependency failures, each followed by a
mitigation that prevents it. Every outcome is checked automatically, so a run doubles as a test
of the claims made in the paper.

```bash
cd sandbox
npm install
npm run demo
```

A successful run ends with:

```
Summary: 12/12 checks behaved as expected
```

The script exits with a non-zero code if any check does not behave as expected. No Docker is
needed.

### The scenarios

| # | Scenario | Real-world pattern | Failure demonstrated | Mitigation demonstrated |
| --- | --- | --- | --- | --- |
| 1 | Silent update | event-stream (2018), ua-parser-js (2021) | A `^1.0.0` range silently pulls in a behaviour-changing `1.0.1`; the app's output changes with no change to its code | Committed lockfile + `npm ci` |
| 2 | Install scripts | Install-time malware in compromised packages | A `postinstall` script runs during a normal install and writes a file into the project | Detect it first with deps-xray from a `--package-lock-only` lockfile; install with `--ignore-scripts` |
| 3 | Vanishing package | left-pad (2016) | The package is unpublished and a fresh machine cannot install | Committed lockfile + cache/mirror, installed with `npm ci --offline` |

The demo app prints an invoice number padded by a tiny package called `tiny-pad`. Across the
scenarios, `tiny-pad` is published in three versions:

| Version | Behaviour |
| --- | --- |
| `1.0.0` | Pads with spaces: `Invoice #      42` |
| `1.0.1` | "Helpfully" pads with zeros instead: `Invoice #00000042` |
| `1.1.0` | Same as 1.0.1, plus a `postinstall` script that writes `SANDBOX-MARKER.txt` into the installing project |

The postinstall script is deliberately harmless. Its point is that it *could* have run any
command the user's account can: reading SSH keys, stealing tokens from `.npmrc`, or installing
a backdoor.

### How the sandbox is isolated

- **A private registry.** The demo starts [Verdaccio](https://verdaccio.org) on `127.0.0.1:4873`
  only, so nothing else on the network can reach it.
- **No uplinks.** `sandbox/verdaccio.yaml` has no `uplinks` section, so the registry never
  talks to the public npm registry. You can verify this yourself: with Verdaccio running,
  `npm view express --registry http://127.0.0.1:4873/ --prefer-online` fails with a 404.
- **Isolated npm configuration.** Every npm command the demo runs uses its own
  `--userconfig`, `--globalconfig`, `--cache`, and `--registry`, and inherited `npm_config_*`
  environment variables are removed. Your personal `.npmrc` and npm cache are never read or
  written.
- **A clean slate every run.** Generated files live in `sandbox/.work/` and
  `sandbox/.registry/`, both deleted at the start of each run and excluded from git.

### Why the sandbox is a separate package

Verdaccio brings in hundreds of packages of its own. Keeping the sandbox in its own
`package.json` means none of them appear in deps-xray's own dependency tree. (X-ray
`sandbox/package-lock.json` to see the cost of "just one tool".)

---

## Example results

From a sample web API with one production dependency (Express) and one dev dependency (Jest),
analysed on **1 October 2026** with `npm install --package-lock-only`:

| Measure | All dependencies | Production only |
| --- | --- | --- |
| Chosen (direct) | 2 | 1 |
| Actually installed | **337** | **66** |
| Multiplier | 168.5x | 66.0x |
| Dev-only | 271 (80%) | — |
| Deepest chain | 10 hops | 7 hops |
| Install scripts | 2 | 0 |
| Packages in multiple versions | 19 | 1 |
| Most depended-on package | `@babel/core` (25 dependents) | `es-errors` (8 dependents) |

The deepest production chain, from a project that chose only Express:

```
sample-app → express@5.2.1 → qs@6.16.0 → side-channel@1.1.1 → side-channel-map@1.0.1
           → get-intrinsic@1.3.0 → get-proto@1.0.1 → dunder-proto@1.0.1
```

Key observations:

- **Most of the risk never ships, but still runs.** 80% of installed packages are dev-only.
  They never reach users, but they run on every developer's machine and in CI, exactly where
  supply-chain attacks tend to aim. Dev dependencies are not harmless dependencies.
- **Install scripts live in the dev tree.** Production has none; the test framework's tree
  has two.
- **The ecosystem moves underneath you.** An earlier run of the same two commands resolved
  Express 4 and Jest 29 (329 installed, 68 in production). Same commands, different results,
  because new versions were published in between. Results are therefore dated, and the exact
  lockfiles analysed are kept in `results/`.

Full reports, JSON output, and the analysed lockfiles are in [`results/`](results/).

---

## Methodology

These decisions shape every number the X-ray reports.

**A node is a package at a specific version.** npm may install the same `name@version` in
several `node_modules` folders. That is still one piece of code being trusted, so it counts
once. Its install locations are recorded on the node.

**Edges follow Node's module resolution.** The lockfile records what each package *declares*
(`"shared": "^2.0.0"`), not which installed copy it actually loads. deps-xray resolves each
dependency the way Node does: look in the package's own `node_modules`, then walk up one
directory at a time to the project root. This correctly connects packages to nested duplicate
versions.

**Depth is the shortest distance from the project.** Dependency graphs can contain cycles, so
"longest path" is not well defined. Depth is computed with breadth-first search and answers:
*how many hops is this code from anything I actually chose?*

**Only reachable packages count.** Every statistic is computed over packages reachable from
the project, not every lockfile entry. This is what makes `--prod` consistent: dev-only
packages are unreachable in that view, so they drop out of every statistic at once.

**Dev vs. production.** A package counts as dev-only only if *every* installed copy is
dev-only. One production copy means it ships. The project's own `devDependencies` count; an
installed package's `devDependencies` do not, because npm never installs them.

**OS/CPU-specific optional packages are excluded by default.** Packages such as
`@esbuild/linux-x64` are listed in the lockfile for every platform, but npm installs only the
one matching the machine. Counting all of them inflates totals (on this project's own lockfile,
it nearly tripled the count). By default, every optional package with `os` or `cpu`
restrictions is excluded, and the report states how many. This keeps results comparable across
machines; the trade-off is that the one binary actually installed on the analysing machine is
also excluded. `--all-platforms` includes them all.

**Unresolved dependencies are reported only for packages in scope.** Missing dependencies of
packages that are excluded (for example, a WebAssembly-only binary) are not warnings.

**Workspaces.** In monorepos, `node_modules/<name>` entries that link to workspace folders are
followed to the real package. Workspace packages are treated as direct dependencies of the
project, and their own `devDependencies` are counted, since npm installs them.

**Supported lockfiles.** `lockfileVersion` 2 and 3 (npm 7+). Older v1 lockfiles are rejected
with instructions to regenerate them.

---

## Project structure

```
deps-xray/
├── src/
│   ├── cli.ts                 Command-line entry point (built-in parseArgs)
│   ├── graph/
│   │   ├── types.ts           Shared data model: PkgNode, DepGraph
│   │   └── stats.ts           Breadth-first search and all X-ray findings
│   ├── lockfile/
│   │   └── parse.ts           package-lock.json v2/v3 parser and Node-style resolution
│   └── report/
│       └── text.ts            Human-readable report (formatting only, no computation)
├── test/
│   ├── fixtures/
│   │   └── basic-lock.json    Hand-built lockfile covering the tricky cases
│   ├── parse.test.ts          Parser tests
│   └── stats.test.ts          Statistics tests
├── sandbox/
│   ├── run-demo.ts            The three scenarios, with automatic checks
│   ├── verdaccio.yaml         Local-only registry configuration (no uplinks)
│   ├── demo-app/              The app that depends on tiny-pad
│   ├── package.json           Separate package: Verdaccio stays out of the tool's tree
│   └── tsconfig.json          Type-checking for the demo script
├── results/                   Dated, reproducible outputs used in the paper
├── package.json
└── tsconfig.json
```

Data flows in one direction: **lockfile → `parse.ts` → `DepGraph` → `stats.ts` → `XrayStats`
→ text report or JSON.** The risk score will plug in between the graph and the report.

---

## Saving results

Each analysis is saved in a dated folder, together with the exact inputs and environment, so
it can be reproduced later even after the ecosystem has moved on.

From the repository root in PowerShell:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dir = "results\$(Get-Date -Format 'yyyy-MM-dd')"
New-Item -ItemType Directory -Force $dir | Out-Null

npx tsx src/cli.ts ..\sample-app\package-lock.json | Out-File -Encoding utf8 "$dir\sample-app-all.txt"
npx tsx src/cli.ts ..\sample-app\package-lock.json --prod | Out-File -Encoding utf8 "$dir\sample-app-prod.txt"
npx tsx src/cli.ts ..\sample-app\package-lock.json --json | Out-File -Encoding utf8 "$dir\sample-app-all.json"
npx tsx src/cli.ts ..\sample-app\package-lock.json --prod --json | Out-File -Encoding utf8 "$dir\sample-app-prod.json"

Copy-Item ..\sample-app\package.json "$dir\sample-app-package.json"
Copy-Item ..\sample-app\package-lock.json "$dir\sample-app-package-lock.json"

Push-Location sandbox
npm run demo | Out-File -Encoding utf8 "..\$dir\demo-run.txt"
Pop-Location

"node $(node --version)", "npm $(npm --version)", "$([System.Environment]::OSVersion.VersionString)" |
  Out-File -Encoding utf8 "$dir\environment.txt"
```

On macOS or Linux, use `>` redirection instead of `Out-File`.

To re-run a past analysis exactly:

```bash
npx tsx src/cli.ts results/2026-10-01/sample-app-package-lock.json
```

> **Note:** Windows PowerShell 5.1 writes a byte-order mark with `-Encoding utf8`, which
> `JSON.parse` rejects. PowerShell 7 does not. Check with `$PSVersionTable.PSVersion`.

---

## Development

| Command | What it does |
| --- | --- |
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` | Type-check `src/` without emitting files |
| `npm run build` | Compile to `dist/` |
| `npx tsx src/cli.ts` | Run the CLI from source |
| `npx tsc -p sandbox` | Type-check the sandbox script (run from the repository root) |

Run `npx tsc -p sandbox` from the **root**, not from inside `sandbox/`. TypeScript is
installed at the root; inside `sandbox/`, `npx tsc` would not find it and would offer to
download an unrelated npm package that happens to be named `tsc`. It is a small, real example
of how easily a wrong package name can slip in.

### TypeScript 7 note

This project uses TypeScript 7, where the `types` compiler option defaults to an empty list.
Both