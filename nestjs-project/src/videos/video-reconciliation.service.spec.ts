import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { VideoReconciliationService } from './video-reconciliation.service';

describe('VideoReconciliationService', () => {
  const repository = { find: jest.fn(), update: jest.fn() };
  const storage = { abortMultipartUpload: jest.fn() };
  const producer = { reenqueueProcessing: jest.fn() };
  let service: VideoReconciliationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoReconciliationService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueueProducer, useValue: producer },
        {
          provide: videosConfig.KEY,
          useValue: { processingStaleSeconds: 3600, uploadTtlHours: 24 },
        },
      ],
    }).compile();
    service = module.get(VideoReconciliationService);
  });

  describe('requeueStaleProcessing', () => {
    it('should requeue every stale video and count them', async () => {
      repository.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      producer.reenqueueProcessing.mockResolvedValue(undefined);

      await expect(service.requeueStaleProcessing()).resolves.toBe(2);
      expect(producer.reenqueueProcessing).toHaveBeenCalledWith('a');
      expect(producer.reenqueueProcessing).toHaveBeenCalledWith('b');
    });

    it('should keep going when one video cannot be requeued', async () => {
      repository.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      producer.reenqueueProcessing
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce(undefined);

      await expect(service.requeueStaleProcessing()).resolves.toBe(1);
      expect(producer.reenqueueProcessing).toHaveBeenCalledTimes(2);
    });
  });

  describe('abortAbandonedUploads', () => {
    const draft = { id: 'v1', storage_key: 'k', upload_id: 'u1' };

    it('should abort the multipart and close the draft', async () => {
      repository.find.mockResolvedValue([draft]);

      await expect(service.abortAbandonedUploads()).resolves.toBe(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith('k', 'u1');
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'v1', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.ERROR,
          error_reason: 'upload_abandoned',
          upload_id: null,
        },
      );
    });

    it('should close the draft when the multipart is already gone (4xx)', async () => {
      repository.find.mockResolvedValue([draft]);
      storage.abortMultipartUpload.mockRejectedValue({
        $metadata: { httpStatusCode: 404 },
      });

      await expect(service.abortAbandonedUploads()).resolves.toBe(1);
      expect(repository.update).toHaveBeenCalled();
    });

    it('should leave the draft untouched when the storage is unavailable', async () => {
      repository.find.mockResolvedValue([draft]);
      storage.abortMultipartUpload.mockRejectedValue(new Error('storage down'));

      await expect(service.abortAbandonedUploads()).resolves.toBe(0);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should skip the storage call for a draft without upload id', async () => {
      repository.find.mockResolvedValue([{ ...draft, upload_id: null }]);

      await expect(service.abortAbandonedUploads()).resolves.toBe(1);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });

  it('reconcile should report both counts', async () => {
    repository.find
      .mockResolvedValueOnce([{ id: 'a' }])
      .mockResolvedValueOnce([]);

    await expect(service.reconcile()).resolves.toEqual({
      requeued: 1,
      abandoned: 0,
    });
  });
});
