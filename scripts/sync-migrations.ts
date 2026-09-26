import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// drizzle-kit 0.x emits meta/_journal.json, which Alchemy v2 deliberately
// rejects. Keep Drizzle's generation history and a byte-identical flat SQL
// mirror for Alchemy's D1 migration runner. Never rewrite applied SQL files.
const source = resolve("drizzle"), target = resolve("migrations");
const files = readdirSync(source).filter((name) => name.endsWith(".sql")).sort();
const existing = (existsSync(target) ? readdirSync(target, { withFileTypes: true }) : [])
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name).sort();
if (process.argv.includes("--check")) {
  if (JSON.stringify(files) !== JSON.stringify(existing) || files.some((name) =>
    !readFileSync(resolve(source, name)).equals(readFileSync(resolve(target, name))))) {
    throw new Error("Alchemy migration mirror differs from drizzle; run bun scripts/sync-migrations.ts and inspect the diff");
  }
  console.log(`Verified ${files.length} immutable SQL migrations for Alchemy`);
} else {
  if (existing.some((name) => !files.includes(name))) throw new Error("Unexpected Alchemy migration: inspect before modifying history");
  mkdirSync(target, { recursive: true });
  for (const name of files) {
    const sql = readFileSync(resolve(source, name));
    if (existing.includes(name) && !sql.equals(readFileSync(resolve(target, name)))) {
      throw new Error(`Previously mirrored migration changed: ${name}`);
    }
    if (!existing.includes(name)) writeFileSync(resolve(target, name), sql);
  }
  console.log(`Mirrored ${files.length} SQL migrations for Alchemy`);
}
