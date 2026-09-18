#include "epd_spectra_e6.h"

// SPI: MSB first, mode 0 (CPOL=0, CPHA=0), 20MHz - matches the
// "7.3in-Spectra-E6" model config in ESPHome's epaper_spi component.
static const SPISettings EPD_SPI_SETTINGS(20000000, MSBFIRST, SPI_MODE0);

void EpdSpectraE6::begin(int csPin, int dcPin, int rstPin, int busyPin, int sckPin, int mosiPin,
                          uint16_t width, uint16_t height) {
  csPin_ = csPin;
  dcPin_ = dcPin;
  rstPin_ = rstPin;
  busyPin_ = busyPin;
  width_ = width;
  height_ = height;

  pinMode(csPin_, OUTPUT);
  pinMode(dcPin_, OUTPUT);
  pinMode(rstPin_, OUTPUT);
  pinMode(busyPin_, INPUT);
  digitalWrite(csPin_, HIGH);

  // Write-only device: no MISO needed.
  spi_.begin(sckPin, -1, mosiPin, csPin_);
}

// BUSY is LOW while the panel is busy, HIGH when idle/ready - see the class
// comment for how that polarity was confirmed.
void EpdSpectraE6::waitBusy_() {
  while (digitalRead(busyPin_) == LOW) {
    delay(5);
  }
}

void EpdSpectraE6::reset_() {
  digitalWrite(rstPin_, HIGH);
  delay(20);
  digitalWrite(rstPin_, LOW);
  delay(10);
  digitalWrite(rstPin_, HIGH);
  delay(20);
  waitBusy_();
}

void EpdSpectraE6::sendCommand_(uint8_t cmd) {
  spi_.beginTransaction(EPD_SPI_SETTINGS);
  digitalWrite(dcPin_, LOW);
  digitalWrite(csPin_, LOW);
  spi_.transfer(cmd);
  digitalWrite(csPin_, HIGH);
  spi_.endTransaction();
}

// One continuous CS-asserted transaction covering the command byte and all
// its data bytes, matching ESPHome's cmd_data().
void EpdSpectraE6::sendCommandData_(uint8_t cmd, const uint8_t *data, size_t len) {
  spi_.beginTransaction(EPD_SPI_SETTINGS);
  digitalWrite(dcPin_, LOW);
  digitalWrite(csPin_, LOW);
  spi_.transfer(cmd);
  if (len > 0) {
    digitalWrite(dcPin_, HIGH);
    for (size_t i = 0; i < len; i++) {
      spi_.transfer(data[i]);
    }
  }
  digitalWrite(csPin_, HIGH);
  spi_.endTransaction();
}

// Exact command bytes from ESPHome's spectra_e6.py get_init_sequence(), with
// the panel-size bytes for command 0x61 computed for width_/height_.
void EpdSpectraE6::initSequence_() {
  sendCommandData_(0xAA, (const uint8_t[]){0x49, 0x55, 0x20, 0x08, 0x09, 0x18}, 6);
  sendCommandData_(0x01, (const uint8_t[]){0x3F}, 1);
  sendCommandData_(0x00, (const uint8_t[]){0x5F, 0x69}, 2);
  sendCommandData_(0x03, (const uint8_t[]){0x00, 0x54, 0x00, 0x44}, 4);
  sendCommandData_(0x05, (const uint8_t[]){0x40, 0x1F, 0x1F, 0x2C}, 4);
  sendCommandData_(0x06, (const uint8_t[]){0x6F, 0x1F, 0x17, 0x49}, 4);
  sendCommandData_(0x08, (const uint8_t[]){0x6F, 0x1F, 0x1F, 0x22}, 4);
  sendCommandData_(0x30, (const uint8_t[]){0x03}, 1);
  sendCommandData_(0x50, (const uint8_t[]){0x3F}, 1);
  sendCommandData_(0x60, (const uint8_t[]){0x02, 0x00}, 2);

  uint8_t sizeArgs[4] = {
      static_cast<uint8_t>(width_ / 256), static_cast<uint8_t>(width_ % 256),
      static_cast<uint8_t>(height_ / 256), static_cast<uint8_t>(height_ % 256),
  };
  sendCommandData_(0x61, sizeArgs, 4);

  sendCommandData_(0x84, (const uint8_t[]){0x01}, 1);
  sendCommandData_(0xE3, (const uint8_t[]){0x2F}, 1);
}

void EpdSpectraE6::transferImage_(const uint8_t *data, size_t length) {
  sendCommand_(0x10);

  spi_.beginTransaction(EPD_SPI_SETTINGS);
  digitalWrite(dcPin_, HIGH);
  digitalWrite(csPin_, LOW);
  spi_.transferBytes(const_cast<uint8_t *>(data), nullptr, length);
  digitalWrite(csPin_, HIGH);
  spi_.endTransaction();
}

void EpdSpectraE6::powerOn_() { sendCommand_(0x04); }

void EpdSpectraE6::refresh_() {
  const uint8_t data = 0x00;
  sendCommandData_(0x12, &data, 1);
}

void EpdSpectraE6::powerOff_() {
  const uint8_t data = 0x00;
  sendCommandData_(0x02, &data, 1);
}

void EpdSpectraE6::deepSleep_() {
  const uint8_t data = 0xA5;
  sendCommandData_(0x07, &data, 1);
}

// Sequence + the busy-wait placement (wait BEFORE each step's action, i.e.
// between the previous step's command and this one) both follow ESPHome's
// state machine exactly: RESET -> INITIALISE -> TRANSFER_DATA -> POWER_ON ->
// REFRESH_SCREEN -> POWER_OFF -> DEEP_SLEEP. The long wait - the actual
// multi-second e-ink refresh - happens between REFRESH_SCREEN and POWER_OFF.
void EpdSpectraE6::displayImage(const uint8_t *data, size_t length) {
  reset_();
  initSequence_();
  waitBusy_();
  transferImage_(data, length);
  waitBusy_();
  powerOn_();
  waitBusy_();
  refresh_();
  waitBusy_();
  powerOff_();
  waitBusy_();
  deepSleep_();
}
