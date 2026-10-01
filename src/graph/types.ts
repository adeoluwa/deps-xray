/** Special id for the project itself (the "" entry in package-lock.json). */
export const ROOT_ID = "<root>";

/**
 * One package at one version: the unit of trust.
 * npm may install the same name@version in several node_modules folders;
 * those locations are collected in `paths` rather than becoming separate nodes.
 */
export interface PkgNode {
  id: string; // "name@version"
  name: string;
  version: string;
  paths: string[]; // install locations, e.g. "node_modules/a/node_modules/b"
  dev:boolean; // true only if EVERY install location is dev-only
  optional: boolean; // true only if EVERY install location is optional
  hasInstallScript: boolean; // runs code at install time (pre/post/install)
  workspace: boolean; // a local workspace package, not from the registry
  /** Optional and restricted by os/cpu: only installed on matching machines (e.g. @esbuild/linux-x64). */
  platformSpecific: boolean;
  license?: string;
  resolved?: string // tarball URL the lockfile points at
  integrity?: string // hash npm verifies the tarball against
}

export interface DepGraph {
  rootName: string;
  rootVersion: string;
  lockfileVersion: number;
  nodes: Map<string, PkgNode>;
  /** id -> ids it depends on.Included ROOT_ID as a source. */
  edges: Map<string, Set<string>>;
  /** Declared dependencies npm could not find in the tree (usually a sign of a broken lockfile). */
  unresolved: Array<{from: string; dependency: string; kind: DepKind }>;
}

export type DepKind = "prod" | "dev" | "optional" | "peer";