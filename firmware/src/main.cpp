#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

#include "secrets.h"
#include "epd_spectra_e6.h"

#ifndef HTTP_CODE_NOT_MODIFIED
#define HTTP_CODE_NOT_MODIFIED 304
#endif

// Default pinout for an ESP32-S3-DevKitC-1 board. Deliberately avoids:
// GPIO26-32 (wired to the flash/PSRAM chip on N8/N16 modules - toggling
// these as GPIO corrupts flash access and crashes the chip almost
// immediately, seen as a silent TG1WDT_SYS_RST reboot loop with no
// crash log), GPIO19/20 (native USB D-/D+), and GPIO0/3/45/46
// (strapping pins). Override here if you wired it differently, and
// avoid that same GPIO26-32 range on any S3 board.
#ifndef EPD_CS_PIN
#define EPD_CS_PIN 10
#endif
#ifndef EPD_DC_PIN
#define EPD_DC_PIN 9
#endif
#ifndef EPD_RST_PIN
#define EPD_RST_PIN 14
#endif
#ifndef EPD_BUSY_PIN
#define EPD_BUSY_PIN 13
#endif
#ifndef EPD_SCK_PIN
#define EPD_SCK_PIN 12
#endif
#ifndef EPD_MOSI_PIN
#define EPD_MOSI_PIN 11
#endif

#define PANEL_WIDTH 800
#define PANEL_HEIGHT 480
#define FRAMEBUFFER_SIZE (PANEL_WIDTH * PANEL_HEIGHT / 2)  // 4bpp, 2px/byte

// Tightened for testing - bump back to 15 min (15UL * 60UL * 1000UL) once
// you've confirmed everything works end to end.
static const uint32_t CHECK_INTERVAL_MS = 10UL * 1000UL;

EpdSpectraE6 epd;
String lastEtag = "";
uint32_t lastCheckMs = 0;
bool firstCheckDone = false;

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
  if (lastEtag.length() > 0) {
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

  lastEtag = newEtag;
  Serial.println("Display updated.");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nHoliday Display ESP starting up");

  epd.begin(EPD_CS_PIN, EPD_DC_PIN, EPD_RST_PIN, EPD_BUSY_PIN, EPD_SCK_PIN, EPD_MOSI_PIN,
            PANEL_WIDTH, PANEL_HEIGHT);

  connectWiFi();

  // Check once immediately on boot, then every CHECK_INTERVAL_MS.
  lastCheckMs = millis() - CHECK_INTERVAL_MS;
}

void loop() {
  if (millis() - lastCheckMs >= CHECK_INTERVAL_MS) {
    lastCheckMs = millis();

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi dropped, reconnecting...");
      connectWiFi();
    }

    checkAndUpdateDisplay();
  }

  delay(1000);
}
