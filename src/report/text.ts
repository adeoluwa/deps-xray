import type { XrayStats } from "../graph/stats.js";

export function renderText(s: XrayStats, top = 10): string {
  const out: string[] = [];
  const line = (text = "") => out.push(text);

  /** Print up to `top` items, then summarise the rest. */
  const list = (items: string[]) => {
    for (const item of items.slice(0, top)) line(`  ${item}`);
    if (items.length > top) line(`  … and ${items.length - top} more`);
  };

  const deps = (n: number) => `${n} direct ${n === 1 ? "dependency" : "dependencies"}`;

  const multiplier = s.direct > 0 ? (s.total / s.direct).toFixed(1) : "n/a";

  const scope = s.scope === "prod" ? "production only" : "all dependencies";

  line(`deps-xray — ${s.project} (lockfile v${s.lockfileVersion}, ${scope})`);
  line();
  line(`You chose ${deps(s.direct)}.`);
  line(`You actually install ${s.total} packages (${s.transitive} transitive, ${multiplier}x multiplier).`);
  if (s.scope === "all") line(`${s.devOnly} of them are dev-only.`);
  if (s.platformSpecificExcluded > 0) {
    line(`(${s.platformSpecificExcluded} OS/CPU-specific optional packages not counted; use --all-platforms to include them.)`);
  }
  line(`Deepest dependency sits ${s.maxDepth} hops from your project:`);
  line(`  ${s.deepestChain.join(" → ")}`);
  line();

  line(`Install scripts (code that runs during npm install): ${s.installScripts.length}`);
  list(s.installScripts);
  line();

  line(`Packages installed in multiple versions: ${s.duplicates.length}`);
  list(s.duplicates.map((d) => `${d.name}: ${d.versions.join(", ")}`));
  line();

  line(`Most depended-on packages (blast radius):`);
  list(s.mostDependedOn.map((m) => `${m.id} ← ${m.dependents} ${m.dependents === 1 ? "dependent" : "dependents"}`));
  line();

  line(`Licenses:`);
  list(s.licenses.map((l) => `${l.license}: ${l.count}`));

  if (s.unresolved.length > 0) {
    line();
    line(`Warning: ${s.unresolved.length} declared dependencies were not found in the lockfile:`);
    list(s.unresolved.map((u) => `${u.from} → ${u.dependency} (${u.kind})`));
  }
  return out.join("\n");
}