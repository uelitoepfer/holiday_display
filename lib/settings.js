import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SETTINGS_PATH, DEFAULT_DITHER_PARAMS } from "./config.js";

// Remembers the last-tuned dither params and the last-applied photo, purely
// so re-opening the web UI starts from where you left off.
const DEFAULTS = {
  params: DEFAULT_DITHER_PARAMS,
  folder: "",
  photo: "",
  autoShuffle: {
    enabled: false,
    folder: "",
    intervalMinutes: 60,
    orientation: "either", // "landscape" | "portrait" | "either"
  },
  battery: {
    voltageMv: null,
    percent: null,
    updatedAt: null, // ISO timestamp of the last report from the ESP
  },
  // How long the ESP deep-sleeps between checks. It only picks up changes
  // the next time it wakes and calls the server - there's no way to push
  // this to a sleeping device.
  checkIntervalMinutes: 15,
};

export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return {
      ...DEFAULTS,
      ...raw,
      params: { ...DEFAULT_DITHER_PARAMS, ...raw.params },
      autoShuffle: { ...DEFAULTS.autoShuffle, ...raw.autoShuffle },
      battery: { ...DEFAULTS.battery, ...raw.battery },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}
