import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { unlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { MatchStore, hashLogs, validMatchId } from './store.js';
import { parseLogs, PARSER_VERSION } from './parse.js';

export interface AppOptions { store: MatchStore; token: string; uploadDir: string; publicUrl?: string; matchUrl?: string }
export function createApp(options: AppOptions) {
  if (!options.token) throw new Error('Set NONAME_PARSER_TOKEN to protect log uploads.');
  const uploadDir = resolve(options.uploadDir);
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const app = express();
  app.disable('x-powered-by');
  app.set('json escape', true);
  let active = 0;
  const activeIds = new Set<string>();
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, `${randomUUID()}.log`) }),
    limits: { files: 2, fileSize: 8 * 1024 * 1024, fields: 8, fieldSize: 256, parts: 10 },
    fileFilter: (_req, file, cb) => /\.log$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Only plain .log files are accepted.')),
  }).array('logs[]', 2);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
    next();
  });
  app.get('/health', async (_req, res) => {
    try { await options.store.list(1); res.json({ ok: true, parserVersion: PARSER_VERSION }); }
    catch { res.status(503).json({ ok: false, error: 'storage_unavailable' }); }
  });
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const provided = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ failure: { error_reason: 'UNAUTHORIZED', message: 'A valid parser token is required.' } }); return;
    }
    next();
  };
  app.get('/api/matches', authenticate, async (req, res) => res.json({ matches: await options.store.list(Number(req.query.limit) || 50) }));
  app.get('/api/matches/:id', authenticate, async (req, res) => {
    if (!validMatchId(req.params.id)) { res.status(400).json({ error: 'invalid_match_id' }); return; }
    const result = await options.store.get(req.params.id);
    if (!result) { res.status(404).json({ error: 'match_not_found' }); return; }
    res.set('Cache-Control', 'no-cache').json(result);
  });
  const admit = (_req: Request, res: Response, next: NextFunction) => {
    if (active >= 2) { res.status(503).json({ failure: { error_reason: 'BUSY', message: 'Parser busy. Retry this upload shortly.' } }); return; }
    active++;
    res.once('close', () => active--);
    next();
  };
  app.post(['/api/parseGame', '/api/parseLog'], authenticate, admit, (req, res, next) => upload(req, res, next), async (req, res) => {
    const files = (req.files as Express.Multer.File[] || []).map(file => file.path);
    let lockedId: string | undefined;
    try {
      if (files.length < 1) { res.status(400).json({ failure: { message: 'Upload one or two round logs using logs[].' } }); return; }
      const sourceHash = await hashLogs(files);
      const matchId = req.body.matchId || `NN-${sourceHash.slice(0, 16)}`;
      if (!validMatchId(matchId)) { res.status(400).json({ failure: { message: 'Match IDs may contain 1–80 letters, numbers, underscores or hyphens.' } }); return; }
      if (activeIds.has(matchId)) { res.status(409).json({ failure: { message: 'This match is already being parsed.' } }); return; }
      activeIds.add(matchId); lockedId = matchId;
      if (files.length === 2) {
        const hashes = await Promise.all(files.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
        if (hashes[0] === hashes[1]) { res.status(422).json({ failure: { message: 'The two logs are identical. Submit a single log for a one-round match.' } }); return; }
      }
      const existing = await options.store.get(matchId);
      const base = (options.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const matchUrl = options.matchUrl || 'https://nonamepickup.servehalflife.com/match.html?id={matchId}';
      const success = { path: matchUrl.replace('{matchId}', encodeURIComponent(matchId)), api: `${base}/api/matches/${matchId}` };
      if (existing?.sourceHash === sourceHash && existing.parserVersion === PARSER_VERSION) { res.json({ success, result: existing }); return; }
      if (existing && req.body.replace !== 'on') { res.status(409).json({ failure: { error_reason: 'MATCH_EXISTS', message: 'Different logs already exist for this match ID. Use replace=on only to intentionally replace them.' } }); return; }
      let result;
      try { result = await parseLogs(files, { matchId, sourceHash, force: req.body.force === 'on' }); }
      catch { res.status(422).json({ failure: { error_reason: 'PARSING_FAILURE', message: 'These logs could not be parsed as a match. Check the map, round order and log completeness.' } }); return; }
      await options.store.save(result, files);
      res.status(existing ? 200 : 201).json({ success, result });
    } finally {
      if (lockedId) activeIds.delete(lockedId);
      await Promise.all(files.map(file => unlink(file).catch(() => {})));
    }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (Array.isArray(files)) void Promise.all(files.map(file => unlink(file.path).catch(() => {})));
    const isUploadError = error instanceof multer.MulterError || error.message === 'Only plain .log files are accepted.';
    res.status(isUploadError ? 400 : 500).json({ failure: {
      error_reason: isUploadError ? 'INVALID_UPLOAD' : 'INTERNAL_ERROR',
      message: isUploadError ? 'Upload one or two plain .log files, up to 8 MB each.' : 'The parser could not save or read this match. Please retry.',
    } });
  });
  return app;
}
