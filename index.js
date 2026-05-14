require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100MB for large screenshots
});

const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 2759;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'NuLzDev@1337';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const axios = require('axios');
const SHEET_URL = process.env.SHEET_URL;

async function getValidTokens() {
    try {
        if (!SHEET_URL) return AUTH_TOKEN.split(',').map(t => t.trim());

        const response = await axios.get(SHEET_URL);
        // Pecah CSV jadi array (asumsi tiap baris 1 token di kolom A)
        const tokens = response.data.split('\n').map(t => t.trim()).filter(t => t !== '');
        return tokens;
    } catch (err) {
        console.error('Error fetching tokens from Google Sheets:', err.message);
        return AUTH_TOKEN.split(',').map(t => t.trim()); // Fallback ke .env
    }
}

// Middleware for Socket.io Auth (Google Sheets Support)
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const allowedTokens = await getValidTokens();

    if (allowedTokens.includes(token)) {
        return next();
    }
    console.log('Unauthorized connection attempt with token:', token);
    return next(new Error("Authentication error"));
});

const { Markup } = require('telegraf');

io.on('connection', (socket) => {
    console.log('A client connected:', socket.id);

    socket.on('notification', async (data) => {
        console.log(`Received ${data.type} notification from extension:`, data.id);

        try {
            const chatIds = process.env.CHAT_IDS.split(',');
            let type = data.type || "TRANSAKSI";

            // Generate Waktu Sekarang (WIB)
            const now = new Date().toLocaleString('id-ID', { 
                timeZone: 'Asia/Jakarta', 
                day: '2-digit', 
                month: '2-digit', 
                year: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit',
                hour12: false 
            }).replace(/\./g, ':');

            let message = "";
            if (type === 'DEPOSIT') {
                message = `🔔 *NOTIFIKASI DEPOSIT*\n\n` +
                    `🆔 *ID:* \`${data.id}\`\n` +
                    `👤 *User:* ${data.user}\n` +
                    `💰 *Jumlah:* ${data.amount}\n` +
                    `🏦 *Bank Pengirim:* ${data.bank_pengirim}\n` +
                    `🏦 *Bank Penerima:* ${data.bank_penerima}\n` +
                    `⏰ *Waktu:* \`${now}\`\n\n` +
                    `⚡️ _Silahkan diproses bosku!_`;
            } else {
                // Formatting khusus Withdraw: Cuma nomor rekening yang dimonospace
                const formattedBank = data.bank_penerima.replace(/(\d{5,})/g, '`$1`');

                message = `🔔 *NOTIFIKASI WITHDRAW*\n\n` +
                    `🆔 *ID:* \`${data.id}\`\n` +
                    `👤 *User:* ${data.user}\n` +
                    `💰 *Jumlah:* ${data.amount}\n` +
                    `🏦 *Bank Penerima:* ${formattedBank}\n` +
                    `⏰ *Waktu:* \`${now}\`\n\n` +
                    `⚡️ _Silahkan diproses bosku!_`;
            }

            // TOMBOL SAKTI (Selalu muncul buat semua notif)
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ TERIMA', `confirm_TERIMA_${data.id}`),
                    Markup.button.callback('❌ TOLAK', `confirm_TOLAK_${data.id}`)
                ]
            ]);

            for (const chatId of chatIds) {
                // Kirim Teks + Tombol
                await bot.telegram.sendMessage(chatId, message, { 
                    parse_mode: 'Markdown',
                    ...keyboard
                });

                // Kirim Screenshot (Kalo ada)
                if (data.screenshot) {
                    const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, "");
                    await bot.telegram.sendPhoto(chatId, { source: Buffer.from(base64Data, 'base64') }, { caption: `Screenshot ${type} - ID ${data.id}` });
                }
            }
        } catch (error) {
            console.error('Error sending to Telegram:', error);
        }
    });

    // HANDLE CALLBACK BUTTONS (TERIMA / TOLAK)
    bot.on('callback_query', async (ctx) => {
        try {
            const callbackData = ctx.callbackQuery.data;
            const [stage, action, id] = callbackData.split('_');

            if (stage === 'confirm') {
                const confirmKeyboard = Markup.inlineKeyboard([
                    [
                        Markup.button.callback('⚠️ YA, SAYA YAKIN!', `execute_${action}_${id}`),
                        Markup.button.callback('🔙 KEMBALI', `cancel_${id}`)
                    ]
                ]);

                await ctx.editMessageReplyMarkup(confirmKeyboard.reply_markup).catch(e => console.error('Error edit markup:', e.message));
                await ctx.answerCbQuery(`Konfirmasi ${action} untuk ID ${id}`).catch(e => console.error('Error answer query:', e.message));
            }
            else if (stage === 'execute') {
                io.emit('ACTION_EXECUTE', { action, id });

                // Deteksi tipe dari teks pesan sebelumnya
                const isDeposit = ctx.callbackQuery.message.text.includes('DEPOSIT');
                const typeLabel = isDeposit ? 'DEPOSIT' : 'WITHDRAW';
                const actionLabel = action === 'TERIMA' ? 'DITERIMA' : 'DITOLAK';
                const emoji = action === 'TERIMA' ? '✅' : '❌';

                const statusText = `\n\n*STATUS: ${typeLabel} ${actionLabel} ${emoji}*`;

                await ctx.editMessageText(ctx.callbackQuery.message.text + statusText, { parse_mode: 'Markdown' }).catch(e => console.error('Error edit text:', e.message));
                await ctx.answerCbQuery(`${action} ID ${id} sedang dieksekusi...`).catch(e => console.error('Error answer query:', e.message));
            }
            else if (stage === 'cancel') {
                const originalKeyboard = Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ TERIMA', `confirm_TERIMA_${id}`),
                        Markup.button.callback('❌ TOLAK', `confirm_TOLAK_${id}`)
                    ]
                ]);
                await ctx.editMessageReplyMarkup(originalKeyboard.reply_markup).catch(e => console.error('Error edit markup:', e.message));
                await ctx.answerCbQuery('Aksi dibatalkan.').catch(e => console.error('Error answer query:', e.message));
            }
        } catch (err) {
            console.error('Callback Query Error:', err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// GLOBAL ERROR HANDLER (Anti-Crash)
bot.catch((err, ctx) => {
    console.error(`Telegraf Error for ${ctx.updateType}:`, err.message);
});

app.get('/', (req, res) => {
    res.send('Server is Running 🚀');
});

bot.launch().then(() => {
    console.log('Telegram Bot is active');
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
