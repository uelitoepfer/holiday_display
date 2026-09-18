#pragma once

#include <Arduino.h>
#include <SPI.h>

// VSPI doesn't exist on ESP32-S3/C3 (only FSPI/HSPI there) - pick whichever
// dedicated bus is available for this variant.
#if defined(VSPI)
#define EPD_SPI_BUS VSPI
#else
#define EPD_SPI_BUS HSPI
#endif

// Driver for the Waveshare 7.3" ACeP Spectra 6 / E6 e-paper panel (800x480,
// true 6-color: black/white/yellow/red/blue/green).
//
// Command bytes, init sequence, color codes and the reset/busy timing here
// are taken from ESPHome's epaper_spi_spectra_e6 component (esphome/esphome,
// esphome/components/epaper_spi/{epaper_spi_spectra_e6.*, models/spectra_e6.py}),
// which is a maintained, working driver for this exact panel - not guessed
// from a datasheet. The busy-pin polarity (LOW = busy, HIGH = idle) matches
// both that source (via its reTerminal preset's explicit `inverted: true`,
// which corrects for ESPHome's opposite default assumption) and Waveshare's
// own epd7in3g Arduino demo comment ("LOW: busy, HIGH: idle").
//
// Untested against real hardware - the protocol is faithfully reproduced,
// but please verify pixel colors and orientation on your actual panel.
class EpdSpectraE6 {
 public:
  // Native 4-bit color codes. Code 4 is unused by the panel.
  enum Color : uint8_t {
    BLACK = 0,
    WHITE = 1,
    YELLOW = 2,
    RED = 3,
    BLUE = 5,
    GREEN = 6,
  };

  void begin(int csPin, int dcPin, int rstPin, int busyPin, int sckPin, int mosiPin,
             uint16_t width = 800, uint16_t height = 480);

  // Runs the full update sequence: reset, init, stream `data` (a packed
  // 4bpp buffer of width*height/2 bytes - see pngToEpdRaw on the server
  // side for the exact format), power on, refresh, power off, deep sleep.
  // Blocks until the panel finishes refreshing (tens of seconds).
  void displayImage(const uint8_t *data, size_t length);

 private:
  void reset_();
  // Logs a warning and gives up after a timeout instead of hanging forever -
  // a disconnected/miswired BUSY pin should be diagnosable from the serial
  // log, not just an unexplained silent hang.
  void waitBusy_(const char *stage);
  void sendCommand_(uint8_t cmd);
  void sendCommandData_(uint8_t cmd, const uint8_t *data, size_t len);
  void initSequence_();
  void transferImage_(const uint8_t *data, size_t length);
  void powerOn_();
  void refresh_();
  void powerOff_();
  void deepSleep_();

  int csPin_ = -1;
  int dcPin_ = -1;
  int rstPin_ = -1;
  int busyPin_ = -1;
  uint16_t width_ = 800;
  uint16_t height_ = 480;
  SPIClass spi_{EPD_SPI_BUS};
};
