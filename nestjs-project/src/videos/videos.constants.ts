export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_PATTERN = /^[0-9A-Za-z]{11}$/;

export const VIDEO_STATUS_ENUM_NAME = 'video_status';

export const VIDEO_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';
export const RECONCILE_VIDEOS_JOB = 'reconcile-videos';
export const RECONCILE_SCHEDULER_ID = 'reconcile-videos-schedule';
export const RECONCILE_BATCH_SIZE = 100;
export const ENQUEUE_TIMEOUT_MS = 3000;

export const S3_MAX_PARTS = 10000;
export const MAX_PUBLIC_ID_ATTEMPTS = 5;
export const PUBLIC_ID_COLUMN = 'public_id';

// Extensions accepted for each allowed content type. A content type that is
// allowed by configuration but absent here skips the extension check.
export const CONTENT_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  'video/mp4': ['.mp4', '.m4v'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'video/x-matroska': ['.mkv'],
};
