import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { parseLockfile, parseLockfileAt } from "../src/lockfile/parse.js";
import { computeStats } from "../src/graph/stats.js";

const fixture = fileURLToPath(
  new URL("./fixtures/basic-lock.json", import.meta.url),
);

describe("computeStats", () => {
  it("summarises the whole tree", async () => {
    const s = computeStats(await parseLockfileAt(fixture));
    expect(s.direct).toBe(3);
    expect(s.total).toBe(7);
    expect(s.transitive).toBe(4);
    expect(s.devOnly).toBe(2);
    // shared@1 is reachable in 2 hops via the dev tool, so the full tree is only 2 deep
    expect(s.maxDepth).toBe(2);
    expect(s.duplicates).toEqual([
      { name: "shared", versions: ["1.0.0", "2.0.0"] },
    ]);
    expect(s.installScripts).toEqual(["a@1.0.0"]);
    expect(s.mostDependedOn[0]!.dependents).toBe(2);
    expect(s.platformSpecificExcluded).toBe(0);
  });

  it("can restrict to production dependencies", async () => {
    const s = computeStats(await parseLockfileAt(fixture), { prodOnly: true });
    expect(s.direct).toBe(2);
    expect(s.total).toBe(5);
    expect(s.devOnly).toBe(0);
    // Without the dev shortcut, shared@1 is only reachable through a → c
    expect(s.maxDepth).toBe(3);
    expect(s.deepestChain).toEqual([
      "demo-app",
      "a@1.0.0",
      "c@1.0.0",
      "shared@1.0.0",
    ]);
  });

  it("leaves OS/CPU-specific optional packages out of counts by default", () => {
    const g = parseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {
          optionalDependencies: { "bin-linux": "1.0.0", "bin-mac": "1.0.0" },
        },
        "node_modules/bin-linux": {
          version: "1.0.0",
          optional: true,
          os: ["linux"],
        },
        "node_modules/bin-mac": {
          version: "1.0.0",
          optional: true,
          os: ["darwin"],
        },
      },
    });

    expect(computeStats(g).total).toBe(0);
    expect(computeStats(g).platformSpecificExcluded).toBe(2);
    expect(computeStats(g, { allPlatforms: true }).total).toBe(2);
  });

  it("ignores unresolved dependencies of packages that are out of scope", () => {
    const g = parseLockfile({
      lockfileVersion: 3,
      packages: {
        "": { optionalDependencies: { "bin-wasm": "1.0.0" } },
        "node_modules/bin-wasm": {
          version: "1.0.0",
          optional: true,
          cpu: ["wasm32"],
          dependencies: { ghost: "^1.0.0" },
        },
      },
    });
    expect(g.unresolved).toHaveLength(1); // the parser still records it...
    expect(computeStats(g).unresolved).toEqual([]); // ...but the X-ray doesn't report it
    expect(computeStats(g, { allPlatforms: true }).unresolved).toHaveLength(1);
  });
});
