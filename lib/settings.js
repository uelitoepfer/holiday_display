import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_PATH, DEFAULT_DITHER_PARAMS } from "./config.js";

// Remembers the last-tuned dither params and the last-applied photo, purely
// so re-opening the web UI starts from where you left off.
const DEFAULTS = {
  params: DEFAULT_DITHER_PARAMS,
  folder: "",
  photo: "",
};

export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULTS, ...raw, params: { ...DEFAULT_DITHER_PARAMS, ...raw.params } };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}
