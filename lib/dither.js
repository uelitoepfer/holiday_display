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

// Same fallback dance as runMagick, but captures stdout as a raw Buffer
// instead of discarding it - for pulling pixel data out via "RGB:-".
async function runMagickRaw(args) {
  const options = { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 };
  try {
    return (await execFileAsync(MAGICK_BIN, args, options)).stdout;
  } catch (error) {
    const isMissingCmd = error?.code === "ENOENT";
    const allowFallback = !process.env.MAGICK_BIN && MAGICK_BIN !== MAGICK_FALLBACK_BIN;

    if (!isMissingCmd || !allowFallback) {
      throw error;
    }

    return (await execFileAsync(MAGICK_FALLBACK_BIN, args, options)).stdout;
  }
}

// Native 4-bit wire-level color codes for the ED2208/GDEP073E01 controller
// (the real chip on the Seeed XIAO ePaper EE04 board), cross-validated
// against both ESPHome's epaper_spi_spectra_e6 driver and Seeed's own
// Seeed_GFX2 library (Driver_ED2208::colorGet's output values). Code 4 is
// unused by the panel. Order matches SPECTRA6_PALETTE in config.js.
const EPD_COLOR_CODES = [
  { r: 0, g: 0, b: 0, code: 0 }, // black
  { r: 255, g: 255, b: 255, code: 1 }, // white
  { r: 255, g: 0, b: 0, code: 3 }, // red
  { r: 255, g: 242, b: 0, code: 2 }, // yellow (#FFF200)
  { r: 0, g: 0, b: 255, code: 5 }, // blue
  { r: 0, g: 166, b: 81, code: 6 }, // green (#00A651)
];

function nearestEpdCode(r, g, b) {
  let best = EPD_COLOR_CODES[0];
  let bestDist = Infinity;
  for (const p of EPD_COLOR_CODES) {
    const dist = (r - p.r) ** 2 + (g - p.g) ** 2 + (b - p.b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best.code;
}

// Converts an already-dithered PNG (exactly PANEL_WIDTH x PANEL_HEIGHT, one
// of the 6 exact palette colors per pixel) into the panel's native 4bpp
// framebuffer format: 2 pixels per byte, first pixel in the high nibble,
// second in the low nibble, row-major - so the ESP can write it straight to
// the controller without needing a PNG decoder on-device. Falls back to
// nearest-color matching per pixel as a safety net, though -remap in
// ditherToSpectra6 should already have made every pixel an exact match.
export async function pngToEpdRaw(pngPath) {
  const rgb = await runMagickRaw([pngPath, "-depth", "8", "RGB:-"]);
  const pixelCount = PANEL_WIDTH * PANEL_HEIGHT;
  const expectedBytes = pixelCount * 3;
  if (rgb.length !== expectedBytes) {
    throw new Error(
      `unexpected raw pixel size: got ${rgb.length} bytes, expected ${expectedBytes} ` +
        `(is the image ${PANEL_WIDTH}x${PANEL_HEIGHT}?)`
    );
  }

  const packed = Buffer.alloc(pixelCount / 2);
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 3;
    const code = nearestEpdCode(rgb[off], rgb[off + 1], rgb[off + 2]);
    const byteIndex = i >> 1;
    if ((i & 1) === 0) {
      packed[byteIndex] = code << 4;
    } else {
      packed[byteIndex] |= code & 0x0f;
    }
  }
  return packed;
}

// Post-EXIF-rotation dimensions + a landscape/portrait label for a single
// file, for the "which way is this photo" marker in the tuning UI.
export async function getOrientation(file) {
  const { stdout } = await runIdentify(["-auto-orient", "-format", "%w %h", file]);
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  return { width, height, orientation: width >= height ? "landscape" : "portrait" };
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
