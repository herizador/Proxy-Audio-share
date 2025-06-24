// proxy.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let hostSocket = null;
let guestSocket = null;

wss.on('connection', (ws, req) => {
    // Identificación simple por query param: ?role=host o ?role=guest
    const url = req.url || '';
    if (url.includes('role=host')) {
        if (hostSocket) hostSocket.close();
        hostSocket = ws;
        ws.send('Conectado como HOST');
        console.log('Host conectado');
        ws.on('close', () => {
            hostSocket = null;
            console.log('Host desconectado');
        });
        ws.on('message', (data) => {
            // Reenviar audio al invitado si está conectado
            if (guestSocket && guestSocket.readyState === WebSocket.OPEN) {
                guestSocket.send(data);
            }
        });
    } else if (url.includes('role=guest')) {
        if (guestSocket) guestSocket.close();
        guestSocket = ws;
        ws.send('Conectado como INVITADO');
        console.log('Invitado conectado');
        ws.on('close', () => {
            guestSocket = null;
            console.log('Invitado desconectado');
        });
    } else {
        ws.close();
    }
});

app.get('/', (req, res) => {
    res.send('Proxy WSS/WS para AudioShare funcionando.');
});

const PORT = process.env.PORT || 8889;
server.listen(PORT, () => {
    console.log(`Proxy escuchando en puerto ${PORT}`);
});