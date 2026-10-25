import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { bullRootForTests } from '../test/bull-root-module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { VideoReconciliationService } from './video-reconciliation.service';
import { VIDEO_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const HOUR_MS = 3_600_000;

describe('VideoReconciliationService (integration)', () => {
  let module: TestingModule;
  let service: VideoReconciliationService;
  let storage: StorageService;
  let queue: Queue;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        bullRootForTests(),
        BullModule.registerQueue({ name: VIDEO_QUEUE }),
        StorageModule,
      ],
      providers: [VideoQueueProducer, VideoReconciliationService],
    }).compile();
    await module.init();

    service = module.get(VideoReconciliationService);
    storage = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    const user = await dataSource.getRepository(User).save({
      email: `reconcile_${++counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Reconcile',
      nickname: `reconcile_chan_${counter}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function insertVideo(
    status: VideoStatus,
    uploadId: string | null,
    storageKey?: string,
  ): Promise<Video> {
    const n = ++counter;
    return videoRepository.save(
      videoRepository.create({
        public_id: `rec${String(n).padStart(8, '0')}`,
        channel_id: channelId,
        title: 'clip.mp4',
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        status,
        storage_key: storageKey ?? `videos/reconcile-${n}/source.mp4`,
        upload_id: uploadId,
        part_size_bytes: 67108864,
        part_count: 1,
      }),
    );
  }

  async function age(id: string, column: string, hours: number) {
    await dataSource.query(`UPDATE videos SET ${column} = $1 WHERE id = $2`, [
      new Date(Date.now() - hours * HOUR_MS),
      id,
    ]);
  }

  describe('requeueStaleProcessing', () => {
    it('should publish a job only for videos stuck in processing', async () => {
      const stale = await insertVideo(VideoStatus.PROCESSING, null);
      await age(stale.id, 'processing_started_at', 2);
      const fresh = await insertVideo(VideoStatus.PROCESSING, null);
      await age(fresh.id, 'processing_started_at', 0);

      await expect(service.requeueStaleProcessing()).resolves.toBe(1);

      expect(await queue.getJob(`video-${stale.id}`)).toBeDefined();
      expect(await queue.getJob(`video-${fresh.id}`)).toBeUndefined();
    });

    it('should not duplicate a job that is still waiting', async () => {
      const stale = await insertVideo(VideoStatus.PROCESSING, null);
      await age(stale.id, 'processing_started_at', 2);

      await service.requeueStaleProcessing();
      await service.requeueStaleProcessing();

      expect(await queue.getWaitingCount()).toBe(1);
    });
  });

  describe('abortAbandonedUploads', () => {
    it('should abort the real multipart and close an old draft', async () => {
      const key = 'videos/reconcile-old/source.mp4';
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const old = await insertVideo(VideoStatus.DRAFT, uploadId, key);
      await age(old.id, 'created_at', 48);

      await expect(service.abortAbandonedUploads()).resolves.toBe(1);

      const saved = await videoRepository.findOneByOrFail({ id: old.id });
      expect(saved.status).toBe(VideoStatus.ERROR);
      expect(saved.error_reason).toBe('upload_abandoned');
      expect(saved.upload_id).toBeNull();
      await expect(
        storage.listParts(old.storage_key, uploadId),
      ).rejects.toBeDefined();
    });

    it('should leave recent drafts alone', async () => {
      const key = 'videos/reconcile-new/source.mp4';
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const recent = await insertVideo(VideoStatus.DRAFT, uploadId, key);

      await expect(service.abortAbandonedUploads()).resolves.toBe(0);

      const saved = await videoRepository.findOneByOrFail({ id: recent.id });
      expect(saved.status).toBe(VideoStatus.DRAFT);
      await storage.abortMultipartUpload(recent.storage_key, uploadId);
    });

    it('should close an old draft whose multipart no longer exists', async () => {
      const old = await insertVideo(VideoStatus.DRAFT, 'no-such-upload-id');
      await age(old.id, 'created_at', 48);

      await expect(service.abortAbandonedUploads()).resolves.toBe(1);
      const saved = await videoRepository.findOneByOrFail({ id: old.id });
      expect(saved.status).toBe(VideoStatus.ERROR);
    });
  });
});
