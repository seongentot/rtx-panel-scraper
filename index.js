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

io.on('connection', (socket) => {
    console.log('A client connected:', socket.id);

    socket.on('notification', async (data) => {
        console.log('Received notification from extension:', data.text);

        try {
            const chatIds = process.env.CHAT_IDS.split(',');

            for (const chatId of chatIds) {
                // Send text
                await bot.telegram.sendMessage(chatId, `🔔 *NOTIFIKASI BARU*\n\n${data.text}`, { parse_mode: 'Markdown' });

                // Send screenshot if available
                if (data.screenshot) {
                    const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, "");
                    await bot.telegram.sendPhoto(chatId, { source: Buffer.from(base64Data, 'base64') }, { caption: 'Screenshot Transaksi' });
                }
            }
        } catch (error) {
            console.error('Error sending to Telegram:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
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
