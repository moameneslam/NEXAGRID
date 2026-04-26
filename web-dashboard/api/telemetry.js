export default async function handler(req, res) {
    // 1. Only allow GET requests for telemetry
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. Load Environment Variables
    const { TB_URL, DEVICE_ID, JWT_TOKEN } = process.env;

    if (!TB_URL || !DEVICE_ID || !JWT_TOKEN) {
        return res.status(500).json({ error: 'Missing Vercel Environment Variables.' });
    }

    // 3. THE FIX: Ask ThingsBoard for all the new separated load keys!
    const keys = "voltage,current1,current2,power1,power2,pf1,pf2,energy_total,cost_total";
    
    // Build the secure endpoint URL
    const url = `${TB_URL}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=${keys}`;

    try {
        // 4. Fetch the data from ThingsBoard
        const tbResponse = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': `Bearer ${JWT_TOKEN}`
            }
        });

        if (!tbResponse.ok) {
            throw new Error(`ThingsBoard rejected the request. Status: ${tbResponse.status}`);
        }

        // 5. Send the full data package down to your HTML Dashboard
        const data = await tbResponse.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Telemetry Error:', error);
        return res.status(500).json({ error: 'Failed to fetch telemetry from ThingsBoard.' });
    }
}