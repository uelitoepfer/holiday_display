import express from "express";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import {
  NAS_PHOTOS_ROOT,
  OUT_PATH,
  SETTINGS_PATH,
} from "./lib/config.js";
import { ditherToSpectra6, filterByOrientation, getOrientation, pngToEpdRaw } from "./lib/dither.js";
import {
  assertNasMounted,
  resolveFolder,
  listFoldersRecursive,
  listPhotosInFolder,
  listPhotosRecursive,
  toRelPath,
  fromRelPath,
  pickRandom,
} from "./lib/photos.js";
import { readSettings, writeSettings } from "./lib/settings.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PREVIEW_PATH = new URL("./data/preview.png", import.meta.url).pathname;

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function handleErrors(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(500).json({ error: err.message });
    });
  };
}

// Browse: photos directly inside a given relative folder under the NAS root.
app.get("/api/browse", handleErrors(async (req, res) => {
  assertNasMounted();
  const relFolder = req.query.folder || "";
  const dir = resolveFolder(relFolder);
  const photos = listPhotosInFolder(dir);
  res.json({
    folder: relFolder,
    photoCount: photos.length,
    photos: photos.map((p) => ({ rel: toRelPath(p), name: p.split("/").pop() })),
  });
}));

// Every folder under the NAS root, flattened, for the folder-picker dropdown.
app.get("/api/folders", handleErrors(async (req, res) => {
  assertNasMounted();
  const folders = listFoldersRecursive(NAS_PHOTOS_ROOT).map(toRelPath).sort();
  res.json({ folders });
}));

// Recursive photo count for a folder, used before committing to "random from this folder".
app.get("/api/photo-count", handleErrors(async (req, res) => {
  assertNasMounted();
  const dir = resolveFolder(req.query.folder || "");
  res.json({ count: listPhotosRecursive(dir).length });
}));

// Serves the raw source image (full size - the browser downscales for the grid/preview).
app.get("/api/image", handleErrors(async (req, res) => {
  const abs = fromRelPath(req.query.path || "");
  const type = MIME[extname(abs).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.send(readFileSync(abs));
}));

// Serves the current dithered display image - what the ESP should poll,
// since OUT_PATH now lives inside this project instead of Home Assistant's
// web-served www folder.
app.get("/display.png", handleErrors(async (req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.send(readFileSync(OUT_PATH));
}));

// Serves the current display image pre-packed for the panel's native 4bpp
// format, so the ESP just streams bytes to SPI without decoding a PNG.
// Supports conditional GET (ETag = OUT_PATH's mtime) so the ESP's periodic
// check-for-new-image poll costs a 304 with no body when nothing changed.
app.get("/display.raw", handleErrors(async (req, res) => {
  const stat = statSync(OUT_PATH);
  const etag = `"${Math.round(stat.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  const raw = await pngToEpdRaw(OUT_PATH);
  res.set("ETag", etag);
  res.set("Content-Type", "application/octet-stream");
  res.send(raw);
}));

// Landscape/portrait for a single photo, for the marker shown in the tuning drawer.
app.get("/api/orientation", handleErrors(async (req, res) => {
  const abs = fromRelPath(req.query.path || "");
  res.json(await getOrientation(abs));
}));

// Renders a photo through the dither pipeline with the given (possibly
// live-tuned) params and returns the PNG bytes, without touching OUT_PATH.
app.post("/api/preview", handleErrors(async (req, res) => {
  const { photo, params } = req.body;
  const abs = fromRelPath(photo);
  await ditherToSpectra6(abs, PREVIEW_PATH, params);
  res.setHeader("Content-Type", "image/png");
  res.send(readFileSync(PREVIEW_PATH));
}));

// Finalizes: dithers the chosen photo straight to OUT_PATH (what the ESP
// polls) and remembers the choice so reopening the UI starts from it.
app.post("/api/apply", handleErrors(async (req, res) => {
  const { photo, params, folder } = req.body;
  const abs = fromRelPath(photo);
  await ditherToSpectra6(abs, OUT_PATH, params);
  const settings = writeSettings({ photo, folder: folder ?? "", params });
  res.json({ ok: true, settings });
}));

// Picks a random photo from a folder (recursive) for the UI to load into the
// preview pane - does not touch OUT_PATH until /api/apply is called.
app.get("/api/random-photo", handleErrors(async (req, res) => {
  const dir = resolveFolder(req.query.folder || "");
  const files = listPhotosRecursive(dir);
  if (files.length === 0) throw new Error(`no photos found under ${req.query.folder || "/"}`);
  res.json({ photo: toRelPath(pickRandom(files)) });
}));

app.get("/api/settings", handleErrors(async (req, res) => {
  res.json(readSettings());
}));

// Enables/disables a server-side timer that periodically picks a new random
// photo from a folder and renders it to OUT_PATH - runs independently of the
// browser being open, since the ESP just polls OUT_PATH on its own schedule.
app.post("/api/auto-shuffle", handleErrors(async (req, res) => {
  const { enabled, folder, intervalMinutes, orientation, params } = req.body;
  const orient = ["landscape", "portrait", "either"].includes(orientation) ? orientation : "either";

  if (enabled) {
    const dir = resolveFolder(folder || "");
    const candidates = await filterByOrientation(listPhotosRecursive(dir), orient);
    if (candidates.length === 0) {
      throw new Error(`no ${orient === "either" ? "" : orient + " "}photos found under ${folder || "/"}`);
    }
  }
  const settings = writeSettings({
    autoShuffle: {
      enabled: !!enabled,
      folder: folder ?? "",
      intervalMinutes: Number(intervalMinutes) || 60,
      orientation: orient,
    },
    params: params ?? readSettings().params,
  });
  scheduleAutoShuffle(settings);
  res.json({ ok: true, settings });
}));

let autoShuffleTimer = null;

function scheduleAutoShuffle(settings) {
  clearInterval(autoShuffleTimer);
  autoShuffleTimer = null;
  if (!settings.autoShuffle?.enabled) return;

  const ms = Math.max(1, settings.autoShuffle.intervalMinutes) * 60_000;
  autoShuffleTimer = setInterval(async () => {
    try {
      const current = readSettings();
      const dir = resolveFolder(current.autoShuffle.folder || "");
      const files = await filterByOrientation(listPhotosRecursive(dir), current.autoShuffle.orientation);
      if (files.length === 0) throw new Error(`no photos found under ${current.autoShuffle.folder}`);
      const chosen = pickRandom(files);
      await ditherToSpectra6(chosen, OUT_PATH, current.params);
      writeSettings({ photo: toRelPath(chosen), folder: current.autoShuffle.folder });
      console.log(`[ok] auto-shuffle rendered ${toRelPath(chosen)}`);
    } catch (err) {
      console.error("[warn] auto-shuffle tick failed:", err.message);
    }
  }, ms);
}

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`[ok] holiday display picker listening on http://0.0.0.0:${PORT}`);
  console.log(`[info] NAS root: ${NAS_PHOTOS_ROOT}`);
  console.log(`[info] output:   ${OUT_PATH}`);
  console.log(`[info] settings: ${SETTINGS_PATH}`);
  scheduleAutoShuffle(readSettings());
});
