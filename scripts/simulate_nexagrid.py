import time
import random
import requests
import json

# Use the standard HTTP host for ThingsBoard Cloud
TB_HOST = "thingsboard.cloud" 
TB_TOKEN = "eox1kl2kv6pgxiglhz0z"
TB_URL = f"https://{TB_HOST}/api/v1/{TB_TOKEN}/telemetry"

# Starting baseline values
energy_total = 150.0
cost_total = 75.0

print(f"Starting simulation. Pushing data to {TB_HOST}...")

while True:
    # Simulate fluctuating sensor readings
    voltage = round(random.uniform(218.0, 225.0), 1)
    
    # Simulate Load 1 (e.g., a fridge)
    current1 = round(random.uniform(1.2, 1.8), 2)
    power1 = round(voltage * current1 * 0.95, 2) 
    
    # Simulate Load 2 (e.g., a heavy heater)
    current2 = round(random.uniform(8.0, 10.5), 2)
    power2 = round(voltage * current2 * 0.99, 2) 

    # Increment accumulating values
    energy_total += ((power1 + power2) / 1000) * (5 / 3600)
    cost_total += (((power1 + power2) / 1000) * (5 / 3600)) * 0.5 

    # Build the JSON payload
    payload = {
        "voltage": voltage,
        "current1": current1,
        "power1": power1,
        "pf1": 0.95,
        "current2": current2,
        "power2": power2,
        "pf2": 0.99,
        "energy_total": round(energy_total, 4),
        "cost_total": round(cost_total, 2),
        "state1": 1,         
        "state2": 1,         
        "theft_l1": 0,       
        "theft_l2": 0        
    }

    try:
        # Added a 10-second timeout so it doesn't hang
        response = requests.post(TB_URL, json=payload, timeout=10)
        if response.status_code == 200:
            print(f"[OK] Data pushed successfully: {json.dumps(payload)}")
        else:
            print(f"[ERROR] Failed to push. Status: {response.status_code}, {response.text}")
    except Exception as e:
        # Removed emojis to prevent Windows Unicode Encode Error
        print(f"[WARNING] Connection error: {e}")

    # Wait 5 seconds before the next update
    time.sleep(5)