// proxy.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false, // Desactivar compresión para menor latencia
    maxPayload: 32768 // Aumentado a 32KB para manejar buffers más grandes
});

// Configuración optimizada para audio en tiempo real
const CLEANUP_INTERVAL = 30000; // 30 segundos
const INACTIVE_TIMEOUT = 60000;  // 60 segundos
const MAX_PACKET_SIZE = 8192;    // Aumentado a 8KB por paquete
const MAX_BUFFER_SIZE = 65536;   // Aumentado a 64KB para mejor calidad

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
        this.sampleRate = 16000; // Sample rate de Android
        this.frameSize = 2048;   // Tamaño de frame típico de Android
    }

    addAudioData(data) {
        const now = Date.now();
        
        // Control de buffer más permisivo
        if (this.lastPacketTime > 0) {
            const timeDiff = now - this.lastPacketTime;
            if (timeDiff < 5) { // Reducido a 5ms para mayor frecuencia
                // En lugar de descartar, intentamos procesar
                this.processAudioPacket(data);
            }
        }
        this.lastPacketTime = now;
        
        this.processAudioPacket(data);
    }

    processAudioPacket(data) {
        // Asegurarse de que el dato es un Buffer
        const audioData = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        // Verificar si el buffer está alineado con el tamaño de frame
        if (audioData.length % 2 === 0) { // Asegurar que tenemos muestras completas (16-bit)
            this.audioBuffer.push(audioData);
            this.bufferSize += audioData.length;
            
            // Mantener el buffer en un tamaño óptimo
            while (this.bufferSize > MAX_BUFFER_SIZE) {
                const oldData = this.audioBuffer.shift();
                if (oldData) {
                    this.bufferSize -= oldData.length;
                }
            }
            
            this.packetsReceived++;
        }
    }

    broadcast(data, sender) {
        const targets = sender === this.host ? this.guests : new Set([this.host]);
        
        // Si es datos de audio, asegurarse de que sea un Buffer
        const audioData = data instanceof Buffer ? data : 
                         (typeof data === 'string' ? Buffer.from(data) : data);
        
        targets.forEach(client => {
            if (client && client.readyState === WebSocket.OPEN) {
                try {
                    // Enviar como binary si es Buffer
                    const options = { 
                        binary: audioData instanceof Buffer,
                        compress: false // Desactivar compresión para menor latencia
                    };
                    client.send(audioData, options);
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
            // Limpiar buffer al desconectar el host
            this.audioBuffer = [];
            this.bufferSize = 0;
        } else {
            this.guests.delete(client);
        }
        
        try {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
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
    
    // Configurar socket para audio en tiempo real
    ws._socket.setNoDelay(true);
    ws._socket.setKeepAlive(true, 1000);
    
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
                // Procesar datos de audio sin límite de tamaño estricto
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

// Manejar favicon.ico
app.get('/favicon.ico', (req, res) => {
    res.set('Content-Type', 'image/x-icon');
    // Enviar un favicon vacío para evitar el error 404
    res.status(200).send('');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor proxy de audio iniciado en puerto ${PORT}`);
});
