// ==========================================
// 1. WEB LOGIN LOGIC
// ==========================================
const VALID_USER = "admin";
const VALID_PASS = "nexagrid2024";

function checkLogin() {
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    const errorDiv = document.getElementById('login-error');

    if (user === VALID_USER && pass === VALID_PASS) {
        document.getElementById('login-overlay').classList.add('hidden');
        startDashboard(); // Boot the system!
    } else {
        errorDiv.innerText = "Invalid username or password.";
        document.getElementById('login-pass').value = ""; 
    }
}

// Allow pressing "Enter" to login
document.getElementById('login-pass').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') checkLogin();
});

// ==========================================
// 2. CONFIGURATION & STATE
// ==========================================
let load1State = false; 
let load2State = false;
let chartInstance1 = null;
let chartInstance2 = null;
let rpcCooldown = 0; 
let lastValidDataTime = 0; 

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
// 4. UI LOGIC: BUTTON SYNC ENGINE 
// ==========================================
function syncButtonUI(loadNumber, isOn, currentAmps = 0, isTheft = false) {
    const btn = document.getElementById('btn-load' + loadNumber);
    const statusBadge = document.getElementById('status-load' + loadNumber);
    const btnText = document.getElementById('btn-text-' + loadNumber);

    // 🚨 Check for Theft/Bypass First!
    if (isTheft) {
        btn.classList.add('off'); btnText.innerText = "LOCKED";
        statusBadge.className = 'relay-status offline';
        statusBadge.style.backgroundColor = "rgba(231, 76, 60, 0.2)";
        statusBadge.style.color = "var(--red)";
        statusBadge.style.borderColor = "var(--red)";
        statusBadge.innerText = "⚠️ THEFT/BYPASS DETECTED";
        return;
    }

    // Normal Operations
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
// 5. CHART.JS INITIALIZATION
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
    const now = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
    [chartInstance1, chartInstance2].forEach(chart => {
        if (chart.data.labels.length > 15) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); chart.data.datasets[1].data.shift(); }
        chart.data.labels.push(now); chart.data.datasets[0].data.push(p1); chart.data.datasets[1].data.push(p2);
        chart.update(); 
    });
}

// ==========================================
// 6. THE GET API (FETCH TELEMETRY)
// ==========================================
async function fetchRealData() {
    try {
        // 👉 THIS CALLS YOUR api/telemetry.js FILE
        const response = await fetch('/api/telemetry');
        if (!response.ok) throw new Error("Vercel API error");
        
        const data = await response.json();
        lastValidDataTime = Date.now(); 

        const getVal = (key) => (data[key] && data[key][0]) ? parseFloat(data[key][0].value) : 0;

        const v = getVal('voltage');
        const i1 = getVal('current1');
        const i2 = getVal('current2');
        const p1 = getVal('power1');
        const p2 = getVal('power2');
        const eTotal = getVal('energy_total');
        const cTotal = getVal('cost_total');
        
        // Check for Theft Flags from ESP32
        const theft1 = getVal('theft_l1') === 1;
        const theft2 = getVal('theft_l2') === 1;
        
        // Hardware State Two-Way Sync
        if (Date.now() > rpcCooldown) {
            const s1 = data['state1'] ? data['state1'][0].value.toString().toLowerCase() : null;
            const s2 = data['state2'] ? data['state2'][0].value.toString().toLowerCase() : null;

            if (s1 !== null) {
                load1State = (s1 === "1" || s1 === "true" || s1 === "1.0");
                syncButtonUI(1, load1State, i1, theft1); 
            }
            if (s2 !== null) {
                load2State = (s2 === "1" || s2 === "true" || s2 === "1.0");
                syncButtonUI(2, load2State, i2, theft2); 
            }
        }

        const totalP = p1 + p2;
        const totalI = i1 + i2;

        document.getElementById('voltage_full').innerText = v.toFixed(1);
        document.getElementById('totalPower').innerText = (totalP / 1000).toFixed(2);
        document.getElementById('energyToday').innerText = eTotal.toFixed(4);
        document.getElementById('totalCost').innerText = cTotal.toFixed(3);

        document.getElementById('load1-split').innerText = (p1 / 1000).toFixed(2) + ' kW';
        document.getElementById('load2-split').innerText = (p2 / 1000).toFixed(2) + ' kW';
        document.getElementById('load-total-split').innerText = (totalP / 1000).toFixed(2) + ' kW';
        
        document.getElementById('r1-volts').innerText = v.toFixed(1) + ' V';
        document.getElementById('r1-amps').innerText = i1.toFixed(2) + ' A';
        document.getElementById('r1-power').innerText = (p1 / 1000).toFixed(2) + ' kW';
        
        document.getElementById('r2-volts').innerText = v.toFixed(1) + ' V';
        document.getElementById('r2-amps').innerText = i2.toFixed(2) + ' A';
        document.getElementById('r2-power').innerText = (p2 / 1000).toFixed(2) + ' kW';

        if (v > 0 && totalI > 0) {
            const pf = Math.min(1.0, totalP / (v * totalI));
            document.querySelector('.pf-value').innerText = pf.toFixed(2);
            document.querySelector('.pf-gauge-fill').style.width = (pf * 100) + "%";
        }

        updateCharts(p1, p2);

    } catch (error) {
        console.error("Vercel Telemetry API unreachable:", error);
    }
    
    updateConnectionStatus();
}

// ==========================================
// 7. DYNAMIC CONNECTION STATUS CHECK
// ==========================================
function updateConnectionStatus() {
    const statusText = document.getElementById('main-conn-text');
    const statusDot = document.getElementById('main-conn-dot');
    const statusDiv = document.getElementById('main-conn-status');

    if (Date.now() - lastValidDataTime > 15000) {
        statusText.innerText = "ESP32 Offline";
        statusDiv.style.color = "var(--red)";
        statusDot.style.backgroundColor = "var(--red)";
        statusDot.style.boxShadow = "0 0 8px var(--red)";
    } else {
        statusText.innerText = "ESP32 Online";
        statusDiv.style.color = "var(--green)";
        statusDot.style.backgroundColor = "var(--green)";
        statusDot.style.boxShadow = "0 0 8px var(--green)";
    }
}

// ==========================================
// 8. THE POST API (SEND RELAY COMMANDS)
// ==========================================
async function sendRpcCommand(loadNumber) {
    let newState;
    if (loadNumber === 1) { load1State = !load1State; newState = load1State; } 
    else { load2State = !load2State; newState = load2State; }

    syncButtonUI(loadNumber, newState);
    rpcCooldown = Date.now() + 8000; 

    try {
        // 👉 THIS CALLS YOUR api/relay.js FILE
        const res = await fetch('/api/relay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loadNumber, state: newState })
        });

        if (!res.ok) {
            const errData = await res.json();
            alert("⚠️ Command Failed!\nReason: " + (errData.error || "Unknown Error"));
            if (loadNumber === 1) { load1State = !newState; syncButtonUI(1, load1State); } 
            else { load2State = !newState; syncButtonUI(2, load2State); }
        }

    } catch (error) {
        console.error("Relay Command failed:", error);
        alert("⚠️ Network error. Could not reach Vercel.");
    }
}

function updateFooter() { document.getElementById('footer-time').innerText = new Date().toLocaleString(); }

// ==========================================
// 9. DASHBOARD BOOTSTRAP 
// ==========================================
function startDashboard() {
    initCharts();
    fetchRealData();
    updateFooter();
    setInterval(fetchRealData, 5000); 
    setInterval(updateFooter, 60000);
}