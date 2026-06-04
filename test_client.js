const net = require('net');

const socket = net.createConnection({ host: '127.0.0.1', port: 5001 }, () => {
  console.log('🔌 Client: Connected to server!');
  const testData = Buffer.alloc(3840, 0);  // Simulate PCM chunk (silence for test)
  testData.writeInt16LE(1000, 0);  // Add a non-zero sample for "volume"
  socket.write(testData, () => console.log(`📤 Client: Sent ${testData.length} bytes`));
  setTimeout(() => socket.end(), 1000);  // Send one chunk, close after 1s
});

socket.on('error', (err) => console.error('❌ Client error:', err.message));
socket.on('close', () => console.log('🔚 Client: Connection closed'));