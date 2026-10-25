import { registerAs } from '@nestjs/config';

export const DEFAULT_VIDEO_ALLOWED_CONTENT_TYPES =
  'video/mp4,video/webm,video/quicktime,video/x-matroska';

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '67108864', 10),
  allowedContentTypes: (
    process.env.VIDEO_ALLOWED_CONTENT_TYPES ||
    DEFAULT_VIDEO_ALLOWED_CONTENT_TYPES
  )
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '900',
    10,
  ),
  urlTtlSeconds: parseInt(process.env.VIDEO_URL_TTL_SECONDS || '3600', 10),
  jobAttempts: parseInt(process.env.VIDEO_JOB_ATTEMPTS || '3', 10),
  jobBackoffMs: parseInt(process.env.VIDEO_JOB_BACKOFF_MS || '5000', 10),
  reconcileIntervalSeconds: parseInt(
    process.env.VIDEO_RECONCILE_INTERVAL_SECONDS || '300',
    10,
  ),
  processingStaleSeconds: parseInt(
    process.env.VIDEO_PROCESSING_STALE_SECONDS || '3600',
    10,
  ),
  uploadTtlHours: parseInt(process.env.VIDEO_UPLOAD_TTL_HOURS || '24', 10),
}));
