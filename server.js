import express from "express";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  NAS_PHOTOS_ROOT,
  OUT_PATH,
  SETTINGS_PATH,
} from "./lib/config.js";
import { ditherToSpectra6 } from "./lib/dither.js";
import {
  assertNasMounted,
  resolveFolder,
  listSubfolders,
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

// Browse: subfolders + photo count at a given relative path under the NAS root.
app.get("/api/browse", handleErrors(async (req, res) => {
  assertNasMounted();
  const relFolder = req.query.folder || "";
  const dir = resolveFolder(relFolder);
  const folders = listSubfolders(dir);
  const photos = listPhotosInFolder(dir);
  res.json({
    folder: relFolder,
    folders,
    photoCount: photos.length,
    photos: photos.map((p) => ({ rel: toRelPath(p), name: p.split("/").pop() })),
  });
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

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`[ok] holiday display picker listening on http://0.0.0.0:${PORT}`);
  console.log(`[info] NAS root: ${NAS_PHOTOS_ROOT}`);
  console.log(`[info] output:   ${OUT_PATH}`);
  console.log(`[info] settings: ${SETTINGS_PATH}`);
});
