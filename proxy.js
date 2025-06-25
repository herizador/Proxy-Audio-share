// proxy.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuración optimizada para audio en tiempo real
const CLEANUP_INTERVAL = 30000; // 30 segundos
const INACTIVE_TIMEOUT = 60000;  // 60 segundos
const MAX_PACKET_SIZE = 4096;    // 4KB por paquete

// Almacenamiento de salas y conexiones
const rooms = new Map();

class Room {
    constructor() {
        this.host = null;
        this.guests = new Set();
        this.lastActivity = Date.now();
        this.audioBuffer = [];
        this.bufferSize = 0;
    }

    addAudioData(data) {
        // Nuevo: Control de buffer más eficiente
        this.audioBuffer.push(data);
        this.bufferSize += data.length;
        
        // Si el buffer es muy grande, eliminamos paquetes antiguos
        while (this.bufferSize > MAX_PACKET_SIZE * 10) {
            const oldData = this.audioBuffer.shift();
            this.bufferSize -= oldData.length;
        }
    }

    broadcast(data, sender) {
        const targets = sender === this.host ? this.guests : new Set([this.host]);
        targets.forEach(client => {
            if (client && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (error) {
                    console.error('Error al enviar datos:', error);
                }
            }
        });
    }
}

// Limpieza periódica de salas inactivas
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.lastActivity > INACTIVE_TIMEOUT) {
            console.log(`Limpiando sala inactiva: ${roomId}`);
            if (room.host) room.host.close();
            room.guests.forEach(guest => guest.close());
            rooms.delete(roomId);
        }
    }
}, CLEANUP_INTERVAL);

wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.slice(1));
    const roomId = params.get('room');
    const role = params.get('role');

    if (!roomId || !role) {
        ws.close(4000, 'Parámetros faltantes');
        return;
    }

    let room = rooms.get(roomId);
    
    if (role === 'host') {
        if (!room) {
            room = new Room();
            rooms.set(roomId, room);
        } else if (room.host) {
            ws.close(4001, 'Ya existe un host en esta sala');
            return;
        }
        room.host = ws;
        ws.send('Conectado como HOST');
    } else if (role === 'guest') {
        if (!room || !room.host) {
            ws.close(4002, 'no_host');
            return;
        }
        room.guests.add(ws);
        ws.send('Conectado como INVITADO');
    }

    ws.on('message', (data) => {
        if (!room) return;
        room.lastActivity = Date.now();
        
        if (data instanceof Buffer) {
            if (ws === room.host) {
                room.addAudioData(data);
                room.broadcast(data, ws);
            }
        } else {
            // Manejo de mensajes de control
            try {
                const message = data.toString();
                room.broadcast(message, ws);
            } catch (error) {
                console.error('Error al procesar mensaje:', error);
            }
        }
    });

    ws.on('close', () => {
        if (!room) return;
        
        if (ws === room.host) {
            console.log(`Host desconectado de la sala: ${roomId}`);
            room.guests.forEach(guest => {
                if (guest.readyState === WebSocket.OPEN) {
                    guest.send('host_disconnected');
                    guest.close();
                }
            });
            rooms.delete(roomId);
        } else {
            room.guests.delete(ws);
            if (room.guests.size === 0 && !room.host) {
                rooms.delete(roomId);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('Error en WebSocket:', error);
        ws.close();
    });
});

app.get('/', (req, res) => {
    res.send('Proxy WSS/WS para AudioShare funcionando.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor proxy de audio iniciado en puerto ${PORT}`);
});