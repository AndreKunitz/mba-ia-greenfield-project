import type { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { Test, type TestingModule } from '@nestjs/testing';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { createS3Client } from './storage.client';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

const config = {
  endpoint: 'http://storage:8333',
  publicEndpoint: 'http://public.example.com:9000',
  region: 'us-east-1',
  accessKey: 'access',
  secretKey: 'secret',
  bucket: 'test-bucket',
  forcePathStyle: true,
  corsAllowedOrigins: ['*'],
};

describe('StorageService', () => {
  let service: StorageService;
  let internalClient: S3Client;
  let publicClient: S3Client;

  beforeEach(async () => {
    internalClient = createS3Client(config, config.endpoint);
    publicClient = createS3Client(config, config.publicEndpoint);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_INTERNAL_CLIENT, useValue: internalClient },
        { provide: S3_PUBLIC_CLIENT, useValue: publicClient },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('presigned URL host', () => {
    it('should sign upload parts with the public endpoint host', async () => {
      const url = await service.presignUploadPart('k', 'upload-1', 1, 300);

      expect(new URL(url).host).toBe('public.example.com:9000');
    });

    it('should sign reads for the browser with the public endpoint host', async () => {
      const url = await service.presignGetObject('k', {
        expiresInSeconds: 300,
      });

      expect(new URL(url).host).toBe('public.example.com:9000');
    });

    it('should sign reads for the worker with the internal endpoint host', async () => {
      const url = await service.presignGetObjectInternal('k', 300);

      expect(new URL(url).host).toBe('storage:8333');
    });

    it('should carry the content disposition in the signed read URL', async () => {
      const url = await service.presignGetObject('k', {
        expiresInSeconds: 300,
        contentDisposition: 'attachment; filename="a.mp4"',
      });

      expect(
        new URL(url).searchParams.get('response-content-disposition'),
      ).toBe('attachment; filename="a.mp4"');
    });
  });

  describe('error classification', () => {
    it('should convert a connection failure into STORAGE_UNAVAILABLE', async () => {
      jest.spyOn(internalClient, 'send').mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }) as never,
      );

      await expect(service.headObject('k')).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    });

    it('should convert a 5xx answer into STORAGE_UNAVAILABLE', async () => {
      jest.spyOn(internalClient, 'send').mockRejectedValue(
        Object.assign(new Error('boom'), {
          $metadata: { httpStatusCode: 500 },
        }) as never,
      );

      await expect(service.deleteObject('k')).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    });

    it('should propagate a 4xx answer untouched so the caller can interpret it', async () => {
      const notFound = Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      jest.spyOn(internalClient, 'send').mockRejectedValue(notFound as never);

      await expect(service.headObject('k')).rejects.toBe(notFound);
    });
  });

  describe('listParts', () => {
    it('should follow pagination until the last page', async () => {
      const send = jest.spyOn(internalClient, 'send');
      send
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        } as never)
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: 7 }],
          IsTruncated: false,
        } as never);

      const parts = await service.listParts('k', 'upload-1');

      expect(parts).toEqual([
        { partNumber: 1, etag: '"a"', sizeBytes: 5 },
        { partNumber: 2, etag: '"b"', sizeBytes: 7 },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('completeMultipartUpload', () => {
    it('should send the parts ordered by part number', async () => {
      const send = jest
        .spyOn(internalClient, 'send')
        .mockResolvedValue({} as never);

      await service.completeMultipartUpload('k', 'upload-1', [
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ]);

      const [command] = send.mock.calls[0] as unknown as [
        CompleteMultipartUploadCommand,
      ];
      expect(command.input.MultipartUpload?.Parts).toEqual([
        { PartNumber: 1, ETag: '"a"' },
        { PartNumber: 2, ETag: '"b"' },
      ]);
    });
  });
});
