const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const os       = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'etofile-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const fileStore  = new Map(); // shareId → { files, expiresAt, expireHours }
const chunkStore = new Map(); // uploadId → { shareId, expireHours, chunks: Map<index,path> }

// ── 静的ファイル ──────────────────────────────────────────────────────────
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public') : __dirname;

app.use(express.static(publicDir, {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

// ── Multer（通常アップロード用） ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.shareId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 50 }
});

// Multer（チャンク用、メモリ or tmp） 
const chunkUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 } // チャンクは最大20MB
});

// ── shareId 付与 ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/upload' && req.method === 'POST') req.shareId = uuidv4();
  next();
});

// ── POST /upload（従来の一括アップロード） ────────────────────────────────
app.post('/upload', (req, res) => {
  upload.array('files')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'ファイルサイズが2GBを超えています' : (err.message || 'Upload failed');
      return res.status(413).json({ error: msg });
    }
    try {
      const shareId     = req.shareId;
      const expireHours = parseInt(req.body.expireHours) || 24;
      const expiresAt   = Date.now() + expireHours * 3600000;
      const files = (req.files || []).map(f => ({
        originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
        size: f.size, path: f.path
      }));
      if (!files.length) return res.status(400).json({ error: 'ファイルが選択されていません' });
      fileStore.set(shareId, { files, expiresAt, expireHours });
      setTimeout(() => deleteShare(shareId), expireHours * 3600000);
      res.json({ shareId, expiresAt, expireHours });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

// ── POST /upload/init（チャンクアップロード開始） ─────────────────────────
app.use(express.json({ limit: '1mb' }));

app.post('/upload/init', (req, res) => {
  const { expireHours = 24, files } = req.body; // files: [{name, size, chunks}]
  if (!files || !files.length) return res.status(400).json({ error: 'No files' });
  const uploadId = uuidv4();
  const shareId  = uuidv4();
  chunkStore.set(uploadId, {
    shareId,
    expireHours: parseInt(expireHours),
    files,          // メタデータ
    received: new Map(), // filename → Set of received chunk indices
    paths: new Map(),    // filename → final path
  });
  res.json({ uploadId, shareId });
});

// ── POST /upload/chunk（チャンク1個を受信） ───────────────────────────────
app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  const { uploadId, filename, index, total } = req.body;
  const session = chunkStore.get(uploadId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const idx = parseInt(index);
  const tot = parseInt(total);
  const decodedName = decodeURIComponent(filename);

  // チャンクを所定の場所に移動
  const dir = path.join(UPLOAD_DIR, session.shareId, '__chunks__', decodedName);
  fs.mkdirSync(dir, { recursive: true });
  const chunkPath = path.join(dir, String(idx).padStart(6, '0'));
  fs.renameSync(req.file.path, chunkPath);

  // 受信済みチャンクを記録
  if (!session.received.has(decodedName)) session.received.set(decodedName, new Set());
  session.received.get(decodedName).add(idx);

  // 全チャンク揃ったら結合
  if (session.received.get(decodedName).size === tot) {
    const finalDir  = path.join(UPLOAD_DIR, session.shareId);
    const finalPath = path.join(finalDir, decodedName);
    fs.mkdirSync(finalDir, { recursive: true });

    const writeStream = fs.createWriteStream(finalPath);
    const combine = (i) => {
      if (i >= tot) {
        writeStream.end();
        // チャンク一時フォルダ削除
        fs.rm(dir, { recursive: true, force: true }, () => {});
        session.paths.set(decodedName, finalPath);
        return;
      }
      const cp = path.join(dir, String(i).padStart(6, '0'));
      const rs = fs.createReadStream(cp);
      rs.pipe(writeStream, { end: false });
      rs.on('end', () => combine(i + 1));
    };
    combine(0);
  }

  res.json({ ok: true });
});

// ── POST /upload/complete（全ファイルのチャンクが揃ったら完了） ───────────
app.post('/upload/complete', (req, res) => {
  const { uploadId } = req.body;
  const session = chunkStore.get(uploadId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // 全ファイルの結合完了を確認
  const allDone = session.files.every(f => session.paths.has(decodeURIComponent(f.name)));
  if (!allDone) return res.status(202).json({ status: 'processing' });

  const expireHours = session.expireHours;
  const expiresAt   = Date.now() + expireHours * 3600000;
  const files = session.files.map(f => {
    const name = decodeURIComponent(f.name);
    return { originalName: name, size: f.size, path: session.paths.get(name) };
  });

  fileStore.set(session.shareId, { files, expiresAt, expireHours });
  setTimeout(() => deleteShare(session.shareId), expireHours * 3600000);
  chunkStore.delete(uploadId);

  res.json({ shareId: session.shareId, expiresAt, expireHours });
});

// ── GET /share/:id/info ───────────────────────────────────────────────────
app.get('/share/:id/info', (req, res) => {
  const share = fileStore.get(req.params.id);
  if (!share) return res.status(404).json({ error: 'Not found or expired' });
  if (Date.now() > share.expiresAt) { deleteShare(req.params.id); return res.status(410).json({ error: 'Expired' }); }
  res.json({
    files: share.files.map(f => ({ name: f.originalName, size: f.size })),
    expiresAt: share.expiresAt, expireHours: share.expireHours
  });
});

// ── GET /share/:id/download/:filename ────────────────────────────────────
app.get('/share/:id/download/:filename', (req, res) => {
  const share = fileStore.get(req.params.id);
  if (!share) return res.status(404).send('Not found');
  if (Date.now() > share.expiresAt) { deleteShare(req.params.id); return res.status(410).send('Expired'); }
  const name = decodeURIComponent(req.params.filename);
  const file = share.files.find(f => f.originalName === name);
  if (!file) return res.status(404).send('File not found');
  // 高速ダウンロード用ヘッダー
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  res.download(file.path, file.originalName);
});

// ── GET /share/:id/download-all ───────────────────────────────────────────
app.get('/share/:id/download-all', (req, res) => {
  const share = fileStore.get(req.params.id);
  if (!share) return res.status(404).send('Not found');
  if (Date.now() > share.expiresAt) { deleteShare(req.params.id); return res.status(410).send('Expired'); }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="etofile-${req.params.id}.zip"`);
  // store:0 で無圧縮ZIP（すでに圧縮済みのファイルが多い場合に高速）
  const archive = archiver('zip', { store: true });
  archive.pipe(res);
  share.files.forEach(f => archive.file(f.path, { name: f.originalName }));
  archive.finalize();
});

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('/share/:id', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ── Cleanup ───────────────────────────────────────────────────────────────
function deleteShare(shareId) {
  if (!fileStore.has(shareId)) return;
  fs.rm(path.join(UPLOAD_DIR, shareId), { recursive: true, force: true }, () => {});
  fileStore.delete(shareId);
  console.log(`[cleanup] ${shareId}`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ETOFILE running at http://localhost:${PORT}\n`);
});
