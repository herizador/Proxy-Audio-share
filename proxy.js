// proxy.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false, // Desactivar compresión para menor latencia
    maxPayload: 8192 // 8KB máximo por mensaje
});

// Configuración optimizada para audio en tiempo real
const CLEANUP_INTERVAL = 30000; // 30 segundos
const INACTIVE_TIMEOUT = 60000;  // 60 segundos
const MAX_PACKET_SIZE = 2048;    // 2KB por paquete (optimizado)
const MAX_BUFFER_SIZE = 16384;   // 16KB máximo en buffer

// Almacenamiento de salas y conexiones
const rooms = new Map();

class Room {
    constructor() {
        this.host = null;
        this.guests = new Set();
        this.lastActivity = Date.now();
        this.audioBuffer = [];
        this.bufferSize = 0;
        this.lastPacketTime = 0;
        this.packetsReceived = 0;
    }

    addAudioData(data) {
        const now = Date.now();
        
        // Control de tasa de paquetes
        if (this.lastPacketTime > 0) {
            const timeDiff = now - this.lastPacketTime;
            if (timeDiff < 10) { // Si llegan paquetes muy juntos
                return; // Ignorar paquetes muy frecuentes
            }
        }
        this.lastPacketTime = now;
        
        // Control de buffer más eficiente
        this.audioBuffer.push(data);
        this.bufferSize += data.length;
        
        // Mantener el buffer en un tamaño óptimo
        while (this.bufferSize > MAX_BUFFER_SIZE) {
            const oldData = this.audioBuffer.shift();
            this.bufferSize -= oldData.length;
        }
        
        this.packetsReceived++;
    }

    broadcast(data, sender) {
        const targets = sender === this.host ? this.guests : new Set([this.host]);
        targets.forEach(client => {
            if (client && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data, { binary: data instanceof Buffer });
                } catch (error) {
                    console.error('Error al enviar datos:', error);
                    this.removeClient(client);
                }
            }
        });
    }
    
    removeClient(client) {
        if (client === this.host) {
            this.host = null;
            this.broadcast('host_disconnected', null);
        } else {
            this.guests.delete(client);
        }
        
        try {
            client.close();
        } catch (e) {
            console.error('Error al cerrar cliente:', e);
        }
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
    
    // Configurar WebSocket para baja latencia
    ws._socket.setNoDelay(true);
    
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
            if (ws === room.host && data.length <= MAX_PACKET_SIZE) {
                room.addAudioData(data);
                room.broadcast(data, ws);
            }
        } else {
            try {
                const message = data.toString();
                room.broadcast(message, ws);
            } catch (error) {
                console.error('Error al procesar mensaje:', error);
            }
        }
    });

    ws.on('close', () => {
        if (room) {
            room.removeClient(ws);
            if (!room.host && room.guests.size === 0) {
                rooms.delete(roomId);
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`Error en WebSocket (${role}):`, error);
        if (room) {
            room.removeClient(ws);
        }
    });
});

app.get('/', (req, res) => {
    res.send('Proxy WSS/WS para AudioShare funcionando.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor proxy de audio iniciado en puerto ${PORT}`);
});