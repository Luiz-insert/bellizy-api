require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http'); // Import HTTP
const { Server } = require("socket.io"); // Import Socket.io

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP Server & Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all for dev
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// In-memory store (for MVP)
const MESSAGES = []; // Start empty

// ...

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'wpp-integration',
        timestamp: new Date().toISOString()
    });
});

// Get Messages
app.get('/api/messages', (req, res) => {
    res.json(MESSAGES);
});

// Clear Messages
app.delete('/api/messages', (req, res) => {
    MESSAGES.length = 0; // Clear in-place
    io.emit('messages_cleared'); // Notify clients
    console.log('🧹 Messages Cleared via API');
    res.sendStatus(200);
});

// Webhook Verification (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === (process.env.WEBHOOK_VERIFY_TOKEN || 'bellizy_token')) {
        console.log('Webhook Verified!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Receive Messages (POST)
app.post('/webhook', (req, res) => {
    try {
        const body = req.body;

        console.log('--- Incoming Webhook Request (v2) ---');
        console.log('Raw Payload:', JSON.stringify(body, null, 2));

        if (body.object) {
            if (body.entry &&
                body.entry[0].changes &&
                body.entry[0].changes[0] &&
                body.entry[0].changes[0].value.messages &&
                body.entry[0].changes[0].value.messages[0]
            ) {
                const changes = body.entry[0].changes[0].value;
                const msg = changes.messages[0];

                // Try to get sender name from contacts
                let senderName = msg.from;
                if (changes.contacts && changes.contacts[0] && changes.contacts[0].profile) {
                    senderName = changes.contacts[0].profile.name;
                }

                // Store received message
                if (msg.type === 'text') {
                    const newMessage = {
                        id: msg.id,
                        from: msg.from,
                        senderName: senderName,
                        text: msg.text.body,
                        timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
                        type: 'received'
                    };

                    MESSAGES.push(newMessage);

                    // EMIT TO FRONTEND
                    io.emit('new_message', newMessage);
                    console.log('✅ RECEIVED MESSAGE:', JSON.stringify(newMessage, null, 2));
                }
            }
            res.sendStatus(200);
        } else {
            console.log('❌ Webhook: Unknown Event Type or Missing Object');
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('🔥 CRITICAL WEBHOOK ERROR:', error);
        res.sendStatus(500);
    }
});

// Send Message Endpoint
app.post('/api/send-message', async (req, res) => {
    const { to, text, templateName } = req.body;
    console.log(`📤 SENDING MESSAGE to ${to}:`, text || `Template: ${templateName}`);

    // Credentials (Dynamic from Frontend or fallback to Env)
    const token = req.body.token || process.env.META_ACCESS_TOKEN;
    const phoneId = process.env.META_PHONE_ID;

    // Local Echo (Store sent message)
    if (to && (text || templateName)) {
        const newMessage = {
            id: 'sent_' + Date.now(),
            from: 'me',
            senderName: 'Me',
            to: to,
            text: text || `Template: ${templateName}`,
            timestamp: new Date().toISOString(),
            type: 'sent'
        };
        MESSAGES.push(newMessage);

        // EMIT TO FRONTEND
        io.emit('new_message', newMessage);
    }

    if (!token || !phoneId) {
        // Return success for mock frontend even if no creds (so UI updates)
        return res.json({ success: true, mocked: true });
    }

    try {
        const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

        let payload;
        if (text) {
            payload = {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text }
            };
        } else {
            payload = {
                messaging_product: 'whatsapp',
                to: to,
                type: 'template',
                template: {
                    name: templateName || 'hello_world',
                    language: { code: 'en_US' }
                }
            };
        }

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        res.json({ success: true, data: response.data });

    } catch (error) {
        console.error('Meta API Error:', error.response?.data || error.message);
        // Return soft error or partial success so frontend doesn't break
        res.json({ success: false, error: error.response?.data || error.message });
    }
});

// Start Server
server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Microservice (Socket.io) running on http://localhost:${PORT}`);
})

