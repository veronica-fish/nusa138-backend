const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');

// ==========================================
// 1. INISIALISASI FIREBASE (DARI ENV RENDER)
// ==========================================
// Render akan membaca kunci JSON dari Environment Variable, bukan file fisik
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin berhasil diinisialisasi.");
} catch (error) {
    console.error("Gagal inisialisasi Firebase. Pastikan FIREBASE_SERVICE_ACCOUNT di set dengan benar di Render.");
}
const db = admin.firestore();

// ==========================================
// 2. KONFIGURASI DOKU (DARI ENV RENDER)
// ==========================================
const DOKU_CLIENT_ID = process.env.DOKU_CLIENT_ID;
const DOKU_SECRET_KEY = process.env.DOKU_SECRET_KEY;

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 3. ENDPOINT BUAT TAGIHAN DEPOSIT
// ==========================================
app.post('/api/buat-deposit', async (req, res) => {
    try {
        const { nominal, userId, username } = req.body;
        const invoiceNumber = "INV-" + Date.now();
        
        const payload = {
            order: { amount: nominal, invoice_number: invoiceNumber },
            payment: { payment_due_date: 60 },
            customer: { id: userId, name: username }
        };

        const requestId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const target = "/checkout/v1/payment";
        
        // Generate Signature Doku
        const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64');
        const component = `Client-Id:${DOKU_CLIENT_ID}\nRequest-Id:${requestId}\nRequest-Timestamp:${timestamp}\nRequest-Target:${target}\nDigest:${digest}`;
        const signature = crypto.createHmac('sha256', DOKU_SECRET_KEY).update(component).digest('base64');

        // Tembak API Doku
        const response = await axios.post(`https://api.doku.com${target}`, payload, {
            headers: {
                'Client-Id': DOKU_CLIENT_ID,
                'Request-Id': requestId,
                'Request-Timestamp': timestamp,
                'Signature': `HMACSHA256=${signature}`,
                'Content-Type': 'application/json'
            }
        });

        // Simpan tagihan ke Firestore (Status Pending)
        await db.collection('deposits').add({
            uid: userId,
            username: username,
            nominal: nominal,
            metode: "Doku",
            status: "Pending", 
            invoice: invoiceNumber,
            tanggal: admin.firestore.FieldValue.serverTimestamp()
        });

        // Kirim URL pembayaran Doku ke Frontend (Vercel)
        res.json({ url: response.data.response.payment.url });

    } catch (error) {
        console.error("Doku Error: ", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Gagal memproses ke Doku" });
    }
});

// ==========================================
// 4. ENDPOINT WEBHOOK (LAPORAN DARI DOKU)
// ==========================================
app.post('/api/webhook-doku', async (req, res) => {
    try {
        const { order, transaction } = req.body;

        // Jika Doku bilang pembayaran SUKSES
        if (transaction.status === 'SUCCESS') {
            const depositsRef = db.collection('deposits');
            const snapshot = await depositsRef.where('invoice', '==', order.invoice_number).get();
            
            if (!snapshot.empty) {
                snapshot.forEach(async (doc) => {
                    // Ubah status jadi "Pending Admin" agar admin bisa cek & setujui
                    await doc.ref.update({ 
                        status: "Pending Admin", 
                        metode: transaction.payment_method 
                    });
                    console.log(`Deposit ${order.invoice_number} lunas. Menunggu konfirmasi admin.`);
                });
            }
        }
        // Wajib membalas OK agar Doku tahu pesan diterima
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error: ", error);
        res.status(500).send('Error');
    }
});

// ==========================================
// 5. JALANKAN SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Doku berjalan di port ${PORT}`));
