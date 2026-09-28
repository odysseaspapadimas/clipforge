import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const renderer = resolve(import.meta.dir, "../renderer");

// Alchemy builds with renderer/ as the Docker context. Imports that reach back
// into src/ work in root-level tests but crash the deployed Container at boot.
test("the renderer Docker image contains every local TypeScript import", () => {
  const dockerfile = readFileSync(resolve(renderer, "Dockerfile"), "utf8");
  const copied = new Set(Array.from(dockerfile.matchAll(/^COPY\s+(.+)\s+\.\/$/gm))
    .flatMap(([, files]) => files.split(/\s+/)));
  const checked = new Set<string>();
  function check(file: string) {
    expect(file.startsWith(`${renderer}/`)).toBe(true);
    expect(copied.has(basename(file))).toBe(true);
    if (checked.has(file)) return;
    checked.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, relative] of source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      check(resolve(dirname(file), relative));
    }
  }
  check(resolve(renderer, "server.ts"));
  expect(checked.has(resolve(renderer, "caption-style.ts"))).toBe(true);
});
