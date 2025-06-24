// proxy.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let rooms = {};

wss.on('connection', (ws, req) => {
    // Extraer parámetros de la URL
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    const room = url.searchParams.get('room');
    if (!role || !room) {
        ws.close();
        return;
    }
    if (!rooms[room]) {
        rooms[room] = { host: null, guest: null };
    }
    if (role === 'host') {
        if (rooms[room].host) rooms[room].host.close();
        rooms[room].host = ws;
        ws.send('Conectado como HOST en sala ' + room);
        console.log('Host conectado en sala', room);
        ws.on('close', () => {
            rooms[room].host = null;
            console.log('Host desconectado en sala', room);
        });
        ws.on('message', (data) => {
            if (rooms[room].guest && rooms[room].guest.readyState === WebSocket.OPEN) {
                rooms[room].guest.send(data);
            }
        });
    } else if (role === 'guest') {
        if (rooms[room].guest) rooms[room].guest.close();
        rooms[room].guest = ws;
        ws.send('Conectado como INVITADO en sala ' + room);
        console.log('Invitado conectado en sala', room);
        ws.on('close', () => {
            rooms[room].guest = null;
            console.log('Invitado desconectado en sala', room);
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
