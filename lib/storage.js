const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

let client = null;

function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return client;
}

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function extensionForMime(mimeType) {
  return EXTENSION_BY_MIME[mimeType] || 'jpg';
}

async function uploadPhoto(buffer, mimeType) {
  const key = `items/${Date.now()}-${crypto.randomUUID()}.${extensionForMime(mimeType)}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType
    })
  );

  const url = `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  return { key, url };
}

async function deletePhoto(key) {
  await getClient().send(
    new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key
    })
  );
}

module.exports = { uploadPhoto, deletePhoto };
