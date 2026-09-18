# Holiday Display ESP firmware

ESP32 + PlatformIO firmware for the Waveshare 7.3" ACeP Spectra 6 / E6
e-paper panel. Every 15 minutes it asks the picker server "is there a new
image?" and only redraws the panel if so - otherwise it does nothing.

## Status

Not yet tested against real hardware. The SPI protocol (command bytes,
color codes, init sequence, busy-pin polarity) is reproduced from
[ESPHome's `epaper_spi_spectra_e6` driver](https://github.com/esphome/esphome/tree/dev/esphome/components/epaper_spi),
a maintained, working implementation for this exact panel - not guessed
from a datasheet. See the comment at the top of `src/epd_spectra_e6.h` for
the full provenance. Please verify colors/orientation once flashed, and
open an issue (or just fix it) if something's off.

One specific unknown: whether the ESP32 Arduino core's `HTTPClient` handles
a bodyless `304 Not Modified` response cleanly. If the "check for new
image" logic seems to hang or misbehave, that's the first thing to check -
`http.GET()` in `checkAndUpdateDisplay()` in `src/main.cpp`.

## Wiring

Default pins match Waveshare's own ESP32 e-Paper driver board:

| Signal | GPIO |
|--------|------|
| CS     | 15   |
| DC     | 27   |
| RST    | 26   |
| BUSY   | 25   |
| SCK    | 13   |
| MOSI (DIN) | 14 |

Override with `-D EPD_CS_PIN=...` etc. in `platformio.ini`'s `build_flags`
if you wired it differently. No MISO connection is needed (the panel is
write-only from the ESP's perspective).

## Setup

```bash
cd firmware
cp src/secrets.h.example src/secrets.h
# edit src/secrets.h with your WiFi credentials and the picker server's
# host/port (e.g. terminus's LAN IP and 4173)

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
(often 20-30s for a color panel), which is normal and expected.
