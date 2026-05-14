// ==========================================
// 1. WEB LOGIN & SECURITY
// ==========================================
const VALID_USER = "admin";
const VALID_PASS = "nexagrid2024";

/**
 * Validates login credentials to grant access to the dashboard.
 */
function checkLogin() {
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    const errorDiv = document.getElementById('login-error');

    if (user === VALID_USER && pass === VALID_PASS) {
        document.getElementById('login-overlay').classList.add('hidden');
        startDashboard();
    } else {
        errorDiv.innerText = "Invalid username or password.";
        document.getElementById('login-pass').value = ""; 
    }
}

document.getElementById('login-pass').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') checkLogin();
});

// ==========================================
// 2. CONFIGURATION & GLOBAL STATE
// ==========================================
let load1State = false; 
let load2State = false;
let chartInstance1 = null;
let chartInstance2 = null;
let rpcCooldown = 0; 
let lastValidDataTime = 0; 

// --- Web-Side Billing & Credit State ---
let creditBalance = parseFloat(localStorage.getItem('nexaWebCredit')) || 0.0;
let lastEspCost = 0.0; 
let isSmartModeEnabled = false;

// ==========================================
// 3. UI LOGIC: TAB SWITCHING
// ==========================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    if(event) event.target.classList.add('active');
}

// ==========================================
// 4. UI LOGIC: BUTTON & STATUS SYNC
// ==========================================
/**
 * Synchronizes the relay buttons and status badges with actual hardware states.
 * Includes overrides for Theft detection.
 */
function syncButtonUI(loadNumber, isOn, currentAmps = 0, isTheft = false) {
    const btn = document.getElementById('btn-load' + loadNumber);
    const statusBadge = document.getElementById('status-load' + loadNumber);
    const btnText = document.getElementById('btn-text-' + loadNumber);

    if (!btn || !statusBadge) return;

    statusBadge.style = ""; // Reset inline styles

    if (isTheft) {
        btn.classList.add('off'); btnText.innerText = "LOCKED";
        statusBadge.className = 'relay-status offline';
        statusBadge.innerText = "⚠️ THEFT / BYPASS";
        return;
    }

    if (isOn) {
        btn.classList.remove('off'); btnText.innerText = "Turn OFF";
        if (currentAmps >= 3.5) {
            statusBadge.className = 'relay-status warning';
            statusBadge.innerText = "⚠️ CRITICAL";
        } else {
            statusBadge.className = 'relay-status';
            statusBadge.innerText = "● ONLINE";
        }
    } else {
        btn.classList.add('off'); btnText.innerText = "Turn ON";
        statusBadge.className = 'relay-status offline';
        statusBadge.innerText = "○ OFFLINE";
    }
}

// ==========================================
// 5. CHART.JS INITIALIZATION & UPDATES
// ==========================================
function initCharts() {
    const chartConfig = {
        type: 'line',
        data: {
            labels: [], datasets: [
                { label: 'Load 1 (W)', borderColor: '#39c5cf', backgroundColor: 'rgba(57, 197, 207, 0.1)', data: [], fill: true, tension: 0.4 },
                { label: 'Load 2 (W)', borderColor: '#f2cc60', backgroundColor: 'rgba(242, 204, 96, 0.1)', data: [], fill: true, tension: 0.4 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, grid: { color: '#30363d' }, ticks: { color: '#8b949e' } }, x: { grid: { display: false }, ticks: { color: '#8b949e' } } },
            plugins: { legend: { labels: { color: '#f0f6fc' } } }, animation: { duration: 0 } 
        }
    };
    chartInstance1 = new Chart(document.getElementById('liveChart').getContext('2d'), JSON.parse(JSON.stringify(chartConfig)));
    chartInstance2 = new Chart(document.getElementById('analyticsChart').getContext('2d'), JSON.parse(JSON.stringify(chartConfig)));
}

function updateCharts(p1, p2) {
    const nowStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
    [chartInstance1, chartInstance2].forEach(chart => {
        if (!chart) return;
        if (chart.data.labels.length > 15) { 
            chart.data.labels.shift(); 
            chart.data.datasets[0].data.shift(); 
            chart.data.datasets[1].data.shift(); 
        }
        chart.data.labels.push(nowStr); 
        chart.data.datasets[0].data.push(p1); 
        chart.data.datasets[1].data.push(p2);
        chart.update(); 
    });
}

// ==========================================
// 6. TELEMETRY & WEB CREDIT ENGINE
// ==========================================
/**
 * Main loop: Fetches telemetry and updates the local Credit Engine.
 */
async function fetchRealData() {
    try {
        const response = await fetch('/api/telemetry');
        if (!response.ok) throw new Error("Vercel API error");
        
        const data = await response.json();
        const now = Date.now();
        lastValidDataTime = now; 

        const getVal = (key) => (data[key] && data[key][0]) ? parseFloat(data[key][0].value) : 0;

        const v = getVal('voltage');
        const i1 = getVal('current1'), i2 = getVal('current2');
        const p1 = getVal('power1'), p2 = getVal('power2');
        const currentEspCost = getVal('cost_total');
        const eTotal = getVal('energy_total');
        const theft1 = getVal('theft_l1') === 1, theft2 = getVal('theft_l2') === 1;

        // --- WEB-SIDE CREDIT ENGINE ---
        // Subtracts the cost difference reported by ESP32 from the local balance
        if (lastEspCost > 0 && currentEspCost > lastEspCost) {
            const costDiff = currentEspCost - lastEspCost;
            creditBalance -= costDiff;
            if (creditBalance < 0) creditBalance = 0;
            localStorage.setItem('nexaWebCredit', creditBalance.toFixed(6));
        }
        lastEspCost = currentEspCost;

        // Auto-Cutoff Logic: If balance reaches 0, force relays OFF via RPC
        if (creditBalance <= 0 && (load1State || load2State)) {
            console.warn("Insufficient credit. Cutting off loads.");
            if (load1State) sendRpcCommand(1); 
            if (load2State) sendRpcCommand(2);
        }

        // Hardware State Sync (Blocked during RPC cooldown)
        if (now > rpcCooldown) {
            const s1 = data['state1'] ? data['state1'][0].value.toString().toLowerCase() : "0";
            const s2 = data['state2'] ? data['state2'][0].value.toString().toLowerCase() : "0";
            load1State = (s1 === "1" || s1 === "true");
            load2State = (s2 === "1" || s2 === "true");
            syncButtonUI(1, load1State, i1, theft1); 
            syncButtonUI(2, load2State, i2, theft2); 
        }

        // Update Overview & Billing UI
        const fmtCredit = creditBalance.toFixed(2);
        document.getElementById('overview-credit').innerText = fmtCredit;
        document.getElementById('billing-credit').innerText = fmtCredit;
        
        //document.getElementById('voltage_full').innerText = v.toFixed(1);
        document.getElementById('totalPower').innerText = ((p1 + p2) / 1000).toFixed(2);
        document.getElementById('energyToday').innerText = eTotal.toFixed(4);
        document.getElementById('totalCost').innerText = currentEspCost.toFixed(2);

        document.getElementById('load1-split').innerText = (p1 / 1000).toFixed(2) + ' kW';
        document.getElementById('load2-split').innerText = (p2 / 1000).toFixed(2) + ' kW';
        document.getElementById('load-total-split').innerText = ((p1 + p2) / 1000).toFixed(2) + ' kW';
        
        document.getElementById('r1-volts').innerText = v.toFixed(1) + ' V';
        document.getElementById('r1-amps').innerText = i1.toFixed(2) + ' A';
        document.getElementById('r1-power').innerText = (p1 / 1000).toFixed(2) + ' kW';
        document.getElementById('r2-volts').innerText = v.toFixed(1) + ' V';
        document.getElementById('r2-amps').innerText = i2.toFixed(2) + ' A';
        document.getElementById('r2-power').innerText = (p2 / 1000).toFixed(2) + ' kW';

        updateCharts(p1, p2);

    } catch (error) {
        console.error("Telemetry fetch error:", error);
    }
    updateConnectionStatus();
}

// ==========================================
// 7. SECURE TOP UP SYSTEM
// ==========================================
/**
 * Processes a credit top-up after verifying admin password.
 */
function processTopUp() {
    const amtInput = document.getElementById('topup-input');
    const passInput = document.getElementById('topup-pass');
    
    const amount = parseFloat(amtInput.value);
    const pass = passInput.value;
    
    if (isNaN(amount) || amount <= 0) return alert("Please enter a valid amount.");
    if (pass !== VALID_PASS) {
        alert("❌ Unauthorized: Invalid Admin Password.");
        passInput.value = "";
        return;
    }

    creditBalance += amount;
    localStorage.setItem('nexaWebCredit', creditBalance.toFixed(6));
    
    const formatted = creditBalance.toFixed(2);
    document.getElementById('overview-credit').innerText = formatted;
    document.getElementById('billing-credit').innerText = formatted;
    
    amtInput.value = "";
    passInput.value = "";
    alert(`✅ Authorization Success: Added ${amount} EGP.`);
}

// ==========================================
// 8. RELAY CONTROL (RPC)
// ==========================================
async function sendRpcCommand(loadNumber) {
    let newState = (loadNumber === 1) ? !load1State : !load2State;
    syncButtonUI(loadNumber, newState);
    rpcCooldown = Date.now() + 8000; // Block telemetry sync briefly

    try {
        const res = await fetch('/api/relay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loadNumber, state: newState })
        });
        if (!res.ok) throw new Error("RPC Rejected");
    } catch (error) {
        console.error("Relay error:", error);
        // Revert UI on failure
        if (loadNumber === 1) { load1State = !newState; syncButtonUI(1, load1State); } 
        else { load2State = !newState; syncButtonUI(2, load2State); }
    }
}

// ==========================================
// 9. HARDWARE SETTINGS (ATTRIBUTES)
// ==========================================
async function fetchHardwareSettings() {
    try {
        const response = await fetch('/api/attributes');
        if (!response.ok) return;
        const data = await response.json();
        
        if (data.globalCurrentLimit !== undefined) document.getElementById('set-global-limit').value = data.globalCurrentLimit;
        if (data.isLoad1Essential !== undefined) document.getElementById('set-l1-essential').checked = data.isLoad1Essential;
        if (data.isLoad2Essential !== undefined) document.getElementById('set-l2-essential').checked = data.isLoad2Essential;

        document.getElementById('ui-ess-1').style.display = data.isLoad1Essential ? 'inline' : 'none';
        document.getElementById('ui-ess-2').style.display = data.isLoad2Essential ? 'inline' : 'none';
    } catch (error) {
        console.error("Attribute sync error:", error);
    }
}

async function saveHardwareSettings() {
    const body = {
        globalCurrentLimit: parseFloat(document.getElementById('set-global-limit').value),
        isLoad1Essential: document.getElementById('set-l1-essential').checked,
        isLoad2Essential: document.getElementById('set-l2-essential').checked
    };

    try {
        const res = await fetch('/api/attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Sync Failed");
        alert("✅ Hardware Settings synced to ESP32 Flash Memory!");
        document.getElementById('ui-ess-1').style.display = body.isLoad1Essential ? 'inline' : 'none';
        document.getElementById('ui-ess-2').style.display = body.isLoad2Essential ? 'inline' : 'none';
    } catch (error) {
        alert("⚠️ Network error. Could not reach panel.");
    }
}

// ==========================================
// 10. ECONOMIC SMART GRID (PEAK SHIFTING)
// ==========================================
function saveEconomicSettings() {
    isSmartModeEnabled = document.getElementById('set-smart-mode').checked;
    localStorage.setItem('nexaEconomic', isSmartModeEnabled);
}

function loadEconomicSettings() {
    const saved = localStorage.getItem('nexaEconomic');
    isSmartModeEnabled = (saved === 'true');
    document.getElementById('set-smart-mode').checked = isSmartModeEnabled;
}

function checkSmartGrid() {
    if (!isSmartModeEnabled) return;
    const hour = new Date().getHours();
    const isPeak = (hour >= 18 && hour < 22);

    if (isPeak) {
        const l1Ess = document.getElementById('set-l1-essential').checked;
        const l2Ess = document.getElementById('set-l2-essential').checked;
        if (!l1Ess && load1State) {
            console.log("SMART GRID: Shedding non-essential Load 1");
            sendRpcCommand(1);
        }
        if (!l2Ess && load2State) {
            console.log("SMART GRID: Shedding non-essential Load 2");
            sendRpcCommand(2);
        }
    }
}

// ==========================================
// 11. BOOTSTRAP & SYSTEM UTILS
// ==========================================
function updateConnectionStatus() {
    const statusText = document.getElementById('main-conn-text');
    const statusDot = document.getElementById('main-conn-dot');
    const statusDiv = document.getElementById('main-conn-status');

    if (Date.now() - lastValidDataTime > 15000) {
        statusText.innerText = "ESP32 Offline";
        statusDiv.style.color = "var(--red)";
        statusDot.style.backgroundColor = "var(--red)";
    } else {
        statusText.innerText = "ESP32 Online";
        statusDiv.style.color = "var(--green)";
        statusDot.style.backgroundColor = "var(--green)";
    }
}

function updateFooter() { 
    document.getElementById('footer-time').innerText = new Date().toLocaleString(); 
}

/**
 * Initializes dashboard cycles upon successful login.
 */
function startDashboard() {
    initCharts();
    loadEconomicSettings();
    fetchRealData();
    fetchHardwareSettings(); 
    updateFooter();
    setInterval(fetchRealData, 5000); 
    setInterval(checkSmartGrid, 30000); // Check smart grid every 30 seconds
    setInterval(updateFooter, 60000);
}