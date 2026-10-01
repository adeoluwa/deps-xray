import { readFile } from "node:fs/promises";
import {
  ROOT_ID,
  type DepGraph,
  type DepKind,
  type PkgNode,
} from "../graph/types.js";

/** The subset of a package-lock.json "packages" entry we care about. */
interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  hasInstallScript?: boolean;
  license?: string;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Lockfile {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

export class LockfileError extends Error {}

export async function parseLockfileAt(path: string): Promise<DepGraph> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new LockfileError(
      `Could not read ${path}. Is there a package-lock.json here?`,
    );
  }

  let json: Lockfile;
  try {
    json = JSON.parse(raw) as Lockfile;
  } catch {
    throw new LockfileError(`${path} is not valid JSON.`);
  }

  return parseLockfile(json);
}

/** Package name from an install path: the part after the LAST "node_modules" */
export function nameFromPath(path: string): string {
  const marker = "node_modules/";
  const i = path.lastIndexOf(marker);
  return i === -1 ? path : path.slice(i + marker.length);
}

/**
 * Where Node would find `dep`when required from the package at `fromDir`:
 * fromDir/node_modules/dep, then each parent directory's node_modules/dep, up to the root.
 */
export function resolveLocation(
  fromDir: string,
  dep: string,
  exists: (loc: string) => boolean,
): string | undefined {
  let dir = fromDir;
  for (;;) {
    const lastSegment = dir.slice(dir.lastIndexOf("/") + 1);

    // Never look inside node_modules/node_modules; Node doesn't either.
    if (lastSegment !== "node_modules") {
      const candidate =
        dir === "" ? `node_modules/${dep}` : `${dir}/node_modules/${dep}`;
      if (exists(candidate)) return candidate;
    }

    if (dir === "") return undefined;
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
  }
}

function isPlatformRestricted(entry: LockEntry): boolean {
  return (entry.os?.length ?? 0) > 0 || (entry.cpu?.length ?? 0) > 0;
}

export function parseLockfile(lock: Lockfile): DepGraph {
  const version = lock.lockfileVersion ?? 1;

  if (version < 2 || !lock.packages) {
    throw new LockfileError(
      `Lockfile version ${version} is not supported. Regenerate it with npm 7+ ` +
        `(e.g. "npm install --package-lock-only") to get lockfileVersion 2 or 3.`,
    );
  }

  const packages = lock.packages;
  const root = packages[""] ?? {};

  const graph: DepGraph = {
    rootName: root.name ?? lock.name ?? "(unnamed project)",
    rootVersion: root.version ?? lock.version ?? "0.0.0",
    lockfileVersion: version,
    nodes: new Map(),
    edges: new Map([[ROOT_ID, new Set()]]),
    unresolved: [],
  };

  /** install location -> node id */
  const locToId = new Map<string, string>();

  /** install location -> directory whose node-modules its own deps resolve from */
  const locToRealDir = new Map<string, string>();
  const workspaceIds = new Set<string>();

  // Pass 1: create nodes. Only paths under node_modules are installs; plain folders
  // like "packages/a" are workspaces sources, reaches through their link entries.
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || !path.includes("node_modules/")) continue;

    const isLink = entry.link === true && typeof entry.resolved === "string";
    const realDir = isLink ? entry.resolved! : path;
    const data: LockEntry = isLink ? (packages[realDir] ?? {}) : entry;
    const isWorkspace = isLink && !realDir.includes("node_modules/");

    const name = nameFromPath(path);
    const ver = data.version ?? "0.0.0-unknown";
    const id = `${name}@${ver}`;
    const dev = entry.dev === true || data.dev === true;
    const optional = entry.optional === true || data.optional === true;

    const existing = graph.nodes.get(id);
    if (existing) {
      existing.paths.push(path);
      existing.dev &&= dev; // dev-only if every location is dev-only
      existing.optional &&= optional;
      existing.platformSpecific &&= optional && isPlatformRestricted(data);
    } else {
      const node: PkgNode = {
        id,
        name,
        version: ver,
        paths: [path],
        dev,
        optional,
        hasInstallScript: data.hasInstallScript === true,
        workspace: isWorkspace,
        platformSpecific: optional && isPlatformRestricted(data),
        license: data.license,
        resolved: data.resolved,
        integrity: data.integrity,
      };
      graph.nodes.set(id, node);
      graph.edges.set(id, new Set());
    }
    locToId.set(path, id);
    locToRealDir.set(path, realDir);
    if (isWorkspace) workspaceIds.add(id);
  }

  const exists = (loc: string) => locToId.has(loc);

  const addEdges = (
    fromId: string,
    fromDir: string,
    entry: LockEntry,
    includeDev: boolean,
  ) => {
    const declared: Array<[string, DepKind]> = [
      ...Object.keys(entry.dependencies ?? {}).map((d): [string, DepKind] => [
        d,
        "prod",
      ]),
      ...Object.keys(entry.optionalDependencies ?? {}).map(
        (d): [string, DepKind] => [d, "optional"],
      ),
      ...Object.keys(entry.peerDependencies ?? {}).map(
        (d): [string, DepKind] => [d, "peer"],
      ),
      ...(includeDev
        ? Object.keys(entry.devDependencies ?? {}).map(
            (d): [string, DepKind] => [d, "dev"],
          )
        : []),
    ];

    const targets = graph.edges.get(fromId)!;
    for (const [dep, kind] of declared) {
      const loc = resolveLocation(fromDir, dep, exists);
      if (loc) {
        targets.add(locToId.get(loc)!);
      } else {
        // Missing optional deps (wrong OS/CPU) and optional peers are normal.
        const optionalPeer =
          entry.peerDependenciesMeta?.[dep]?.optional === true;
        if (kind !== "optional" && !(kind === "peer" && optionalPeer)) {
          graph.unresolved.push({ from: fromId, dependency: dep, kind });
        }
      }
    }
  };

  // Pass 2: edges. The root also owns its devDependencies; installed packages'
  // devDependencies are never installed, so they are ignored.
  addEdges(ROOT_ID, "", root, true);
  for (const id of workspaceIds) graph.edges.get(ROOT_ID)!.add(id);

  for (const [path, id] of locToId) {
    const realDir = locToRealDir.get(path)!;
    const entry = packages[realDir] ?? {};
    // Workspace packages declare devDependencies that npm does install.
    addEdges(id, realDir, entry, workspaceIds.has(id));
  }

  return graph;
}
