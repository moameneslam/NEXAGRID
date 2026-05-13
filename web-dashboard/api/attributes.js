export default async function handler(req, res) {
    const { TB_URL, DEVICE_ID, JWT_TOKEN } = process.env;

    if (!TB_URL || !DEVICE_ID || !JWT_TOKEN) {
        return res.status(500).json({ error: 'Missing Vercel Environment Variables.' });
    }

    // --- GET REQUEST: Fetch current settings ---
    if (req.method === 'GET') {
        const url = `${TB_URL}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/attributes/SHARED_SCOPE`;
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Accept': 'application/json', 'X-Authorization': `Bearer ${JWT_TOKEN}` }
            });
            if (!response.ok) throw new Error("ThingsBoard rejected GET");
            
            // ThingsBoard formats attributes weirdly. We need to flatten them for the frontend.
            const rawData = await response.json();
            const cleanData = {};
            rawData.forEach(item => { cleanData[item.key] = item.value; });
            
            return res.status(200).json(cleanData);
        } catch (error) {
            return res.status(500).json({ error: 'Failed to fetch attributes' });
        }
    }

    // --- POST REQUEST: Save new settings to ESP32 ---
    if (req.method === 'POST') {
        const url = `${TB_URL}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/SHARED_SCOPE`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Authorization': `Bearer ${JWT_TOKEN}` },
                body: JSON.stringify(req.body)
            });
            if (!response.ok) throw new Error("ThingsBoard rejected POST");
            
            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: 'Failed to update attributes' });
        }
    }

    // If not GET or POST
    return res.status(405).json({ error: 'Method Not Allowed' });
}