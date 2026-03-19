const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { saveImage, sanitizeFolder } = require('../services/fileStorage');

const router = express.Router();

const fileFilter = (req, file, cb) => {
  if (!file.mimetype || !file.mimetype.startsWith('image/')) {
    return cb(new Error('Povolené sú iba obrázky'));
  }
  cb(null, true);
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

router.post('/image', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Súbor nebol odoslaný' });
    }

    const folder = sanitizeFolder(req.body.folder || 'misc');
    const saved = await saveImage({
      buffer: req.file.buffer,
      folder,
      originalName: req.file.originalname
    });

    const forwardedProtoRaw = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHostRaw = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
    const protocol = forwardedProtoRaw || req.protocol || 'https';
    const host = forwardedHostRaw || req.get('host');

    const fileUrl = saved.fileUrl || `${protocol}://${host}${saved.relativePath}`;

    return res.status(201).json({
      message: 'Súbor bol úspešne nahraný',
      fileName: saved.fileName,
      fileUrl,
      relativePath: saved.relativePath,
      storage: saved.storage
    });
  } catch (error) {
    if (error.code === 'STORAGE_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'Upload storage is not configured for production',
        code: 'STORAGE_NOT_CONFIGURED'
      });
    }

    console.error('Upload failed:', error.message);
    return res.status(500).json({
      error: 'Nepodarilo sa nahrať súbor'
    });
  }
});

module.exports = router;
