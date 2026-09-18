# Holiday Display ESP firmware

ESP32-S3 + PlatformIO firmware for the Seeed XIAO ePaper EE04 expansion
board (XIAO ESP32-S3 + 7.3" ACeP Spectra 6 / ED2208 color e-paper panel).
Every 15 minutes it asks the picker server "is there a new image?" and
only redraws the panel if so - otherwise it does nothing.

## Status

Not yet confirmed working end to end on real hardware. The SPI protocol
(command bytes, wire-level color codes, init sequence, busy-pin polarity)
is cross-validated against two independent, maintained sources for the
same ED2208/GDEP073E01 silicon:
[ESPHome's `epaper_spi_spectra_e6` driver](https://github.com/esphome/esphome/tree/dev/esphome/components/epaper_spi)
and [Seeed's own `Seeed_GFX2` library](https://github.com/Seeed-Studio/Seeed_GFX2)
(`Driver_ED2208::colorGet`) - not guessed from a datasheet. See the
comment at the top of `src/epd_spectra_e6.h` for the full provenance.

We deliberately don't depend on Seeed_GFX2 itself: as of 1.0.0 it has
internal `#include` paths that only resolve on case-insensitive
filesystems (macOS/Windows) plus ESP-IDF API version mismatches, and
doesn't build on Linux/PlatformIO without patching. Its source was still
extremely useful as a second, independent confirmation of the wire
protocol and (crucially) the actual EE04 pin mapping.

One specific unknown: whether the ESP32 Arduino core's `HTTPClient` handles
a bodyless `304 Not Modified` response cleanly. If the "check for new
image" logic seems to hang or misbehave, that's the first thing to check -
`http.GET()` in `checkAndUpdateDisplay()` in `src/main.cpp`.

## Wiring

This targets the Seeed XIAO ePaper EE04 board specifically - if that's
your hardware, no wiring or pin changes are needed, the EE04's PCB fixes
these:

| Signal | GPIO | XIAO alias |
|--------|------|------------|
| CS     | 44   | -          |
| DC     | 10   | -          |
| RST    | 38   | -          |
| BUSY   | 4    | -          |
| SCK    | 7    | D8         |
| MOSI (DIN) | 9 | D10       |
| Display power enable | 43 | - |

That last row matters: the EE04 gates the display's power rail behind
GPIO43, driven HIGH in `setup()` before anything else touches the panel.
Skip that and the panel won't respond to anything, with no obvious error -
it just looks like the SPI protocol is wrong when it isn't.

These numbers came from decoding Seeed_GFX2's
`Config_XIAO_ePaper_EE04_Board::pins()` (`src/board/configs/XIAO_EPaper_Board_Configs.h`)
against the XIAO ESP32-S3's D-pin aliases in Arduino-ESP32's
`variants/XIAO_ESP32S3/pins_arduino.h` - not measured on a scope, so
please verify against your actual board if anything seems off.

**On any ESP32-S3 board in general (not just this one), never use
GPIO26-32 for anything.** On N8/N16 modules those pins are wired
internally to the flash/PSRAM chip; using one as a GPIO corrupts flash
access and crashes the chip almost immediately - visible as a silent
reboot loop (`rst:0x8 (TG1WDT_SYS_RST)`) with no crash log, right after
boot. This bit us once already (an earlier revision of this firmware
copied pin defaults from Waveshare's plain-ESP32 driver board, which used
GPIO26). Also avoid GPIO19/20 (native USB D-/D+) and GPIO0/3/45/46
(strapping pins) on any S3 board.

## Setup

Secrets (WiFi + server address) are gitignored and won't survive a fresh
checkout - `setup_secrets.sh` regenerates `src/secrets.h` from values it
stores once, outside the repo, in `~/.holiday_display_secrets.env`:

```bash
cd firmware
bash setup_secrets.sh   # prompts once, then regenerates secrets.h instantly on every re-run

pio run --target upload
pio device monitor
```

## How the update check works

- `GET http://<server>/display.raw` with an `If-None-Match` header set to
  whatever ETag was returned last time.
- Server responds `304` (no body) if the display hasn't changed since -
  the ESP does nothing.
- Server responds `200` with a pre-packed framebuffer (2 pixels/byte, one
  of 6 native color codes per pixel - see `pngToEpdRaw` in the picker
  server's `lib/dither.js`) if the picker app rendered a new photo since
  the last check. The ESP streams that straight into the panel over SPI -
  no PNG decoding on-device.

The whole panel refresh (once triggered) takes a while - the epaper
`displayImage()` call blocks for as long as the actual e-ink redraw does
(often 20-30s for a color panel), which is normal and expected. Each
stage (reset/init/transfer/power-on/refresh/power-off/sleep) logs to
Serial, and a stuck BUSY wait times out after 60s with a warning naming
which stage and GPIO to check, instead of hanging silently forever.
