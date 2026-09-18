import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PALETTE_PATH, SPECTRA6_PALETTE, PANEL_WIDTH, PANEL_HEIGHT } from "./config.js";

const execFileAsync = promisify(execFile);
const MAGICK_BIN = process.env.MAGICK_BIN || "magick";
const MAGICK_FALLBACK_BIN = "convert";

export async function runMagick(args) {
  try {
    await execFileAsync(MAGICK_BIN, args);
  } catch (error) {
    const isMissingCmd = error?.code === "ENOENT";
    const allowFallback = !process.env.MAGICK_BIN && MAGICK_BIN !== MAGICK_FALLBACK_BIN;

    if (!isMissingCmd || !allowFallback) {
      throw error;
    }

    console.log(`[warn] ${MAGICK_BIN} not found, falling back to ${MAGICK_FALLBACK_BIN}`);
    await execFileAsync(MAGICK_FALLBACK_BIN, args);
  }
}

async function runIdentify(args) {
  try {
    return await execFileAsync(MAGICK_BIN, ["identify", ...args]);
  } catch (error) {
    const isMissingCmd = error?.code === "ENOENT";
    const allowFallback = !process.env.MAGICK_BIN && MAGICK_BIN !== MAGICK_FALLBACK_BIN;

    if (!isMissingCmd || !allowFallback) {
      throw error;
    }

    return await execFileAsync("identify", args);
  }
}

// Keeps only the files matching the requested orientation, using post-EXIF-
// rotation dimensions (-auto-orient) so a portrait phone photo tagged
// landscape-side-up isn't misclassified. Batches identify calls to keep
// argv sizes sane for folders with thousands of photos.
export async function filterByOrientation(files, orientation) {
  if (orientation !== "landscape" && orientation !== "portrait") return files;
  if (files.length === 0) return files;

  const CHUNK_SIZE = 300;
  const kept = [];

  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const { stdout } = await runIdentify(["-auto-orient", "-format", "%w %h\n", ...chunk]);
    const lines = stdout.trim().split("\n");

    chunk.forEach((file, idx) => {
      const [width, height] = (lines[idx] || "").trim().split(/\s+/).map(Number);
      if (!width || !height) return;
      const isLandscape = width >= height;
      if ((orientation === "landscape") === isLandscape) kept.push(file);
    });
  }

  return kept;
}

export async function ensurePalette() {
  if (existsSync(PALETTE_PATH)) return;

  mkdirSync(dirname(PALETTE_PATH), { recursive: true });
  const swatches = SPECTRA6_PALETTE.flatMap((color) => ["-size", "1x1", `xc:${color}`]);
  await runMagick([...swatches, "+append", PALETTE_PATH]);
  console.log(`[ok] wrote Spectra 6 palette swatch to ${PALETTE_PATH}`);
}

// Renders sourcePath -> destPath through the Spectra 6 dither pipeline.
// params: { brightness, saturation, hue, sigmoidalContrast, sigmoidalMidpoint }
// Same three steps as the original script: cover-crop to panel size, boost
// saturation/contrast before quantizing (flat 6-color palettes crush continuous
// tone photos to mud otherwise), then Floyd-Steinberg dither against the real
// 6-swatch palette rather than a generic -colors 6 quantization.
export async function ditherToSpectra6(sourcePath, destPath, params) {
  await ensurePalette();
  mkdirSync(dirname(destPath), { recursive: true });

  const modulate = `${params.brightness},${params.saturation},${params.hue}`;
  const sigmoidal = `${params.sigmoidalContrast}x${params.sigmoidalMidpoint}%`;

  await runMagick([
    sourcePath,
    "-auto-orient",
    "-resize", `${PANEL_WIDTH}x${PANEL_HEIGHT}^`,
    "-gravity", "center",
    "-extent", `${PANEL_WIDTH}x${PANEL_HEIGHT}`,
    "-modulate", modulate,
    "-sigmoidal-contrast", sigmoidal,
    "-dither", "FloydSteinberg",
    "-remap", PALETTE_PATH,
    destPath,
  ]);
}
