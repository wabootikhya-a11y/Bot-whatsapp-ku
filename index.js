import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } from '@whiskeysockets/baileys';
import createWorker from 'tesseract.js';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';

// =========================================================================
// PENTING: Ganti teks di bawah ini dengan URL Web App panjang yang Anda simpan di LANGKAH 2 tadi!
// =========================================================================
const GOOGLE_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwTqJINC3AG0K_IbLIHSncSH7SzaCJyA8bEzoyxff92x8FdOdhFPU-Z7lbXyghK2bEd9g/exec';

async function sendToGoogleSheet(jenis, nominal, keterangan) {
    try {
        const response = await fetch(GOOGLE_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jenis, nominal, keterangan })
        });
        const result = await response.json();
        return result.status === 'success';
    } catch (error) {
        console.error("Gagal mengirim data:", error);
        return false;
    }
}

function cariNominalTerbesar(teks) {
    const regexAngka = /(?:rp\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d{4,8})/gi;
    let matches = teks.match(regexAngka);
    if (!matches) return 0;

    let daftarAngka = matches.map(val => {
        let bersih = val.replace(/[^0-9]/g, '');
        return parseInt(bersih);
    });
    return Math.max(...daftarAngka); // Mengambil angka terbesar (Total Belanja pada nota)
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Bot WhatsApp Berhasil Aktif!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;

        // PROGRAM BACA FOTO NOTA
        if (msg.message.imageMessage) {
            const caption = msg.message.imageMessage.caption || "";
            
            if (caption.startsWith('/nota')) {
                await sock.sendMessage(remoteJid, { text: "📸 Nota diterima. Sedang memproses dan membaca teks gambar..." });

                try {
                    const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const { data: { text } } = await Tesseract.recognize(buffer, 'ind+eng');
                    const nominalDitemukan = cariNominalTerbesar(text);
                    const keterangan = caption.replace('/nota', '').trim() || "Pengeluaran via Nota";

                    if (nominalDitemukan > 0) {
                        const success = await sendToGoogleSheet('Pengeluaran', nominalDitemukan, keterangan);
                        if (success) {
                            await sock.sendMessage(remoteJid, { text: `✅ *Berhasil Dicatat via Foto!*\n\n💵 Nominal: Rp ${nominalDitemukan.toLocaleString('id-ID')}\n📝 Ket: ${keterangan}` });
                        } else {
                            await sock.sendMessage(remoteJid, { text: "❌ Gagal menyimpan ke Spreadsheet." });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Angka nominal tidak terbaca jelas. Silakan gunakan format teks manual." });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: "❌ Terjadi error saat membaca gambar." });
                }
            }
            return;
        }

        // PROGRAM BACA TEKS MANUAL
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        if (textMessage.startsWith('/masuk') || textMessage.startsWith('/keluar')) {
            const parts = textMessage.split(' ');
            if (parts.length < 3) {
                await sock.sendMessage(remoteJid, { text: "⚠️ Format salah. Contoh: `/keluar 15000 Bakso`" });
                return;
            }

            const command = parts[0];
            const jenis = command === '/masuk' ? 'Pemasukan' : 'Pengeluaran';
            const nominal = parts[1].replace(/[^0-9]/g, '');
            const keterangan = parts.slice(2).join(' ');

            await sock.sendMessage(remoteJid, { text: "⏳ Sedang mencatat..." });
            const success = await sendToGoogleSheet(jenis, parseInt(nominal), keterangan);

            if (success) {
                await sock.sendMessage(remoteJid, { text: `✅ *Berhasil Dicatat!*\n\n📅 Jenis: ${jenis}\n💵 Nominal: Rp ${parseInt(nominal).toLocaleString('id-ID')}\n📝 Ket: ${keterangan}` });
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ Gagal menyimpan data." });
            }
        }

        if (textMessage === '/menu' || textMessage === '/help') {
            const menuText = `📱 *BOT PENCATAT KEUANGAN* 📱\n\n` +
                             `✍️ *PENCATATAN MANUAL (TEKS):*\n` +
                             `• \`/masuk [nominal] [keterangan]\`\n` +
                             `• \`/keluar [nominal] [keterangan]\`\n\n` +
                             `📸 *PENCATATAN OTOMATIS (FOTO NOTA):*\n` +
                             `Kirim foto nota belanja dengan menambahkan CAPTION teks: \`/nota [keterangan]\``;
            await sock.sendMessage(remoteJid, { text: menuText });
        }
    });
}
connectToWhatsApp();