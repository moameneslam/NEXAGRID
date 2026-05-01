#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <LiquidCrystal_I2C.h> // NEW: LCD Library

// ==========================================
// 1. CONFIGURATION
// ==========================================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASS     = "YOUR_WIFI_PASS";
const char* TB_SERVER     = "thingsboard.cloud"; // Or your custom TB instance
const char* TB_TOKEN      = "YOUR_ESP32_DEVICE_TOKEN";

// ==========================================
// 2. HARDWARE PINS (ESP32-S2 Mini)
// ==========================================
#define RELAY_1_PIN 1
#define RELAY_2_PIN 2
#define BTN_PAGE_PIN 3    // Navigates LCD Pages
#define BTN_ACTION_PIN 4  // Toggles the viewed load

// ==========================================
// 3. GLOBAL OBJECTS
// ==========================================
WiFiClient espClient;
PubSubClient client(espClient);
Adafruit_ADS1115 ads;
Preferences preferences;
LiquidCrystal_I2C lcd(0x27, 16, 2); // Adjust 0x27 if your I2C backpack is 0x3F

// ==========================================
// 4. SYSTEM STATE
// ==========================================
bool load1State = false;
bool load2State = false;
bool theft1 = false;
bool theft2 = false;

double voltage = 220.0; // Replace with actual AC voltage sensor reading
double current1 = 0.0, current2 = 0.0;
double power1 = 0.0, power2 = 0.0;
double energy1 = 0.0, energy2 = 0.0; 

int lcdPage = 0;          // 0 = Overview, 1 = Load 1, 2 = Load 2
const int MAX_PAGES = 3; 

// Timers
unsigned long lastTelemetry = 0;
unsigned long lastFlashSave = 0;
unsigned long lastSensorRead = 0;
unsigned long lastLcdUpdate = 0;
unsigned long lastBtnPage = 0;
unsigned long lastBtnAction = 0;

// ==========================================
// 5. THINGSBOARD RPC HANDLER (Cloud to ESP32)
// ==========================================
void on_message(char* topic, byte* payload, unsigned int length) {
  char json[length + 1];
  strncpy(json, (char*)payload, length);
  json[length] = '\0';
  
  Serial.print("Incoming RPC: "); Serial.println(json);
  JsonDocument doc; deserializeJson(doc, json);

  String method = doc["method"].as<String>();
  bool state = doc["params"].as<bool>();

  if (method == "setRelay1") {
    load1State = state;
    digitalWrite(RELAY_1_PIN, load1State ? LOW : HIGH); // Assuming Active-Low
  } else if (method == "setRelay2") {
    load2State = state;
    digitalWrite(RELAY_2_PIN, load2State ? LOW : HIGH);
  }
  
  updateLCD(); // Refresh screen immediately if changed from web
}

// ==========================================
// 6. UI: LCD RENDER ENGINE
// ==========================================
void updateLCD() {
  lcd.clear();
  
  if (lcdPage == 0) {
    // PAGE 0: OVERVIEW
    lcd.setCursor(0, 0); lcd.print("NEXAGRID OVERVIEW");
    lcd.setCursor(0, 1); 
    lcd.print((power1 + power2) / 1000.0, 2); lcd.print("kW ");
    lcd.print(energy1 + energy2, 1); lcd.print("kWh");
  } 
  else if (lcdPage == 1) {
    // PAGE 1: LOAD 1 DETAILS
    lcd.setCursor(0, 0); lcd.print("LOAD 1: ");
    if (theft1) { lcd.print("THEFT!"); }
    else { lcd.print(load1State ? "ONLINE" : "OFFLINE"); }
    
    lcd.setCursor(0, 1); 
    lcd.print(power1 / 1000.0, 2); lcd.print("kW ");
    lcd.print(current1, 2); lcd.print("A");
  } 
  else if (lcdPage == 2) {
    // PAGE 2: LOAD 2 DETAILS
    lcd.setCursor(0, 0); lcd.print("LOAD 2: ");
    if (theft2) { lcd.print("THEFT!"); }
    else { lcd.print(load2State ? "ONLINE" : "OFFLINE"); }
    
    lcd.setCursor(0, 1); 
    lcd.print(power2 / 1000.0, 2); lcd.print("kW ");
    lcd.print(current2, 2); lcd.print("A");
  }
}

// ==========================================
// 7. SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  
  // Relays
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  digitalWrite(RELAY_1_PIN, HIGH); 
  digitalWrite(RELAY_2_PIN, HIGH); 

  // Buttons (Internal Pullups)
  pinMode(BTN_PAGE_PIN, INPUT_PULLUP);
  pinMode(BTN_ACTION_PIN, INPUT_PULLUP);

  // I2C Bus (SDA 8, SCL 9)
  Wire.begin(8, 9); 
  ads.begin();
  
  // Initialize LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0,0); lcd.print("NEXA GRID OS");
  lcd.setCursor(0,1); lcd.print("Booting...");

  // Load Flash Memory
  preferences.begin("nexagrid", false);
  energy1 = preferences.getDouble("e1", 0.0);
  energy2 = preferences.getDouble("e2", 0.0);

  // WiFi & MQTT
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  client.setServer(TB_SERVER, 1883);
  client.setCallback(on_message);
  
  updateLCD();
}

void reconnect() {
  while (!client.connected()) {
    lcd.setCursor(0,0); lcd.print("WIFI CONNECTED  ");
    lcd.setCursor(0,1); lcd.print("Connecting TB...");
    if (client.connect("NexaGrid_ESP32", TB_TOKEN, NULL)) {
      client.subscribe("v1/devices/me/rpc/request/+");
      updateLCD();
    } else {
      delay(5000);
    }
  }
}

// ==========================================
// 8. MAIN LOOP
// ==========================================
void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  unsigned long now = millis();

  // --- BUTTON 1: PAGE NAVIGATION ---
  if (digitalRead(BTN_PAGE_PIN) == LOW && (now - lastBtnPage > 250)) {
    lcdPage++;
    if (lcdPage >= MAX_PAGES) lcdPage = 0; 
    updateLCD();
    lastBtnPage = now;
  }

  // --- BUTTON 2: CONTEXTUAL ACTION ---
  if (digitalRead(BTN_ACTION_PIN) == LOW && (now - lastBtnAction > 250)) {
    if (lcdPage == 1) {
      load1State = !load1State; 
      digitalWrite(RELAY_1_PIN, load1State ? LOW : HIGH); 
      lastTelemetry = 0; // Force instant web sync!
      updateLCD();
    } 
    else if (lcdPage == 2) {
      load2State = !load2State; 
      digitalWrite(RELAY_2_PIN, load2State ? LOW : HIGH); 
      lastTelemetry = 0; // Force instant web sync!
      updateLCD();
    }
    lastBtnAction = now;
  }

  // --- SENSOR READING (Every 1s) ---
  if (now - lastSensorRead > 1000) {
    int16_t adc0 = ads.readADC_SingleEnded(0); 
    current1 = (adc0 * 0.1875) / 1000.0; // Tune this multiplier to your specific CT sensor
    power1 = voltage * current1;
    
    int16_t adc1 = ads.readADC_SingleEnded(1);
    current2 = (adc1 * 0.1875) / 1000.0;
    power2 = voltage * current2;

    energy1 += (power1 / 1000.0) * (1.0 / 3600.0); 
    energy2 += (power2 / 1000.0) * (1.0 / 3600.0);

    // Theft Detection: Relay is OFF but current is flowing
    theft1 = (!load1State && current1 > 0.3);
    theft2 = (!load2State && current2 > 0.3);

    lastSensorRead = now;
  }

  // --- LCD REFRESH (Every 2s to update live numbers) ---
  if (now - lastLcdUpdate > 2000) {
    updateLCD();
    lastLcdUpdate = now;
  }

  // --- CLOUD TELEMETRY SYNC (Every 5s) ---
  if (now - lastTelemetry > 5000) {
    JsonDocument telemetry;
    telemetry["voltage"] = voltage;
    telemetry["current1"] = current1;
    telemetry["power1"] = power1;
    telemetry["current2"] = current2;
    telemetry["power2"] = power2;
    telemetry["energy_total"] = energy1 + energy2;
    telemetry["cost_total"] = (energy1 + energy2) * 1.5; 
    
    telemetry["state1"] = load1State ? 1 : 0; 
    telemetry["state2"] = load2State ? 1 : 0;
    telemetry["theft_l1"] = theft1 ? 1 : 0;
    telemetry["theft_l2"] = theft2 ? 1 : 0;

    char buffer[256];
    serializeJson(telemetry, buffer);
    client.publish("v1/devices/me/telemetry", buffer);
    
    lastTelemetry = now;
  }

  // --- FLASH MEMORY SAVE (Every 5m) ---
  if (now - lastFlashSave > 300000) {
    preferences.putDouble("e1", energy1);
    preferences.putDouble("e2", energy2);
    Serial.println("💾 Energy saved to flash.");
    lastFlashSave = now;
  }
}