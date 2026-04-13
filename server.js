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

const fileStore = new Map();

// ── 静的ファイル ──────────────────────────────────────────────────────────
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir, { maxAge: '1h', etag: true }));

// ── Multer ────────────────────────────────────────────────────────────────
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

// ── shareId付与 ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/upload' && req.method === 'POST') req.shareId = uuidv4();
  next();
});

// ── POST /upload ──────────────────────────────────────────────────────────
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
  const archive = archiver('zip', { store: true }); // 無圧縮で高速化
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
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ETOFILE running at http://localhost:${PORT}\n`);
});
