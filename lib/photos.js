import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NAS_PHOTOS_ROOT } from "./config.js";

const IMAGE_RE = /\.(jpe?g|png)$/i;

export function assertNasMounted(path = NAS_PHOTOS_ROOT) {
  if (!existsSync(path)) {
    throw new Error(`NAS path not found - mount likely not up: ${path}`);
  }
}

// Resolves a user-facing relative folder path against the NAS root, refusing
// to escape it (the folder name arrives from the browser as a query param).
export function resolveFolder(relFolder = "") {
  const clean = relFolder.split("/").filter((seg) => seg && seg !== "." && seg !== "..");
  const full = join(NAS_PHOTOS_ROOT, ...clean);
  if (full !== NAS_PHOTOS_ROOT && !full.startsWith(NAS_PHOTOS_ROOT + sep)) {
    throw new Error("invalid folder path");
  }
  return full;
}

// Every folder under the NAS root, flattened, for a single-select dropdown
// instead of drilling down one level at a time (most trip folders here are
// flat anyway, so a tree adds a click for little benefit).
export function listFoldersRecursive(dir) {
  let results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "#recycle") continue;
    const fullPath = join(dir, entry.name);
    results.push(fullPath);
    results = results.concat(listFoldersRecursive(fullPath));
  }
  return results;
}

export function listPhotosRecursive(dir) {
  let results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "#recycle") continue;
      results = results.concat(listPhotosRecursive(fullPath));
    } else if (IMAGE_RE.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

// Photos directly under a folder (non-recursive) plus a flag for whether any
// subfolders also hold photos, so the UI can offer "include subfolders".
export function listPhotosInFolder(dir) {
  return readdirSync(dir)
    .filter((entry) => IMAGE_RE.test(entry))
    .sort()
    .map((entry) => join(dir, entry));
}

export function toRelPath(absPath) {
  return relative(NAS_PHOTOS_ROOT, absPath).split(sep).join("/");
}

export function fromRelPath(relPath) {
  const full = resolveFolder(relPath);
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new Error(`photo not found: ${relPath}`);
  }
  return full;
}

export function pickRandom(files) {
  return files[Math.floor(Math.random() * files.length)];
}
