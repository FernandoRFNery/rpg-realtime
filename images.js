
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import express from 'express';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'images');
const THUMBS_ROOT = path.join(UPLOAD_DIR, '_thumbs');
fs.mkdirSync(THUMBS_ROOT, { recursive: true });

const appRouter = express.Router();
// static files (albums under /media/<album>/<file>)
appRouter.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: true }));
appRouter.use('/media/thumbs', express.static(THUMBS_ROOT, { maxAge: '7d', fallthrough: true }));

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp|gif|avif)/i.test(file.mimetype);
    cb(ok ? null : new Error('Tipo de imagem não suportado'), ok);
  }
});

function slugify(name) {
  return String(name||'').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function albumDir(album='default'){
  const a = slugify(album) || 'default';
  const dir = path.join(UPLOAD_DIR, a);
  const thumbs = path.join(THUMBS_ROOT, a);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(thumbs, { recursive: true });
  return { a, dir, thumbs, meta: path.join(dir, '_meta.json') };
}

async function readMeta(album){
  const { meta } = albumDir(album);
  try{
    const raw = await fs.promises.readFile(meta, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  }catch(_){ return []; }
}

async function writeMeta(album, list){
  const { meta } = albumDir(album);
  await fs.promises.writeFile(meta, JSON.stringify(list, null, 2), 'utf-8');
}

async function listAlbums(){
  const all = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true }).catch(()=>[]);
  const dirs = all.filter(d => d.isDirectory() && d.name !== '_thumbs').map(d => d.name);
  const out = [];
  for (const a of dirs){
    const files = (await fs.promises.readdir(path.join(UPLOAD_DIR, a))).filter(f => /\.(png|jpe?g|webp|gif|avif)$/i.test(f));
    out.push({ name: a, count: files.length });
  }
  if (!out.find(x => x.name === 'default')) out.push({ name: 'default', count: 0 });
  out.sort((x,y)=> x.name.localeCompare(y.name));
  return out;
}

export default function registerImageRoutes(app){
  app.use(appRouter);

  app.get('/api/health/images', (_req,res)=>res.json({ok:true}));

  // List albums
  app.get('/api/albums', async (_req, res) => {
    try { res.json(await listAlbums()); }
    catch(e){ console.error(e); res.status(500).json({ error: 'albums_failed' }); }
  });

  // Create album
  app.post('/api/albums', express.json(), async (req, res) => {
    try{
      const name = slugify(req.body?.name || '');
      if(!name) return res.status(400).json({ error: 'invalid_name' });
      albumDir(name); // ensure created
      res.json({ ok:true, name });
    }catch(e){ console.error(e); res.status(500).json({ error: 'create_failed' }); }
  });

  // List images in album
  app.get('/api/images', async (req, res) => {
    try{
      const album = req.query.album || 'default';
      const { a, dir } = albumDir(album);
      const meta = await readMeta(a);
      const files = (await fs.promises.readdir(dir)).filter(f => /\.(png|jpe?g|webp|gif|avif)$/i.test(f));
      const map = new Map(meta.map(it => [it.name, it]));
      const list = files.map(f => {
        const m = map.get(f) || { name: f, caption: '', order: 0 };
        return {
          name: f,
          caption: m.caption || '',
          order: m.order ?? 0,
          url: `/media/${a}/${f}`,
          thumb: `/media/thumbs/${a}/${f}.webp`
        };
      });
      list.sort((x,y)=> (x.order??0)-(y.order??0) || x.name.localeCompare(y.name));
      res.json({ album: a, items: list });
    }catch(e){ console.error(e); res.status(500).json({ error: 'list_failed' }); }
  });

  // Upload images + downscale into album
  app.post('/api/upload-images', upload.array('images', 20), async (req, res) => {
    try{
      const album = req.body?.album || 'default';
      const { a, dir, thumbs } = albumDir(album);
      if (!req.files?.length) return res.status(400).json({ error: 'no_files' });
      const meta = await readMeta(a);
      const nowBase = Date.now();

      const saved = [];
      let i = 0;
      for (const file of req.files){
        const base = slugify(path.parse(file.originalname).name) || 'img';
        const name = `${nowBase + (i++)}-${base}.webp`;
        const filePath = path.join(dir, name);
        const thumbPath = path.join(thumbs, `${name}.webp`);

        const img = sharp(file.buffer, { failOn: 'none' }).rotate();
        const m = await img.metadata();
        const W = m.width || 0, H = m.height || 0;
        const MAX = 1920;
        const resized = (W > MAX || H > MAX)
            ? img.resize({ width: W > H ? MAX : undefined, height: H >= W ? MAX : undefined, fit: 'inside', withoutEnlargement: true })
            : img;
        await resized.webp({ quality: 82, effort: 4 }).toFile(filePath);
        await sharp(file.buffer).rotate().resize({ width: 480, fit: 'inside' }).webp({ quality: 75, effort: 4 }).toFile(thumbPath);

        const rec = { name, caption: (req.body?.caption || ''), order: meta.length };
        meta.push(rec);
        saved.push({ name, url: `/media/${a}/${name}`, thumb: `/media/thumbs/${a}/${name}.webp`, caption: rec.caption });
      }
      await writeMeta(a, meta);
      res.json({ ok:true, album: a, saved });
    }catch(e){ console.error(e); res.status(500).json({ error: 'upload_failed' }); }
  });

  // Update caption
  app.patch('/api/images/:album/:name', express.json(), async (req, res) => {
    try{
      const a = req.params.album, name = req.params.name;
      const meta = await readMeta(a);
      const idx = meta.findIndex(x => x.name === name);
      if (idx === -1) meta.push({ name, caption: req.body?.caption || '', order: meta.length });
      else meta[idx].caption = req.body?.caption || '';
      await writeMeta(a, meta);
      res.json({ ok:true });
    }catch(e){ console.error(e); res.status(500).json({ error: 'caption_failed' }); }
  });

  // Reorder album
  app.put('/api/albums/:album/order', express.json(), async (req, res) => {
    try{
      const a = req.params.album;
      const order = Array.isArray(req.body?.order) ? req.body.order : null;
      if(!order) return res.status(400).json({ error: 'invalid_order' });
      const meta = await readMeta(a);
      const pos = new Map(order.map((name, i) => [name, i]));
      for (const item of meta){
        item.order = pos.has(item.name) ? pos.get(item.name) : (item.order ?? 0);
      }
      // ensure items present in order but not in meta
      order.forEach((name, i)=>{
        if(!meta.find(x=>x.name===name)) meta.push({ name, caption:'', order:i });
      });
      await writeMeta(a, meta);
      res.json({ ok:true });
    }catch(e){ console.error(e); res.status(500).json({ error: 'reorder_failed' }); }
  });

  // Delete image
  app.delete('/api/images/:album/:name', async (req, res) => {
    try{
      const a = req.params.album, name = req.params.name;
      const { dir, thumbs } = albumDir(a);
      await fs.promises.unlink(path.join(dir, name)).catch(()=>{});
      await fs.promises.unlink(path.join(thumbs, `${name}.webp`)).catch(()=>{});
      const meta = await readMeta(a);
      const next = meta.filter(x => x.name !== name).map((x,i)=>({ ...x, order: i }));
      await writeMeta(a, next);
      res.json({ ok:true });
    }catch(e){ console.error(e); res.status(500).json({ error: 'delete_failed' }); }
  });
}
