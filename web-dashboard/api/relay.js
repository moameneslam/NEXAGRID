export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { TB_URL, DEVICE_ID, JWT_TOKEN } = process.env;

    if (!TB_URL || !DEVICE_ID || !JWT_TOKEN) {
        return res.status(500).json({ error: 'Vercel Environment Variables are missing.' });
    }

    const { loadNumber, state } = req.body;
    
    // THE FIX: The modern ThingsBoard RPC endpoint (removed /plugins/)
    const thingsboardUrl = `${TB_URL}/api/rpc/twoway/${DEVICE_ID}`;

    try {
        const tbResponse = await fetch(thingsboardUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({
                method: `setRelay${loadNumber}`,
                params: state,
                timeout: 5000 // Tell TB to timeout after 5 seconds if ESP32 ignores it
            })
        });

        // X-RAY VISION: Capture the exact reason ThingsBoard rejected it
        if (!tbResponse.ok) {
            const errorText = await tbResponse.text();
            console.error("ThingsBoard Error Details:", errorText);
            return res.status(tbResponse.status).json({ 
                error: `TB Error ${tbResponse.status}: ${errorText}` 
            });
        }

        const tbData = await tbResponse.json();
        return res.status(200).json({ success: true, data: tbData });

    } catch (error) {
        console.error('Relay Error:', error);
        return res.status(500).json({ error: 'Failed to communicate with ThingsBoard server.' });
    }
}