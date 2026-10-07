const path = require('node:path');
module.exports = {
  apps: [{
    name: 'noname-parser',
    cwd: path.resolve(__dirname, '..'),
    script: 'dist/src/server.js',
    node_args: '--env-file=.env',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    kill_timeout: 16000,
    env: { NODE_ENV: 'production' },
  }],
};
