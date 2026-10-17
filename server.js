const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

// 1. Initialize Express App & Middleware
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// HTTPS Agent for RouterOS REST API self-signed SSL certificates
const mikrotikAgent = new https.Agent({
    rejectUnauthorized: false
});

// Mapping frontend packages to RouterOS Hotspot User Profiles & Uptime Limits
const PACKAGE_PROFILES = {
    '1-Hour': { profile: '1-Hour', limit: '1h', amount: 100 },
    '24-Hours': { profile: '24-Hours', limit: '1d', amount: 200 },
    '7-Days': { profile: '7-Days', limit: '7d', amount: 1200 },
    '1-Month': { profile: '1-Month', limit: '30d', amount: 3000 }
};

const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

// In-memory store for client polling (`login.html` checks this using payment reference)
const voucherStore = {};

// Helper function: Generate random secure voucher code
function generateCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars like 0, O, 1, I
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'NV-' + result;
}

// ==========================================
// 1. CLIENT PAYMENT & VOUCHER ENDPOINTS
// ==========================================

// Initialize Payment (Called from frontend when user selects a plan)
app.post('/api/initialize-payment', async (req, res) => {
    try {
        const { package: pkgKey, amount, mac, email } = req.body;

        if (!PACKAGE_PROFILES[pkgKey]) {
            return res.status(400).json({ error: 'Invalid package selected' });
        }

        const userEmail = email || `user_${mac ? mac.replace(/:/g, '') : Date.now()}@novalink.wifi`;

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: userEmail,
                amount: amount * 100, // Convert NGN to kobo
                metadata: {
                    mac: mac || '',
                    package: pkgKey,
                    profile: PACKAGE_PROFILES[pkgKey].profile
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({ 
            status: true,
            authorization_url: paystackResponse.data.data.authorization_url,
            reference: paystackResponse.data.data.reference 
        });
    } catch (err) {
        console.error('Payment init error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize payment with Paystack' });
    }
});

// Paystack Webhook Handler (Triggers securely from Paystack on successful charge)
app.post('/webhook/paystack', async (req, res) => {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                       .update(JSON.stringify(req.body))
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        return res.status(400).send('Invalid signature');
    }

    const event = req.body;

    if (event.event === 'charge.success') {
        const reference = event.data.reference;
        const amountKobo = event.data.amount;
        const metadata = event.data.metadata || {};
        
        // Find matching package by amount or metadata profile
        let matchedPkg = Object.keys(PACKAGE_PROFILES).find(
            key => PACKAGE_PROFILES[key].amount * 100 === amountKobo
        );

        if (!matchedPkg && metadata.package) {
            matchedPkg = metadata.package;
        }

        const config = PACKAGE_PROFILES[matchedPkg] || PACKAGE_PROFILES['1-Hour'];
        const voucherCode = generateCode(6);

        try {
            // Create user directly on MikroTik RB5009 via REST API
            const url = `https://${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_REST_PORT || 443}/rest/ip/hotspot/user`;
            const authHeader = 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');

            await axios.put(
                url,
                {
                    name: voucherCode,
                    password: voucherCode,
                    profile: config.profile,
                    'limit-uptime': config.limit,
                    comment: `Paystack Ref: ${reference}`
                },
                {
                    headers: { 
                        Authorization: authHeader,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: mikrotikAgent
                }
            );

            // Store voucher in memory mapped to reference so frontend polling can grab it
            voucherStore[reference] = voucherCode;

            console.log(`[SUCCESS] Voucher ${voucherCode} created for payment ref: ${reference}`);
            return res.status(200).send('Voucher Provisioned');

        } catch (error) {
            console.error('MikroTik REST API Error:', error.response?.data || error.message);
            return res.status(500).send('Failed to write user to router');
        }
    }

    res.status(200).send('Event received');
});

// Polling endpoint called by login.html after payment completion
app.get('/api/get-voucher', (req, res) => {
    const ref = req.query.ref;

    if (ref && voucherStore[ref]) {
        const code = voucherStore[ref];
        delete voucherStore[ref]; // Clean up after retrieval
        return res.json({ status: 'success', voucher: code });
    }

    return res.json({ status: 'pending', voucher: null });
});

// ==========================================
// 2. ADMIN PANEL ENDPOINTS
// ==========================================

// Generate Vouchers manually via Admin panel
app.post('/api/admin/generate-vouchers', async (req, res) => {
    const { pin, package: pkgKey, quantity } = req.body;

    if (pin !== ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
    }

    if (!PACKAGE_PROFILES[pkgKey]) {
        return res.status(400).json({ error: 'Invalid profile package selected' });
    }

    const count = parseInt(quantity) || 1;
    const config = PACKAGE_PROFILES[pkgKey];
    const createdVouchers = [];

    const url = `https://${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_REST_PORT || 443}/rest/ip/hotspot/user`;
    const authHeader = 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');

    try {
        for (let i = 0; i < count; i++) {
            const voucherCode = generateCode(6);

            await axios.put(
                url,
                {
                    name: voucherCode,
                    password: voucherCode,
                    profile: config.profile,
                    'limit-uptime': config.limit,
                    comment: 'Generated by Cash Admin'
                },
                {
                    headers: { 
                        Authorization: authHeader,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: mikrotikAgent
                }
            );

            createdVouchers.push({ code: voucherCode, profile: config.profile, price: config.amount });
        }

        res.json({ success: true, vouchers: createdVouchers });
    } catch (err) {
        console.error('Voucher generation error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to write vouchers to RouterOS' });
    }
});

// Fetch Active Hotspot Users for Admin Management
app.get('/api/admin/active-users', async (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    const url = `https://${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_REST_PORT || 443}/rest/ip/hotspot/active`;
    const authHeader = 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');

    try {
        const response = await axios.get(url, {
            headers: { Authorization: authHeader },
            httpsAgent: mikrotikAgent
        });
        res.json({ activeUsers: response.data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch active sessions' });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NovaLink Payment Bridge running on port ${PORT}`));
