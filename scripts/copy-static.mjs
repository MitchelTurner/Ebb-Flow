import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Prefer package root next to this script; fall back to cwd (npm run build).
const root = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"))
  ? join(dirname(fileURLToPath(import.meta.url)), "..")
  : process.cwd();
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });

for (const dir of ["public", "templates", "sql"]) {
  const from = join(root, dir);
  const to = join(dist, dir);
  if (!existsSync(from)) {
    console.warn(`copy-static: skip missing ${dir}`);
    continue;
  }
  cpSync(from, to, { recursive: true });
  console.log(`copy-static: ${dir} → dist/${dir}`);
}
