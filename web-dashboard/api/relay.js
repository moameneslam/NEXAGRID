export default async function handler(req, res) {
    // 1. Only accept POST requests (button clicks)
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. Read the variables you saved in the Vercel Dashboard
    const { TB_URL, DEVICE_ID, JWT_TOKEN } = process.env;

    if (!TB_URL || !DEVICE_ID || !JWT_TOKEN) {
        return res.status(500).json({ error: 'Vercel Environment Variables are missing.' });
    }

    // 3. Unpack the command from the frontend
    const { loadNumber, state } = req.body;
    const thingsboardUrl = `${TB_URL}/api/plugins/rpc/twoway/${DEVICE_ID}`;

    try {
        // 4. Send the secure command to ThingsBoard
        const tbResponse = await fetch(thingsboardUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({
                method: `setRelay${loadNumber}`,
                params: state
            })
        });

        if (!tbResponse.ok) {
            throw new Error(`ThingsBoard rejected the command. Status: ${tbResponse.status}`);
        }

        // 5. Tell the frontend it worked!
        const tbData = await tbResponse.json();
        return res.status(200).json({ success: true, data: tbData });

    } catch (error) {
        console.error('Relay Error:', error);
        return res.status(500).json({ error: 'Failed to talk to ThingsBoard.' });
    }
}