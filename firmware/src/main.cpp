#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_sleep.h>

#include "secrets.h"
#include "epd_spectra_e6.h"

#ifndef HTTP_CODE_NOT_MODIFIED
#define HTTP_CODE_NOT_MODIFIED 304
#endif

// Real pin mapping for the Seeed XIAO ePaper EE04 expansion board (XIAO
// ESP32-S3), decoded from Seeed_GFX2's Config_XIAO_ePaper_EE04_Board ->
// esp32DisplayPins(10, -1) -> BoardPinConfig, cross-referenced against the
// XIAO ESP32S3's D-pin aliases (D8=GPIO7, D10=GPIO9) in Arduino-ESP32's
// variants/XIAO_ESP32S3/pins_arduino.h. None of these fall in ESP32-S3's
// flash/PSRAM-reserved GPIO26-32 range.
#ifndef EPD_CS_PIN
#define EPD_CS_PIN 44
#endif
#ifndef EPD_DC_PIN
#define EPD_DC_PIN 10
#endif
#ifndef EPD_RST_PIN
#define EPD_RST_PIN 38
#endif
#ifndef EPD_BUSY_PIN
#define EPD_BUSY_PIN 4
#endif
#ifndef EPD_SCK_PIN
#define EPD_SCK_PIN 7  // XIAO D8
#endif
#ifndef EPD_MOSI_PIN
#define EPD_MOSI_PIN 9  // XIAO D10
#endif

// The EE04 board gates the display's power rail behind this pin - nothing
// on the panel responds to anything until it's driven HIGH. Easy to miss
// since it's a board-level detail, not part of the e-paper protocol itself.
#ifndef EPD_ENABLE_PIN
#define EPD_ENABLE_PIN 43
#endif

#define PANEL_WIDTH 800
#define PANEL_HEIGHT 480
#define FRAMEBUFFER_SIZE (PANEL_WIDTH * PANEL_HEIGHT / 2)  // 4bpp, 2px/byte

static const uint32_t CHECK_INTERVAL_MS = 15UL * 60UL * 1000UL;

// The XIAO ESP32-S3's onboard battery-sense divider (BAT+ -> 1:2 divider ->
// A0/GPIO1) - a standard feature of this board line, not something the EE04
// expansion board adds or documents itself, so verify against a multimeter
// if reported percentages look off.
#ifndef BATTERY_ADC_PIN
#define BATTERY_ADC_PIN A0
#endif
static const uint32_t BATTERY_EMPTY_MV = 3300;  // ~0% for a single-cell LiPo
static const uint32_t BATTERY_FULL_MV = 4200;   // ~100% for a single-cell LiPo

EpdSpectraE6 epd;

// Deep sleep resets the chip like a reboot, so ordinary globals don't
// survive between checks - RTC memory does. Keeping the ETag here means the
// conditional GET still works (and skips redrawing) across sleep cycles.
RTC_DATA_ATTR char lastEtag[64] = "";

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to WiFi %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected, IP: %s\n", WiFi.localIP().toString().c_str());
}

// Fetches /display.raw with a conditional GET. Returns true if a new image
// was fetched and drawn, false if unchanged (304) or on error.
bool checkAndUpdateDisplay() {
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/display.raw";

  if (!http.begin(url)) {
    Serial.println("HTTP begin failed");
    return false;
  }
  // ESP32 HTTPClient only exposes headers via http.header() that were
  // explicitly requested here first - ETag isn't one of the handful it
  // collects by default. Without this, http.header("ETag") below always
  // returns "", lastEtag never gets set, If-None-Match never gets sent,
  // and the server returns a fresh 200 on every single check.
  const char *headerKeys[] = {"ETag"};
  http.collectHeaders(headerKeys, 1);

  if (lastEtag[0] != '\0') {
    http.addHeader("If-None-Match", lastEtag);
  }

  int status = http.GET();
  Serial.printf("GET %s -> %d\n", url.c_str(), status);

  if (status == HTTP_CODE_NOT_MODIFIED) {
    http.end();
    Serial.println("No new image - nothing to do.");
    return false;
  }

  if (status != HTTP_CODE_OK) {
    Serial.printf("Unexpected status %d\n", status);
    http.end();
    return false;
  }

  int contentLength = http.getSize();
  if (contentLength != FRAMEBUFFER_SIZE) {
    Serial.printf("Unexpected body size %d, expected %d\n", contentLength, FRAMEBUFFER_SIZE);
    http.end();
    return false;
  }

  uint8_t *buffer = static_cast<uint8_t *>(malloc(FRAMEBUFFER_SIZE));
  if (buffer == nullptr) {
    Serial.println("Out of memory allocating framebuffer");
    http.end();
    return false;
  }

  WiFiClient *stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t startMs = millis();
  const uint32_t READ_TIMEOUT_MS = 30000;

  while (received < FRAMEBUFFER_SIZE) {
    if (millis() - startMs > READ_TIMEOUT_MS) {
      Serial.println("Timed out reading image body");
      free(buffer);
      http.end();
      return false;
    }
    size_t avail = stream->available();
    if (avail == 0) {
      delay(10);
      continue;
    }
    size_t toRead = min(avail, FRAMEBUFFER_SIZE - received);
    int n = stream->readBytes(buffer + received, toRead);
    if (n > 0) {
      received += n;
    }
  }

  String newEtag = http.header("ETag");
  http.end();

  Serial.printf("Fetched %u bytes, drawing...\n", (unsigned) received);
  epd.displayImage(buffer, FRAMEBUFFER_SIZE);
  free(buffer);

  strncpy(lastEtag, newEtag.c_str(), sizeof(lastEtag) - 1);
  lastEtag[sizeof(lastEtag) - 1] = '\0';
  Serial.println("Display updated.");
  return true;
}

// Reads the battery voltage off the onboard divider and reports it to the
// picker server so the web UI can show roughly how much charge is left.
// Best-effort: failing to reach the server shouldn't block going back to
// sleep, so errors here are just logged.
void reportBattery() {
  uint32_t milliVolts = analogReadMilliVolts(BATTERY_ADC_PIN) * 2;  // divider is 1:2
  int percent = constrain(
      map(milliVolts, BATTERY_EMPTY_MV, BATTERY_FULL_MV, 0, 100), 0, 100);
  Serial.printf("Battery: %u mV (%d%%)\n", milliVolts, percent);

  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/battery";
  if (!http.begin(url)) {
    Serial.println("Battery report: HTTP begin failed");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  String body = String("{\"voltageMv\":") + milliVolts + ",\"percent\":" + percent + "}";
  int status = http.POST(body);
  Serial.printf("POST %s -> %d\n", url.c_str(), status);
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nHoliday Display ESP starting up");

  pinMode(EPD_ENABLE_PIN, OUTPUT);
  digitalWrite(EPD_ENABLE_PIN, HIGH);
  delay(50);  // let the display's power rail settle before talking to it

  epd.begin(EPD_CS_PIN, EPD_DC_PIN, EPD_RST_PIN, EPD_BUSY_PIN, EPD_SCK_PIN, EPD_MOSI_PIN,
            PANEL_WIDTH, PANEL_HEIGHT);

  connectWiFi();
  checkAndUpdateDisplay();
  reportBattery();

  // Deep sleep instead of a delay() loop so the radio and CPU actually power
  // down between checks - a busy-wait loop draws close to full current the
  // whole 15 minutes, which would drain a battery in hours, not weeks.
  WiFi.disconnect(true);
  Serial.printf("Sleeping for %lu ms\n", (unsigned long) CHECK_INTERVAL_MS);
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t) CHECK_INTERVAL_MS * 1000ULL);
  esp_deep_sleep_start();
}

void loop() {
  // Unreachable: setup() ends in deep sleep, and waking from deep sleep
  // re-runs setup() from scratch rather than resuming here.
}
