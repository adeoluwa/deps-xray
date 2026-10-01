import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  parseLockfile,
  parseLockfileAt,
  nameFromPath,
  resolveLocation,
  LockfileError,
} from "../src/lockfile/parse.js";
import { ROOT_ID } from "../src/graph/types.js";

const fixture = fileURLToPath(
  new URL("./fixtures/basic-lock.json", import.meta.url),
);

describe("nameFromPath", () => {
  it("handles plain, nested and scoped paths", () => {
    expect(nameFromPath("node_modules/a")).toBe("a");
    expect(nameFromPath("node_modules/a/node_modules/shared")).toBe("shared");
    expect(nameFromPath("node_modules/x/node_modules/@scope/b")).toBe(
      "@scope/b",
    );
  });
});

describe("resolveLocation", () => {
  const present = new Set([
    "node_modules/a",
    "node_modules/a/node_modules/shared",
    "node_modules/shared",
  ]);
  const exists = (l: string) => present.has(l);

  it("prefers the nearest nested copy", () => {
    expect(resolveLocation("node_modules/a", "shared", exists)).toBe(
      "node_modules/a/node_modules/shared",
    );
  });
  it("falls back to the hoisted copy", () => {
    expect(resolveLocation("node_modules/c", "shared", exists)).toBe(
      "node_modules/shared",
    );
  });
  it("returns undefined when missing", () => {
    expect(resolveLocation("node_modules/a", "nope", exists)).toBeUndefined();
  });
});

describe("parseLockfile", () => {
  it("builds nodes and Node-style edges", async () => {
    const g = await parseLockfileAt(fixture);
    expect(g.nodes.size).toBe(7);
    expect([...g.edges.get(ROOT_ID)!].sort()).toEqual([
      "@scope/b@2.0.0",
      "a@1.0.0",
      "dev-tool@1.0.0",
    ]);
    // `a` must get its own nested shared@2, not the hoisted shared@1
    expect([...g.edges.get("a@1.0.0")!].sort()).toEqual([
      "c@1.0.0",
      "shared@2.0.0",
    ]);
    expect([...g.edges.get("c@1.0.0")!]).toEqual(["shared@1.0.0"]);
    expect(g.nodes.get("a@1.0.0")!.hasInstallScript).toBe(true);
    expect(g.nodes.get("dev-tool@1.0.0")!.dev).toBe(true);
    expect(g.unresolved).toEqual([]);
  });

  it("marks OS/CPU-specific optional packages", () => {
    const g = parseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {
          optionalDependencies: {
            "bin-linux": "1.0.0",
            "plain-optional": "1.0.0",
          },
        },
        "node_modules/bin-linux": {
          version: "1.0.0",
          optional: true,
          os: ["linux"],
        },
        "node_modules/plain-optional": { version: "1.0.0", optional: true },
      },
    });
    expect(g.nodes.get("bin-linux@1.0.0")!.platformSpecific).toBe(true);
    expect(g.nodes.get("plain-optional@1.0.0")!.platformSpecific).toBe(false);
  });

  it("rejects lockfile v1 with a helpful message", () => {
    expect(() => parseLockfile({ lockfileVersion: 1 })).toThrow(LockfileError);
  });

  it("reports declared-but-missing dependencies", () => {
    const g = parseLockfile({
      lockfileVersion: 3,
      packages: { "": { dependencies: { ghost: "^1.0.0" } } },
    });
    expect(g.unresolved).toEqual([
      { from: ROOT_ID, dependency: "ghost", kind: "prod" },
    ]);
  });

  it("follows workspace links", () => {
    const g = parseLockfile({
      lockfileVersion: 3,
      packages: {
        "": { name: "mono", workspaces: ["packages/*"] } as never,
        "node_modules/lib": { resolved: "packages/lib", link: true },
        "packages/lib": {
          name: "lib",
          version: "0.3.0",
          dependencies: { left: "^1.0.0" },
        },
        "node_modules/left": { version: "1.0.0" },
      },
    });
    const lib = g.nodes.get("lib@0.3.0")!;
    expect(lib.workspace).toBe(true);
    expect(g.edges.get(ROOT_ID)!.has("lib@0.3.0")).toBe(true);
    expect([...g.edges.get("lib@0.3.0")!]).toEqual(["left@1.0.0"]);
  });
});
