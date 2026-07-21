import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Candidate roots: dist sibling, package root, and cwd (Nixpacks / Docker). */
function candidateRoots(): string[] {
  return [
    join(here), // dist/ when built, or src/ in tsx
    join(here, ".."),
    join(here, "..", ".."),
    process.cwd(),
  ];
}

function resolveDir(name: string): string {
  for (const root of candidateRoots()) {
    const path = join(root, name);
    if (existsSync(path)) return path;
  }
  // Prefer package-root style path for error messages / first boot.
  return join(here, "..", name);
}

export function resolvePublicDir(): string {
  return resolveDir("public");
}

export function resolveTemplatesDir(): string {
  return resolveDir("templates");
}

export function resolveBrandFile(filename: string): string | null {
  const publicDir = resolvePublicDir();
  const path = join(publicDir, "brand", filename);
  return existsSync(path) ? path : null;
}
