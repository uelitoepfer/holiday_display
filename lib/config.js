// Paths + tunables shared by the web app and the cron rotation script.
// Mirrors the layout convention from render-wall-display.mjs / render-holiday-display.mjs.

export const NAS_PHOTOS_ROOT = process.env.NAS_PHOTOS_ROOT || "/mnt/nas/photos";

export const OUT_PATH =
  process.env.HOLIDAY_OUT_PATH ||
  new URL("../data/holiday_display.png", import.meta.url).pathname;

export const PALETTE_PATH =
  process.env.HOLIDAY_PALETTE_PATH ||
  new URL("../data/spectra6_palette.png", import.meta.url).pathname;

export const SETTINGS_PATH = new URL("../data/settings.json", import.meta.url).pathname;

export const PANEL_WIDTH = 800;
export const PANEL_HEIGHT = 480;

// Spectra 6 primaries. These are close approximations of the panel's actual
// gamut (E-Ink doesn't publish exact sRGB values) - if colors look off,
// nudge these first before touching anything else in the pipeline.
export const SPECTRA6_PALETTE = [
  "#000000", // black
  "#FFFFFF", // white
  "#FF0000", // red
  "#FFF200", // yellow
  "#0000FF", // blue
  "#00A651", // green
];

// Defaults for the tunable dither params, exposed as sliders in the web UI.
export const DEFAULT_DITHER_PARAMS = {
  brightness: 105,
  saturation: 160,
  hue: 100,
  sigmoidalContrast: 3,
  sigmoidalMidpoint: 50,
};
