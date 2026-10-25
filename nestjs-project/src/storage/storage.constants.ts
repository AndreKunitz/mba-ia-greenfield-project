export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

export const CORS_ALLOWED_METHODS = ['PUT', 'GET', 'HEAD'] as const;
export const CORS_EXPOSED_HEADERS = ['ETag'] as const;
export const CORS_MAX_AGE_SECONDS = 3000;
