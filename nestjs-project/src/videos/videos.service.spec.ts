import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotUploadableException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { VideosService } from './videos.service';

const GIB = 1024 * 1024 * 1024;

const baseConfig = {
  maxSizeBytes: 10 * GIB,
  partSizeBytes: 64 * 1024 * 1024,
  allowedContentTypes: ['video/mp4', 'video/webm'],
  uploadUrlTtlSeconds: 900,
  urlTtlSeconds: 3600,
  jobAttempts: 3,
  jobBackoffMs: 5000,
  reconcileIntervalSeconds: 300,
  processingStaleSeconds: 3600,
  uploadTtlHours: 24,
};

const publicIdCollision = () =>
  new QueryFailedError(
    'INSERT INTO videos',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    }),
  );

describe('VideosService', () => {
  let service: VideosService;
  const createdPublicIds: string[] = [];

  const repository = {
    create: jest.fn((video: Partial<Video>) => {
      createdPublicIds.push(video.public_id ?? '');
      return video;
    }),
    save: jest.fn((video: Partial<Video>) =>
      Promise.resolve({ ...video, created_at: new Date('2026-01-01') }),
    ),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    listParts: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const producer = { enqueueProcessing: jest.fn() };

  const build = async (config = baseConfig) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
        { provide: VideoQueueProducer, useValue: producer },
        { provide: videosConfig.KEY, useValue: config },
      ],
    }).compile();
    return module.get(VideosService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    createdPublicIds.length = 0;
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
    service = await build();
  });

  describe('createDraft', () => {
    const dto = {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
    };

    it('should create a draft with the filename as provisional title', async () => {
      const result = await service.createDraft('user-1', dto);

      expect(result.title).toBe('clip.mp4');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.part_count).toBe(1);
      expect(result.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/[0-9a-f-]{36}\/source\.mp4$/),
        'video/mp4',
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          upload_id: 'upload-1',
          status: VideoStatus.DRAFT,
        }),
      );
    });

    it('should split a 10 GiB file into 160 parts of 64 MiB', async () => {
      const result = await service.createDraft('user-1', {
        ...dto,
        size_bytes: 10 * GIB,
      });

      expect(result.part_size_bytes).toBe(64 * 1024 * 1024);
      expect(result.part_count).toBe(160);
    });

    it('should enlarge the part size when it would exceed 10,000 parts', async () => {
      const tight = await build({
        ...baseConfig,
        maxSizeBytes: 100 * GIB,
        partSizeBytes: 5 * 1024 * 1024,
      });

      const result = await tight.createDraft('user-1', {
        ...dto,
        size_bytes: 100 * GIB,
      });

      expect(result.part_count).toBeLessThanOrEqual(10000);
      expect(result.part_size_bytes).toBeGreaterThan(5 * 1024 * 1024);
    });

    it('should reject a content type outside the allowed list', async () => {
      await expect(
        service.createDraft('user-1', { ...dto, content_type: 'video/avi' }),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject an extension that does not match the content type', async () => {
      await expect(
        service.createDraft('user-1', { ...dto, filename: 'clip.webm' }),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a size above the maximum before touching the storage', async () => {
      await expect(
        service.createDraft('user-1', { ...dto, size_bytes: 10 * GIB + 1 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should fail loudly when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft('user-1', dto)).rejects.toThrow(
        'has no channel',
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should retry with a new public id when the generated one collides', async () => {
      repository.save.mockRejectedValueOnce(publicIdCollision());

      const result = await service.createDraft('user-1', dto);

      expect(repository.save).toHaveBeenCalledTimes(2);
      expect(createdPublicIds).toHaveLength(2);
      expect(createdPublicIds[0]).not.toBe(createdPublicIds[1]);
      expect(result.public_id).toBe(createdPublicIds[1]);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and rethrow when the insert fails', async () => {
      const failure = new Error('connection lost');
      repository.save.mockRejectedValueOnce(failure);

      await expect(service.createDraft('user-1', dto)).rejects.toBe(failure);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should abort the upload and fail after exhausting the public id attempts', async () => {
      repository.save.mockRejectedValue(publicIdCollision());

      await expect(service.createDraft('user-1', dto)).rejects.toThrow(
        'unique public id',
      );
      expect(repository.save).toHaveBeenCalledTimes(5);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should still report the original error when the cleanup abort also fails', async () => {
      const failure = new Error('connection lost');
      repository.save.mockRejectedValueOnce(failure);
      storage.abortMultipartUpload.mockRejectedValueOnce(
        new Error('storage down'),
      );

      await expect(service.createDraft('user-1', dto)).rejects.toBe(failure);
    });
  });

  describe('getUploadState', () => {
    const draft = {
      public_id: 'aB3dE5gH7jK',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/id/source.mp4',
      upload_id: 'upload-1',
      part_size_bytes: 67108864,
      part_count: 3,
    };

    it('should fail with VIDEO_NOT_FOUND when the video is not owned by the user', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getUploadState('user-1', 'aB3dE5gH7jK'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should fail with VIDEO_NOT_UPLOADABLE when the video is not a draft', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.getUploadState('user-1', 'aB3dE5gH7jK'),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });

    it('should list the parts already held by the storage', async () => {
      repository.findOne.mockResolvedValue(draft);
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"a"', sizeBytes: 67108864 },
      ]);

      const state = await service.getUploadState('user-1', 'aB3dE5gH7jK');

      expect(storage.listParts).toHaveBeenCalledWith(
        'videos/id/source.mp4',
        'upload-1',
      );
      expect(state.uploaded_parts).toEqual([
        { part_number: 1, etag: '"a"', size_bytes: 67108864 },
      ]);
      expect(state.part_count).toBe(3);
    });
  });

  describe('signUploadParts', () => {
    const draft = {
      public_id: 'aB3dE5gH7jK',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/id/source.mp4',
      upload_id: 'upload-1',
      part_count: 3,
    };

    it('should sign one URL per requested part', async () => {
      repository.findOne.mockResolvedValue(draft);
      storage.presignUploadPart.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      );

      const result = await service.signUploadParts('user-1', 'aB3dE5gH7jK', {
        part_numbers: [1, 3],
      });

      expect(result.expires_in_seconds).toBe(900);
      expect(result.urls).toEqual([
        { part_number: 1, url: 'https://storage/part-1' },
        { part_number: 3, url: 'https://storage/part-3' },
      ]);
    });

    it('should reject a part number above the part count with a validation error', async () => {
      repository.findOne.mockResolvedValue(draft);

      const failure = service.signUploadParts('user-1', 'aB3dE5gH7jK', {
        part_numbers: [1, 4],
      });

      await expect(failure).rejects.toBeInstanceOf(InvalidUploadPartsException);
      await expect(failure).rejects.toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        httpStatus: 400,
      });
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should fail with VIDEO_NOT_UPLOADABLE for a video that is not a draft', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.READY,
      });

      await expect(
        service.signUploadParts('user-1', 'aB3dE5gH7jK', { part_numbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });

  describe('completeUpload', () => {
    const draft = {
      id: 'video-1',
      public_id: 'aB3dE5gH7jK',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-1/source.mp4',
      upload_id: 'upload-1',
      size_bytes: 2048,
      part_count: 2,
    };
    const allParts = {
      parts: [
        { part_number: 1, etag: '"a"' },
        { part_number: 2, etag: '"b"' },
      ],
    };

    beforeEach(() => {
      repository.findOne.mockResolvedValue(draft);
      repository.update.mockResolvedValue({ affected: 1 });
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ sizeBytes: 2048 });
      storage.deleteObject.mockResolvedValue(undefined);
      producer.enqueueProcessing.mockResolvedValue(undefined);
    });

    it('should move the video to processing and enqueue it', async () => {
      const result = await service.completeUpload(
        'user-1',
        'aB3dE5gH7jK',
        allParts,
      );

      expect(result).toEqual({
        public_id: 'aB3dE5gH7jK',
        status: VideoStatus.PROCESSING,
      });
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          upload_id: null,
          processing_started_at: expect.any(Date) as Date,
        }),
      );
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
    });

    it('should send the parts to the storage with camelCase fields', async () => {
      await service.completeUpload('user-1', 'aB3dE5gH7jK', allParts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'upload-1',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 2, etag: '"b"' },
        ],
      );
    });

    it('should reject a request that lists fewer parts than the video has', async () => {
      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', {
          parts: [{ part_number: 1, etag: '"a"' }],
        }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject part numbers that are not 1..part_count', async () => {
      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', {
          parts: [
            { part_number: 1, etag: '"a"' },
            { part_number: 3, etag: '"c"' },
          ],
        }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
    });

    it('should turn a storage 4xx answer into UPLOAD_INCOMPLETE', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        Object.assign(new Error('InvalidPart'), {
          $metadata: { httpStatusCode: 400 },
        }),
      );

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should let an outage of the storage propagate', async () => {
      const outage = new Error('storage down');
      storage.completeMultipartUpload.mockRejectedValue(outage);

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBe(outage);
    });

    it('should fail the video, delete the object and report the size mismatch', async () => {
      storage.headObject.mockResolvedValue({ sizeBytes: 1024 });

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.ERROR,
          error_reason: 'upload_size_mismatch',
          upload_id: null,
        },
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
      );
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should still report the size mismatch when deleting the object fails', async () => {
      storage.headObject.mockResolvedValue({ sizeBytes: 1024 });
      storage.deleteObject.mockRejectedValue(new Error('storage down'));

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
    });

    it('should answer normally when the queue is unavailable', async () => {
      producer.enqueueProcessing.mockRejectedValue(new Error('redis down'));

      const result = await service.completeUpload(
        'user-1',
        'aB3dE5gH7jK',
        allParts,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should fail with VIDEO_NOT_UPLOADABLE when another call already moved the video', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should fail with VIDEO_NOT_FOUND for a video of another user', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', 'aB3dE5gH7jK', allParts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
