#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <LiquidCrystal_I2C.h>
#include <time.h> 

// ==========================================
// 1. CONFIGURATION
// ==========================================
const char* WIFI_SSID     = "ESP32";
const char* WIFI_PASS     = "12345678";
const char* TB_SERVER     = "mqtt.thingsboard.cloud";
const char* TB_TOKEN      = "eox1kl2kv6pgxiglhz0z";

// --- TIME SETTINGS (Egypt: UTC+2 + 1Hr DST) ---
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 7200;      
const int   daylightOffset_sec = 3600; 

const float WARNING_THRESHOLD = 3.5; // Amps before CRITICAL LED triggers

// ==========================================
// 2. HARDWARE PINS (Matched to PCB Schematic)
// ==========================================
#define RELAY_1_PIN    26
#define RELAY_2_PIN    27

// --- BUTTONS (Active-High: External 10k pull-downs to GND) ---
#define BTN_PAGE_PIN   35    
#define BTN_ACTION_PIN 34    

// --- DUAL I2C BUS PINS ---
#define I2C_LCD_SDA    21  
#define I2C_LCD_SCL    22
#define I2C_ADS_SDA    13  
#define I2C_ADS_SCL    14

// --- LED INDICATOR PINS ---
#define LED_WIFI       2   
#define LED_MQTT       4
#define L1_CRIT        5
#define L1_OFF         18
#define L1_ON          19
#define L2_CRIT        25
#define L2_OFF         33
#define L2_ON          32  

// ==========================================
// 3. GLOBAL OBJECTS & STATE
// ==========================================
WiFiClient espClient;
PubSubClient client(espClient);
Adafruit_ADS1115 ads;
Preferences preferences;
LiquidCrystal_I2C lcd(0x27, 16, 2);

bool load1State = false, load2State = false;
bool theft1 = false, theft2 = false;
bool isOfflineMode = false;

// --- BUTTON EDGE DETECTION STATES ---
bool lastPageBtnState = LOW;
bool lastActionBtnState = LOW;

double voltage = 220.0, current1 = 0.0, current2 = 0.0;
double power1 = 0.0, power2 = 0.0, energy1 = 0.0, energy2 = 0.0; 
float pf1 = 1.0, pf2 = 1.0;
int lcdPage = 0; const int MAX_PAGES = 3; 

// --- SMART GRID LIMITS & ESSENTIAL STATUS ---
float globalCurrentLimit = 20.0; 
bool isLoad1Essential = true;    
bool isLoad2Essential = false;   

// --- ADVANCED POWER METRICS ---
float offsetV = 0, offsetI1 = 0, offsetI2 = 0; 
const float VCAL = 1.043;   
const float ICAL = 0.00202; 
float PHASECAL = 1.7;       

// Timers
unsigned long lastTelemetry = 0, lastFlashSave = 0, lastSensorRead = 0;
unsigned long lastLcdUpdate = 0, lastBtnPage = 0, lastBtnAction = 0, lastMqttRetry = 0;

// ==========================================
// 4. THE POWER ENGINE (True Real Power & PF)
// ==========================================
void measureLoad(int pinI, double &v_rms, double &i_rms, double &real_power, float &pf, float &filterOffsetI) {
  int numSamples = 100; 
  float sumVsq = 0, sumIsq = 0, sumP = 0;
  float sampleV = 0, sampleI = 0, lastSampleV = 0, shiftedV = 0;

  for (int i = 0; i < numSamples; i++) {
    lastSampleV = sampleV;
    int16_t rawV = ads.readADC_SingleEnded(2);
    int16_t rawI = ads.readADC_SingleEnded(pinI);

    offsetV = offsetV + (rawV - offsetV) * 0.01;
    filterOffsetI = filterOffsetI + (rawI - filterOffsetI) * 0.01;
    sampleV = rawV - offsetV; sampleI = rawI - filterOffsetI;
    shiftedV = lastSampleV + PHASECAL * (sampleV - lastSampleV);

    sumVsq += (sampleV * sampleV);
    sumIsq += (sampleI * sampleI);
    sumP   += (shiftedV * sampleI);
  }

  v_rms = VCAL * sqrt(sumVsq / numSamples);
  i_rms = ICAL * sqrt(sumIsq / numSamples);
  if (i_rms < 0.05) i_rms = 0.0; 

  real_power = (VCAL * ICAL) * (sumP / numSamples);
  double apparent_power = v_rms * i_rms;

  if (apparent_power > 0 && i_rms > 0) { pf = real_power / apparent_power; } else { pf = 1.0; }
  if (pf > 1.0) pf = 1.0; if (pf < 0.0) pf = 0.0; if (real_power < 0) real_power = 0.0;
}

// ==========================================
// 5. LED & UI RENDER ENGINES
// ==========================================
void updateLEDs() {
  if (!load1State) { digitalWrite(L1_ON, LOW); digitalWrite(L1_CRIT, LOW); digitalWrite(L1_OFF, HIGH); } 
  else if (current1 >= WARNING_THRESHOLD) { digitalWrite(L1_ON, LOW); digitalWrite(L1_OFF, LOW); digitalWrite(L1_CRIT, HIGH); } 
  else { digitalWrite(L1_CRIT, LOW); digitalWrite(L1_OFF, LOW); digitalWrite(L1_ON, HIGH); }

  if (!load2State) { digitalWrite(L2_ON, LOW); digitalWrite(L2_CRIT, LOW); digitalWrite(L2_OFF, HIGH); } 
  else if (current2 >= WARNING_THRESHOLD) { digitalWrite(L2_ON, LOW); digitalWrite(L2_OFF, LOW); digitalWrite(L2_CRIT, HIGH); } 
  else { digitalWrite(L2_CRIT, LOW); digitalWrite(L2_OFF, LOW); digitalWrite(L2_ON, HIGH); }
}

void updateLCD() {
  lcd.clear(); char buf[17];
  
  if (lcdPage == 0) {
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) { snprintf(buf, sizeof(buf), "NEXAGRID   %02d:%02d", timeinfo.tm_hour, timeinfo.tm_min); lcd.setCursor(0, 0); lcd.print(buf); } 
    else { lcd.setCursor(0, 0); lcd.print("NEXAGRID OVERVIEW"); }
    lcd.setCursor(0, 1); lcd.print((power1 + power2) / 1000.0, 2); lcd.print("kW "); lcd.print(energy1 + energy2, 1); lcd.print("kWh");
  } 
  else if (lcdPage == 1) {
    lcd.setCursor(0, 0); 
    if (theft1) { 
      lcd.print("L1: THEFT!"); 
    } else { 
      // Add an asterisk if the load is protected/essential
      char essMarker = isLoad1Essential ? '*' : ' '; 
      snprintf(buf, sizeof(buf), "L1%c:%s PF:%.2f", essMarker, load1State ? "ON " : "OFF", pf1); 
      lcd.print(buf); 
    }
    lcd.setCursor(0, 1); lcd.print(power1 / 1000.0, 2); lcd.print("kW "); lcd.print(current1, 2); lcd.print("A");
  } 
  else if (lcdPage == 2) {
    lcd.setCursor(0, 0); 
    if (theft2) { 
      lcd.print("L2: THEFT!"); 
    } else { 
      // Add an asterisk if the load is protected/essential
      char essMarker = isLoad2Essential ? '*' : ' '; 
      snprintf(buf, sizeof(buf), "L2%c:%s PF:%.2f", essMarker, load2State ? "ON " : "OFF", pf2); 
      lcd.print(buf); 
    }
    lcd.setCursor(0, 1); lcd.print(power2 / 1000.0, 2); lcd.print("kW "); lcd.print(current2, 2); lcd.print("A");
  }
}

// ==========================================
// 6. CLOUD RPC & ATTRIBUTE HANDLER
// ==========================================
void on_message(char* topic, byte* payload, unsigned int length) {
  char json[length + 1]; strncpy(json, (char*)payload, length); json[length] = '\0';
  JsonDocument doc; deserializeJson(doc, json);
  String topicStr = String(topic);

  // 1. RPC COMMANDS (Buttons toggled from dashboard)
  if (topicStr.indexOf("rpc") > 0) {
    String method = doc["method"].as<String>(); bool state = doc["params"].as<bool>();
    if (method == "setRelay1") { load1State = state; digitalWrite(RELAY_1_PIN, load1State ? LOW : HIGH); } 
    else if (method == "setRelay2") { load2State = state; digitalWrite(RELAY_2_PIN, load2State ? LOW : HIGH); }
  } 
  // 2. SHARED ATTRIBUTES (Settings changed on dashboard)
  else if (topicStr.indexOf("attributes") > 0) {
    if (doc.containsKey("globalCurrentLimit")) { 
      globalCurrentLimit = doc["globalCurrentLimit"].as<float>(); 
      preferences.putFloat("limit", globalCurrentLimit); 
    }
    if (doc.containsKey("isLoad1Essential")) { 
      isLoad1Essential = doc["isLoad1Essential"].as<bool>(); 
      preferences.putBool("ess1", isLoad1Essential); 
    }
    if (doc.containsKey("isLoad2Essential")) { 
      isLoad2Essential = doc["isLoad2Essential"].as<bool>(); 
      preferences.putBool("ess2", isLoad2Essential); 
    }
    Serial.println("Settings updated and saved to flash!");
  }
  
  updateLCD(); updateLEDs();
}

// ==========================================
// 7. SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  
  pinMode(RELAY_1_PIN, OUTPUT); digitalWrite(RELAY_1_PIN, HIGH);
  pinMode(RELAY_2_PIN, OUTPUT); digitalWrite(RELAY_2_PIN, HIGH);
  pinMode(BTN_PAGE_PIN, INPUT); pinMode(BTN_ACTION_PIN, INPUT);

  const int ledPins[] = {LED_WIFI, LED_MQTT, L1_ON, L1_OFF, L1_CRIT, L2_ON, L2_OFF, L2_CRIT};
  for(int p : ledPins) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }

  Wire.begin(I2C_LCD_SDA, I2C_LCD_SCL); 
  lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("NEXA GRID OS"); lcd.setCursor(0,1); lcd.print("Booting...");

  Wire1.begin(I2C_ADS_SDA, I2C_ADS_SCL, 400000); 
  if (ads.begin(0x48, &Wire1)) { ads.setDataRate(RATE_ADS1115_860SPS); }

  // --- LOAD SAVED MEMORY (Energy & Settings) ---
  preferences.begin("nexagrid", false);
  energy1 = preferences.getDouble("e1", 0.0); 
  energy2 = preferences.getDouble("e2", 0.0);
  
  globalCurrentLimit = preferences.getFloat("limit", 20.0); // Defaults to 20A if never set
  isLoad1Essential = preferences.getBool("ess1", true);     // Defaults Load 1 to essential
  isLoad2Essential = preferences.getBool("ess2", false);    // Defaults Load 2 to non-essential

  // --- NETWORK & TIME SETUP ---
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 10000) { 
    digitalWrite(LED_WIFI, !digitalRead(LED_WIFI)); delay(500); 
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_WIFI, HIGH); isOfflineMode = false;
    client.setServer(TB_SERVER, 1883); 
    client.setCallback(on_message);
    
    // INCREASE MQTT BUFFER SO LARGE JSON PAYLOADS ARE NOT DROPPED
    client.setBufferSize(512); 
    
    lcd.setCursor(0, 1); lcd.print("Syncing Time... ");
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
    struct tm timeinfo; int retries = 0;
    while ((!getLocalTime(&timeinfo) || timeinfo.tm_year < 120) && retries < 20) { delay(500); retries++; }
    
    lcd.setCursor(0, 1); lcd.print("WiFi Connected! ");
  } else {
    digitalWrite(LED_WIFI, LOW); isOfflineMode = true;
    lcd.setCursor(0, 1); lcd.print("Offline Mode    ");
  }
  delay(1500); updateLCD(); updateLEDs();
}

// ==========================================
// 8. MAIN LOOP
// ==========================================
void loop() {
  unsigned long now = millis();

  // --- NON-BLOCKING MQTT ---
  if (!isOfflineMode) {
    if (!client.connected()) {
      digitalWrite(LED_MQTT, LOW);
      if (now - lastMqttRetry > 5000) {
        lastMqttRetry = now;
        if (client.connect("NexaGrid_ESP32", TB_TOKEN, NULL)) { 
          client.subscribe("v1/devices/me/rpc/request/+");  // Listen for Buttons
          client.subscribe("v1/devices/me/attributes");     // Listen for Settings changes
        }
      }
    } else { digitalWrite(LED_MQTT, HIGH); client.loop(); }
  }

  // --- UI BUTTONS (Edge-Detection + Debounce) ---
  bool pageBtnState = digitalRead(BTN_PAGE_PIN);
  if (pageBtnState == HIGH && lastPageBtnState == LOW && (now - lastBtnPage > 50)) {
    lcdPage++; if (lcdPage >= MAX_PAGES) lcdPage = 0; 
    updateLCD(); lastBtnPage = now;
  }
  lastPageBtnState = pageBtnState; // Save state for next loop

  bool actionBtnState = digitalRead(BTN_ACTION_PIN);
  if (actionBtnState == HIGH && lastActionBtnState == LOW && (now - lastBtnAction > 50)) {
    if (lcdPage == 1) { load1State = !load1State; digitalWrite(RELAY_1_PIN, load1State ? LOW : HIGH); lastTelemetry = 0; updateLCD(); } 
    else if (lcdPage == 2) { load2State = !load2State; digitalWrite(RELAY_2_PIN, load2State ? LOW : HIGH); lastTelemetry = 0; updateLCD(); }
    lastBtnAction = now; updateLEDs();
  }
  lastActionBtnState = actionBtnState; // Save state for next loop

  // --- SENSORS & SMART LOAD SHEDDING ---
  if (now - lastSensorRead > 1000) {
    if (!isOfflineMode || isOfflineMode) { 
      measureLoad(1, voltage, current1, power1, pf1, offsetI1); 
      double tempV; measureLoad(3, tempV, current2, power2, pf2, offsetI2);   
    }

    // 1. Hard Safety Limit (Overrules everything to prevent fire)
    if (load1State && current1 >= WARNING_THRESHOLD + 0.5) { load1State = false; digitalWrite(RELAY_1_PIN, HIGH); lastTelemetry = 0; }
    if (load2State && current2 >= WARNING_THRESHOLD + 0.5) { load2State = false; digitalWrite(RELAY_2_PIN, HIGH); lastTelemetry = 0; }

    // 2. Smart Grid Load Shedding (Based on Cloud Attributes)
    double totalCurrent = current1 + current2;
    if (totalCurrent > globalCurrentLimit) {
      // Trip Load 2 if it is NOT essential
      if (!isLoad2Essential && load2State) {
        load2State = false; digitalWrite(RELAY_2_PIN, HIGH); lastTelemetry = 0;
      } 
      // If still over limit, trip Load 1 if it is NOT essential
      else if (!isLoad1Essential && load1State) {
        load1State = false; digitalWrite(RELAY_1_PIN, HIGH); lastTelemetry = 0;
      }
    }

    energy1 += (power1 / 1000.0) * (1.0 / 3600.0); energy2 += (power2 / 1000.0) * (1.0 / 3600.0);
    theft1 = (!load1State && current1 > 0.3); theft2 = (!load2State && current2 > 0.3);
    
    updateLEDs();
    lastSensorRead = now;
  }

  // --- REFRESH CLOCK ON LCD ---
  if (now - lastLcdUpdate > 2000) { updateLCD(); lastLcdUpdate = now; }

  // --- PUSH TO CLOUD ---
  if (!isOfflineMode && client.connected() && (now - lastTelemetry > 5000)) {
    JsonDocument telemetry;
    telemetry["voltage"] = voltage; telemetry["current1"] = current1; telemetry["power1"] = power1; telemetry["pf1"] = pf1;
    telemetry["current2"] = current2; telemetry["power2"] = power2; telemetry["pf2"] = pf2;
    telemetry["energy_total"] = energy1 + energy2; telemetry["cost_total"] = (energy1 + energy2) * 1.5; 
    telemetry["state1"] = load1State ? 1 : 0; telemetry["state2"] = load2State ? 1 : 0;
    telemetry["theft_l1"] = theft1 ? 1 : 0; telemetry["theft_l2"] = theft2 ? 1 : 0;

    char buffer[512]; serializeJson(telemetry, buffer);
    client.publish("v1/devices/me/telemetry", buffer);
    lastTelemetry = now;
  }

  // --- SAVE TO FLASH ---
  if (now - lastFlashSave > 300000) { preferences.putDouble("e1", energy1); preferences.putDouble("e2", energy2); lastFlashSave = now; }
}