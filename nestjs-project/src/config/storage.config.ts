import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT!,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT!,
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET!,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  corsAllowedOrigins: (process.env.S3_CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}));
