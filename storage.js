const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_PLANS = [
    {
        id: '1-Hour-3Mbps',
        name: '1 Hour Pass',
        profile: '1-Hour-3Mbps',
        price: 100,
        duration: '1 Hour',
        durationHours: 1,
        speed: '3 Mbps',
        active: true
    },
    {
        id: '24-Hours-5Mbps',
        name: '24 Hours Pass',
        profile: '24-Hours-5Mbps',
        price: 200,
        duration: '24 Hours',
        durationHours: 24,
        speed: '5 Mbps',
        active: true
    },
    {
        id: '7-Days-5Mbps',
        name: '7 Days Pass',
        profile: '7-Days-5Mbps',
        price: 1200,
        duration: '7 Days',
        durationHours: 168,
        speed: '5 Mbps',
        active: true
    },
    {
        id: '1-Month-5Mbps',
        name: '1 Month Pass',
        profile: '1-Month-5Mbps',
        price: 3000,
        duration: '30 Days',
        durationHours: 720,
        speed: '5 Mbps',
        active: true
    }
];

class Store {
    constructor() {
        this.data = {
            transactions: [],
            vouchers: [],
            plans: DEFAULT_PLANS,
            settings: {
                currency: 'NGN',
                supportPhone: '',
                whatsappTemplate: 'Hello {name}, your NovaLink Wi-Fi voucher code is: *{voucher}* ({plan}). Valid until: {expires}. Connect at http://192.168.88.1'
            }
        };
        this.init();
    }

    init() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            if (fs.existsSync(DB_FILE)) {
                const raw = fs.readFileSync(DB_FILE, 'utf-8');
                const parsed = JSON.parse(raw);
                this.data = {
                    ...this.data,
                    ...parsed,
                    plans: parsed.plans && parsed.plans.length ? parsed.plans : DEFAULT_PLANS
                };
            } else {
                this.save();
            }
        } catch (e) {
            console.error('[STORAGE] Failed to initialize store:', e.message);
        }
    }

    save() {
        try {
            const tempFile = `${DB_FILE}.tmp`;
            fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf-8');
            fs.renameSync(tempFile, DB_FILE);
        } catch (e) {
            console.error('[STORAGE] Failed to save store:', e.message);
        }
    }

    // --- PLANS ---
    getPlans() {
        return this.data.plans.filter(p => p.active !== false);
    }

    getAllPlans() {
        return this.data.plans;
    }

    getPlanById(id) {
        return this.data.plans.find(p => p.id === id || p.profile === id);
    }

    savePlan(planData) {
        const index = this.data.plans.findIndex(p => p.id === planData.id);
        if (index >= 0) {
            this.data.plans[index] = { ...this.data.plans[index], ...planData };
        } else {
            this.data.plans.push(planData);
        }
        this.save();
        return planData;
    }

    deletePlan(planId) {
        this.data.plans = this.data.plans.filter(p => p.id !== planId);
        this.save();
        return true;
    }

    // --- TRANSACTIONS ---
    addTransaction(tx) {
        // Prevent duplicate reference entries
        const existingIdx = this.data.transactions.findIndex(t => t.reference === tx.reference);
        if (existingIdx >= 0) {
            this.data.transactions[existingIdx] = { ...this.data.transactions[existingIdx], ...tx };
        } else {
            this.data.transactions.unshift(tx);
        }
        this.save();
        return tx;
    }

    getTransactions(query = {}) {
        let list = [...this.data.transactions];
        if (query.search) {
            const s = query.search.toLowerCase().trim();
            list = list.filter(t => 
                (t.reference && t.reference.toLowerCase().includes(s)) ||
                (t.voucher && t.voucher.toLowerCase().includes(s)) ||
                (t.customer_phone && t.customer_phone.includes(s)) ||
                (t.customer_name && t.customer_name.toLowerCase().includes(s))
            );
        }
        return list;
    }

    // --- VOUCHERS ---
    addVoucher(v) {
        const existing = this.data.vouchers.findIndex(item => item.code === v.code);
        if (existing >= 0) {
            this.data.vouchers[existing] = { ...this.data.vouchers[existing], ...v };
        } else {
            this.data.vouchers.unshift(v);
        }
        this.save();
        return v;
    }

    addVouchers(vouchers) {
        vouchers.forEach(v => {
            const existing = this.data.vouchers.findIndex(item => item.code === v.code);
            if (existing >= 0) {
                this.data.vouchers[existing] = { ...this.data.vouchers[existing], ...v };
            } else {
                this.data.vouchers.unshift(v);
            }
        });
        this.save();
        return vouchers;
    }

    getVouchers(filter = {}) {
        let list = [...this.data.vouchers];
        if (filter.search) {
            const s = filter.search.toLowerCase().trim();
            list = list.filter(v => 
                (v.code && v.code.toLowerCase().includes(s)) ||
                (v.profile && v.profile.toLowerCase().includes(s)) ||
                (v.reference && v.reference.toLowerCase().includes(s))
            );
        }
        if (filter.status && filter.status !== 'all') {
            list = list.filter(v => v.status === filter.status);
        }
        return list;
    }

    deleteVoucher(code) {
        const before = this.data.vouchers.length;
        this.data.vouchers = this.data.vouchers.filter(v => v.code !== code);
        this.save();
        return this.data.vouchers.length < before;
    }

    expireOldVouchers() {
        const now = Date.now();
        const newlyExpired = [];
        let changed = false;
        this.data.vouchers.forEach(v => {
            if (v.status === 'active' && v.expires_at) {
                const expTime = new Date(v.expires_at).getTime();
                if (!isNaN(expTime) && now >= expTime) {
                    v.status = 'expired';
                    newlyExpired.push(v.code);
                    changed = true;
                }
            }
        });
        if (changed) {
            this.save();
        }
        return newlyExpired;
    }

    // --- STATS ---
    getStats() {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        let totalRevenue = 0;
        let todayRevenue = 0;
        let totalSold = 0;
        let todaySold = 0;

        this.data.transactions.forEach(t => {
            if (t.status === 'success') {
                const amt = Number(t.amount) || 0;
                totalRevenue += amt;
                totalSold += 1;
                const paidTime = new Date(t.paid_at || t.createdAt || 0).getTime();
                if (paidTime >= startOfToday) {
                    todayRevenue += amt;
                    todaySold += 1;
                }
            }
        });

        // Also add admin-generated cash vouchers to counts
        const cashVouchers = this.data.vouchers.filter(v => v.source === 'ADMIN_CASH');
        cashVouchers.forEach(v => {
            const amt = Number(v.price) || 0;
            totalRevenue += amt;
            totalSold += 1;
            const createdTime = new Date(v.created_at || 0).getTime();
            if (createdTime >= startOfToday) {
                todayRevenue += amt;
                todaySold += 1;
            }
        });

        return {
            totalRevenue,
            todayRevenue,
            totalSold,
            todaySold,
            totalVouchers: this.data.vouchers.length,
            activeVouchers: this.data.vouchers.filter(v => v.status === 'active').length,
            totalTransactions: this.data.transactions.length
        };
    }
}

const store = new Store();
module.exports = store;
