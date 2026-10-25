import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://storage:8333',
  S3_PUBLIC_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

const validateWithout = (missing: keyof typeof requiredEnv) =>
  envValidationSchema.validate(
    Object.fromEntries(
      Object.entries(requiredEnv).filter(([key]) => key !== missing),
    ),
    { allowUnknown: true, abortEarly: false },
  );

const validatedValues = (env: Record<string, string>) =>
  validate(env).value as Record<string, unknown>;

describe('envValidationSchema — storage, queue and videos', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET',
  ] as const)('should reject the environment when %s is missing', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject an S3 endpoint that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should apply the video defaults when the optional variables are not set', () => {
    expect(validate({}).error).toBeUndefined();
    const values = validatedValues({});
    expect(values.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(values.VIDEO_PART_SIZE_BYTES).toBe(67108864);
    expect(values.VIDEO_ALLOWED_CONTENT_TYPES).toBe(
      'video/mp4,video/webm,video/quicktime,video/x-matroska',
    );
    expect(values.VIDEO_UPLOAD_URL_TTL_SECONDS).toBe(900);
    expect(values.VIDEO_URL_TTL_SECONDS).toBe(3600);
    expect(values.VIDEO_JOB_ATTEMPTS).toBe(3);
    expect(values.VIDEO_JOB_BACKOFF_MS).toBe(5000);
    expect(values.VIDEO_RECONCILE_INTERVAL_SECONDS).toBe(300);
    expect(values.VIDEO_PROCESSING_STALE_SECONDS).toBe(3600);
    expect(values.VIDEO_UPLOAD_TTL_HOURS).toBe(24);
  });

  it('should apply the storage and queue defaults when the optional variables are not set', () => {
    expect(validate({}).error).toBeUndefined();
    const values = validatedValues({});
    expect(values.S3_REGION).toBe('us-east-1');
    expect(values.S3_FORCE_PATH_STYLE).toBe('true');
    expect(values.S3_CORS_ALLOWED_ORIGINS).toBe('*');
    expect(values.REDIS_HOST).toBe('redis');
    expect(values.REDIS_PORT).toBe(6379);
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ VIDEO_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PART_SIZE_BYTES');
  });
});

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
    expect(validatedValues({}).SWAGGER_ENABLED).toBe('false');
  });
});
