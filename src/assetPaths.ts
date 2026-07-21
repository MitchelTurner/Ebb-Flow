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
  const candidates = [
    join(publicDir, "brand", filename),
    // Allow a root public/logo.png upload as a fallback for logo.png
    ...(filename === "logo.png" ? [join(publicDir, "logo.png")] : []),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}
