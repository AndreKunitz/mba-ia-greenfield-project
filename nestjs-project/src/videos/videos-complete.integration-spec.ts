import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadIncompleteException,
  UploadSizeMismatchException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { bullRootForTests } from '../test/bull-root-module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { PROCESS_VIDEO_JOB, VIDEO_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService.completeUpload (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // Tests run inside the Compose network, where the browser-facing address
    // is not reachable.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        bullRootForTests(),
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService, { strict: false });
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE), { strict: false });
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    for (const video of await videoRepository.find()) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(video.storage_key, video.upload_id);
      }
    }
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_complete_${n}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_complete_chan_${n}`,
        user_id: user.id,
      }),
    );
    return user;
  }

  /** Starts an upload of `declared` bytes and sends `sent` bytes in one part. */
  async function uploadSinglePart(
    user: User,
    declared: number,
    sent: number,
  ): Promise<{ publicId: string; etag: string }> {
    const { public_id } = await service.createDraft(user.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: declared,
    });
    const { urls } = await service.signUploadParts(user.id, public_id, {
      part_numbers: [1],
    });
    const response = await fetch(urls[0].url, {
      method: 'PUT',
      body: Buffer.alloc(sent, 5),
    });
    expect(response.status).toBe(200);
    return { publicId: public_id, etag: response.headers.get('etag') ?? '' };
  }

  it('should move the video to processing and publish the job', async () => {
    const user = await createUserWithChannel();
    const { publicId, etag } = await uploadSinglePart(user, 2048, 2048);

    const result = await service.completeUpload(user.id, publicId, {
      parts: [{ part_number: 1, etag }],
    });

    expect(result).toEqual({
      public_id: publicId,
      status: VideoStatus.PROCESSING,
    });
    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    expect(saved.status).toBe(VideoStatus.PROCESSING);
    expect(saved.upload_id).toBeNull();
    expect(saved.processing_started_at).toBeInstanceOf(Date);
    await expect(storage.headObject(saved.storage_key)).resolves.toMatchObject({
      sizeBytes: 2048,
    });

    const job = await queue.getJob(`video-${saved.id}`);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: saved.id });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should not duplicate the job when the same video is enqueued twice', async () => {
    const user = await createUserWithChannel();
    const { publicId, etag } = await uploadSinglePart(user, 2048, 2048);
    await service.completeUpload(user.id, publicId, {
      parts: [{ part_number: 1, etag }],
    });
    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });

    await module.get(VideoQueueProducer).enqueueProcessing(saved.id);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.id === `video-${saved.id}`)).toHaveLength(
      1,
    );
  });

  it('should fail the video and remove the object when the stored size differs', async () => {
    const user = await createUserWithChannel();
    const { publicId, etag } = await uploadSinglePart(user, 2048, 1024);
    const before = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });

    await expect(
      service.completeUpload(user.id, publicId, {
        parts: [{ part_number: 1, etag }],
      }),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);

    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    expect(saved.status).toBe(VideoStatus.ERROR);
    expect(saved.error_reason).toBe('upload_size_mismatch');
    await expect(storage.headObject(before.storage_key)).rejects.toMatchObject({
      $metadata: { httpStatusCode: 404 },
    });
    expect(await queue.getJob(`video-${saved.id}`)).toBeUndefined();
  });

  it('should report an incomplete upload when the ETag does not match', async () => {
    const user = await createUserWithChannel();
    const { publicId } = await uploadSinglePart(user, 2048, 2048);

    await expect(
      service.completeUpload(user.id, publicId, {
        parts: [{ part_number: 1, etag: '"00000000000000000000000000000000"' }],
      }),
    ).rejects.toBeInstanceOf(UploadIncompleteException);

    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    expect(saved.status).toBe(VideoStatus.DRAFT);
  });
});
