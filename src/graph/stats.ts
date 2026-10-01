import {
  ROOT_ID,
  type DepGraph,
  type DepKind,
  type PkgNode,
} from "../graph/types.js";

export interface XrayStats {
  project: string;
  lockfileVersion: number;
  scope: "all" | "prod";
  direct: number;
  transitive: number;
  total: number;
  devOnly: number;
  /** Optional OS/CPU-specific packages left out of the counts (only one per platform installs). */
  platformSpecificExcluded: number;
  maxDepth: number;
  /** One concrete chain from the project to a package at maxDepth. */
  deepestChain: string[];
  /** Packages installed in more than one version. */
  duplicates: Array<{ name: string; versions: string[] }>;
  installScripts: string[];
  /** Packages depended on by the most other packages: a rough blast-radius signal. */
  mostDependedOn: Array<{ id: string; dependents: number }>;
  licenses: Array<{ license: string; count: number }>;
  unresolved: DepGraph["unresolved"];
}

export interface StatsOptions {
  prodOnly?: boolean;
  /** Count OS/CPU-specific optional packages for every platform, not just one. */
  allPlatforms?: boolean;
  top?: number;
}

/** Breadth-first search from the root: shortest depth and parent of every reachable node. */
export function bfs(graph: DepGraph, include: (n: PkgNode) => boolean) {
  const depth = new Map<string, number>([[ROOT_ID, 0]]);
  const parent = new Map<string, string>();
  const queue: string[] = [ROOT_ID];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of graph.edges.get(current) ?? []) {
      const node = graph.nodes.get(next);
      if (!node || !include(node) || depth.has(next)) continue;
      depth.set(next, depth.get(current)! + 1);
      parent.set(next, current);
      queue.push(next);
    }
  }
  return { depth, parent };
}

export function computeStats(
  graph: DepGraph,
  opts: StatsOptions = {},
): XrayStats {
  const top = opts.top ?? 10;
  const scoped = (n: PkgNode) => !(opts.prodOnly && n.dev);
  const include = (n: PkgNode) =>
    scoped(n) && (opts.allPlatforms || !n.platformSpecific);
  const { depth, parent } = bfs(graph, include);
  const everything = bfs(graph, scoped).depth;
  const platformSpecificExcluded = everything.size - depth.size;

  const reachable = [...depth.keys()]
    .filter((id) => id !== ROOT_ID)
    .map((id) => graph.nodes.get(id)!);

  const direct = reachable.filter((n) => depth.get(n.id) === 1).length;

  // Deepest chain: find the farthest node, then follow parent pointers back to the root.
  let maxDepth = 0;
  let deepestId: string | undefined;
  for (const [id, d] of depth) {
    if (d > maxDepth) {
      maxDepth = d;
      deepestId = id;
    }
  }
  const deepestChain: string[] = [];
  for (let id = deepestId; id && id !== ROOT_ID; id = parent.get(id))
    deepestChain.unshift(id);
  deepestChain.unshift(graph.rootName);

  // Duplicate versions of the same package name.
  const byName = new Map<string, string[]>();
  for (const n of reachable)
    byName.set(n.name, [...(byName.get(n.name) ?? []), n.version]);
  const duplicates = [...byName]
    .filter(([, versions]) => versions.length > 1)
    .map(([name, versions]) => ({ name, versions: versions.sort() }))
    .sort(
      (a, b) =>
        b.versions.length - a.versions.length || a.name.localeCompare(b.name),
    );

  // Fan-in: how many reachable packages (or the project) depend on each package.
  const reachableSet = new Set(depth.keys());
  const dependents = new Map<string, number>();
  for (const from of reachableSet) {
    for (const to of graph.edges.get(from) ?? []) {
      if (reachableSet.has(to))
        dependents.set(to, (dependents.get(to) ?? 0) + 1);
    }
  }
  const mostDependedOn = [...dependents]
    .map(([id, count]) => ({ id, dependents: count }))
    .sort((a, b) => b.dependents - a.dependents || a.id.localeCompare(b.id))
    .slice(0, top);

  const licenseCounts = new Map<string, number>();
  for (const n of reachable) {
    const key = n.license ?? "(none declared)";
    licenseCounts.set(key, (licenseCounts.get(key) ?? 0) + 1);
  }

  return {
    project: `${graph.rootName}@${graph.rootVersion}`,
    lockfileVersion: graph.lockfileVersion,
    scope: opts.prodOnly ? "prod" : "all",
    direct,
    transitive: reachable.length - direct,
    total: reachable.length,
    devOnly: reachable.filter((n) => n.dev).length,
    platformSpecificExcluded,
    maxDepth,
    deepestChain,
    duplicates,
    installScripts: reachable
      .filter((n) => n.hasInstallScript)
      .map((n) => n.id)
      .sort(),
    mostDependedOn,
    licenses: [...licenseCounts]
      .map(([license, count]) => ({ license, count }))
      .sort((a, b) => b.count - a.count),
    unresolved: graph.unresolved.filter((u) => depth.has(u.from)),
  };
}
