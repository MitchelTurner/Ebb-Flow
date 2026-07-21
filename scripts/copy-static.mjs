import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
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
