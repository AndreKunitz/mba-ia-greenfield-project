import { GetBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_BYTES = 5 * 1024 * 1024;
const TEST_ORIGIN = 'http://localhost:3001';

const stripQuotes = (etag: string) => etag.replace(/"/g, '');

describe('StorageService (real storage)', () => {
  let module: TestingModule;
  let service: StorageService;
  let internalClient: S3Client;
  let config: ConfigType<typeof storageConfig>;
  const prefix = `integration-tests/${randomUUID()}`;
  const createdKeys: string[] = [];

  const newKey = (name: string) => {
    const key = `${prefix}/${name}`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    // Tests run inside the Compose network, where the browser-facing address
    // (localhost) is not reachable; the host selection itself is covered by
    // the unit test.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();

    service = module.get(StorageService);
    internalClient = module.get(S3_INTERNAL_CLIENT);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await service.deleteObject(key);
    }
    await module.close();
  });

  describe('multipart upload', () => {
    it('should upload two parts through presigned URLs and complete the object', async () => {
      const key = newKey('multipart.bin');
      const part1 = Buffer.alloc(MIN_PART_BYTES, 1);
      const part2 = Buffer.alloc(1024, 2);
      const uploadId = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );

      const url1 = await service.presignUploadPart(key, uploadId, 1, 300);
      const response1 = await fetch(url1, { method: 'PUT', body: part1 });
      expect(response1.status).toBe(200);
      const etag1 = response1.headers.get('etag') ?? '';
      expect(etag1).not.toBe('');

      const uploaded = await service.listParts(key, uploadId);
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].partNumber).toBe(1);
      expect(uploaded[0].sizeBytes).toBe(MIN_PART_BYTES);
      expect(stripQuotes(uploaded[0].etag)).toBe(stripQuotes(etag1));

      const url2 = await service.presignUploadPart(key, uploadId, 2, 300);
      const response2 = await fetch(url2, { method: 'PUT', body: part2 });
      expect(response2.status).toBe(200);
      const etag2 = response2.headers.get('etag') ?? '';

      await service.completeMultipartUpload(key, uploadId, [
        { partNumber: 2, etag: etag2 },
        { partNumber: 1, etag: etag1 },
      ]);

      const info = await service.headObject(key);
      expect(info.sizeBytes).toBe(MIN_PART_BYTES + 1024);
    });

    it('should drop the pending upload when it is aborted', async () => {
      const key = newKey('aborted.bin');
      const uploadId = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      const url = await service.presignUploadPart(key, uploadId, 1, 300);
      await fetch(url, { method: 'PUT', body: Buffer.alloc(16, 3) });

      await service.abortMultipartUpload(key, uploadId);

      await expect(service.listParts(key, uploadId)).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
    });
  });

  describe('reading objects', () => {
    it('should answer a Range request with 206 and the requested bytes', async () => {
      const key = newKey('range.bin');
      await service.putObject(
        key,
        Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'),
        'application/octet-stream',
      );
      const url = await service.presignGetObject(key, {
        expiresInSeconds: 300,
      });

      const response = await fetch(url, { headers: { Range: 'bytes=0-9' } });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(206);
      expect(body.toString()).toBe('0123456789');
      expect(response.headers.get('content-range')).toContain('bytes 0-9/');
    });

    it('should apply the content disposition asked in the signed URL', async () => {
      const key = newKey('download.bin');
      await service.putObject(key, Buffer.from('data'), 'video/mp4');
      const url = await service.presignGetObject(key, {
        expiresInSeconds: 300,
        contentDisposition: 'attachment; filename="clip.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('should serve the object through a URL signed for the worker', async () => {
      const key = newKey('worker.bin');
      await service.putObject(key, Buffer.from('for-worker'), 'video/mp4');
      const url = await service.presignGetObjectInternal(key, 300);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('for-worker');
    });

    it('should report a 404 for a deleted object so the caller can interpret it', async () => {
      const key = newKey('deleted.bin');
      await service.putObject(key, Buffer.from('x'), 'video/mp4');

      await service.deleteObject(key);

      await expect(service.headObject(key)).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
    });
  });

  describe('CORS and bucket setup', () => {
    it('should be idempotent when ensuring the bucket twice', async () => {
      await expect(service.ensureBucket()).resolves.toBeUndefined();
      await expect(service.ensureBucket()).resolves.toBeUndefined();
    });

    it('should store a CORS rule that exposes the ETag header', async () => {
      const response = await internalClient.send(
        new GetBucketCorsCommand({ Bucket: config.bucket }),
      );

      const rule = response.CORSRules?.[0];
      expect(rule?.ExposeHeaders).toContain('ETag');
      expect(rule?.AllowedMethods).toEqual(
        expect.arrayContaining(['PUT', 'GET', 'HEAD']),
      );
    });

    it('should answer a preflight for a part upload from an allowed origin', async () => {
      const key = newKey('preflight.bin');
      const url = await service.presignUploadPart(key, 'any-upload', 1, 300);

      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: TEST_ORIGIN,
          'Access-Control-Request-Method': 'PUT',
        },
      });

      expect(response.status).toBeLessThan(300);
      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
      expect(response.headers.get('access-control-allow-methods')).toContain(
        'PUT',
      );
    });

    it('should expose the ETag header on a cross-origin part upload', async () => {
      const key = newKey('cors-part.bin');
      const uploadId = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      const url = await service.presignUploadPart(key, uploadId, 1, 300);

      const response = await fetch(url, {
        method: 'PUT',
        headers: { Origin: TEST_ORIGIN },
        body: Buffer.alloc(16, 4),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
      expect(
        response.headers.get('access-control-expose-headers')?.toLowerCase(),
      ).toContain('etag');

      await service.abortMultipartUpload(key, uploadId);
    });
  });

  describe('storage failures', () => {
    it('should turn a real connection failure into STORAGE_UNAVAILABLE', async () => {
      const unreachable = new S3Client({
        endpoint: 'http://127.0.0.1:1',
        region: config.region,
        forcePathStyle: true,
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        maxAttempts: 1,
      });
      const broken = new StorageService(unreachable, unreachable, config);

      await expect(broken.headObject('any')).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    });
  });
});
