import { resolve } from 'node:path';
import { MatchStore } from './store.js';
import { createApp } from './app.js';

const root = resolve(process.env.NONAME_PARSER_DATA_DIR || './data');
const token = process.env.NONAME_PARSER_TOKEN || '';
const port = Number(process.env.NONAME_PARSER_PORT || 3210);
const host = process.env.NONAME_PARSER_HOST || '127.0.0.1';
const app = createApp({ store: new MatchStore(root), token, uploadDir: resolve(root, '.uploads'), publicUrl: process.env.NONAME_PARSER_PUBLIC_URL, matchUrl: process.env.NONAME_PARSER_MATCH_URL });
const server = app.listen(port, host, () => console.log(`No Name Parser listening on ${host}:${port}`));
server.requestTimeout = 120000;
server.headersTimeout = 15000;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
});
