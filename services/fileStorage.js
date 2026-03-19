const fs = require('fs');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');

const uploadsRoot = path.join(__dirname, '..', 'uploads');

let cloudinaryConfigured = false;

const normalizeEnvValue = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const startsWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"');
  const startsWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'");

  if (startsWithDouble || startsWithSingle) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
};

const sanitizeFolder = (folder) => {
  const value = String(folder || 'misc').toLowerCase();
  const safe = value.replace(/[^a-z0-9_-]/g, '');
  return safe || 'misc';
};

const cloudinaryConfig = {
  cloud_name: normalizeEnvValue(process.env.CLOUDINARY_CLOUD_NAME),
  api_key: normalizeEnvValue(process.env.CLOUDINARY_API_KEY),
  api_secret: normalizeEnvValue(process.env.CLOUDINARY_API_SECRET),
  secure: true
};

const isCloudinaryConfigured = () => {
  return Boolean(
    cloudinaryConfig.cloud_name &&
      cloudinaryConfig.api_key &&
      cloudinaryConfig.api_secret
  );
};

if (isCloudinaryConfigured()) {
  cloudinary.config(cloudinaryConfig);
  cloudinaryConfigured = true;
}

const getStorageMode = () => {
  if (cloudinaryConfigured) return 'cloudinary';
  return process.env.NODE_ENV === 'production' ? 'none' : 'local';
};

const uploadToCloudinary = ({ buffer, folder, originalName }) => {
  const baseFolder = normalizeEnvValue(process.env.CLOUDINARY_FOLDER) || 'sports-club';
  const targetFolder = `${baseFolder}/${folder}`;
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  const publicId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: targetFolder,
        public_id: publicId,
        resource_type: 'image',
        format: ext || undefined,
        overwrite: false
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        return resolve({
          fileName: `${publicId}${ext ? `.${ext}` : ''}`,
          fileUrl: result.secure_url,
          relativePath: result.secure_url,
          storage: 'cloudinary'
        });
      }
    );

    stream.end(buffer);
  });
};

const saveToLocalDisk = async ({ buffer, folder, originalName }) => {
  const targetFolder = path.join(uploadsRoot, folder);
  await fs.promises.mkdir(targetFolder, { recursive: true });

  const ext = path.extname(originalName || '').toLowerCase();
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const fullPath = path.join(targetFolder, fileName);

  await fs.promises.writeFile(fullPath, buffer);

  return {
    fileName,
    fileUrl: null,
    relativePath: `/api/uploads/${folder}/${fileName}`,
    storage: 'local'
  };
};

const saveImage = async ({ buffer, folder, originalName }) => {
  const safeFolder = sanitizeFolder(folder);

  if (cloudinaryConfigured) {
    return uploadToCloudinary({ buffer, folder: safeFolder, originalName });
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Durable file storage is not configured for production');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }

  return saveToLocalDisk({ buffer, folder: safeFolder, originalName });
};

module.exports = {
  getStorageMode,
  isCloudinaryConfigured,
  saveImage,
  sanitizeFolder
};
