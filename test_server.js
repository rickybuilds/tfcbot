const net = require('net');

const server = net.createServer((socket) => {
  console.log(`🔌 Server: Connection received from ${socket.remoteAddress}:${socket.remotePort}!`);
  socket.on('data', (chunk) => {
    console.log(`📥 Server: Data received: ${chunk.length} bytes (first 10: ${chunk.slice(0,10).toString('hex')})`);
  });
  socket.on('end', () => console.log('🔚 Server: Connection ended'));
  socket.on('error', (err) => console.error('❌ Server socket error:', err.message));
});

server.on('error', (err) => console.error('❌ Server bind error:', err.message));
server.listen(5001, '127.0.0.1', () => {
  console.log('🧠 Server listening on 127.0.0.1:5001');
  const addr = server.address();
  console.log('Bound to:', addr.address, addr.port, addr.family);
});