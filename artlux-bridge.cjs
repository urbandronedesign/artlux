const WebSocket = require('ws');
const dgram = require('dgram');

const WS_PORT = 8080;
const wss = new WebSocket.Server({ port: WS_PORT });
const udpSocket = dgram.createSocket('udp4');

// Enable broadcast to allow local discovery if needed
udpSocket.bind(() => {
    udpSocket.setBroadcast(true);
});

console.log('ARTLUX Bridge running on ws://localhost:' + WS_PORT);
console.log('Waiting for browser connection...');

wss.on('connection', ws => {
    console.log('Browser connected!');
    
    ws.on('message', message => {
        try {
            const payload = JSON.parse(message);
            if (payload.type === 'broadcast-artnet' && payload.data && payload.host && payload.port) {
                const buffer = Buffer.from(payload.data);
                
                udpSocket.send(buffer, payload.port, payload.host, (err) => {
                    if (err) {
                        console.error('UDP Send Error:', err);
                    } else {
                        // Verbose logging for verification
                        process.stdout.write(`\rSent ${buffer.length} bytes to ${payload.host}:${payload.port} (Seq: ${payload.data[12]})`);
                    }
                });
            }
        } catch (e) {
            console.error('Invalid Message:', e.message);
        }
    });

    ws.on('close', () => console.log('\nBrowser disconnected'));
});

udpSocket.on('error', (err) => {
    console.error(`\nUDP Error: ${err.stack}`);
    udpSocket.close();
});