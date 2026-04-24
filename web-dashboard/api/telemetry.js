export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { TB_URL, DEVICE_ID, JWT_TOKEN } = process.env;

    if (!TB_URL || !DEVICE_ID || !JWT_TOKEN) {
        return res.status(500).json({ error: 'Missing Vercel Environment Variables.' });
    }

    // The secure Authenticated User endpoint for reading data
    const url = `${TB_URL}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=voltage,current,power`;

    try {
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

        const data = await tbResponse.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Telemetry Error:', error);
        return res.status(500).json({ error: 'Failed to fetch telemetry from ThingsBoard.' });
    }
}