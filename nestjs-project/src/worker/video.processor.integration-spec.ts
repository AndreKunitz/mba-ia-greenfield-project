import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { TEST_QUEUE_PREFIX, bullRootForTests } from '../test/bull-root-module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { generateTestAudio, generateTestVideo } from '../test/media-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-queue.producer';
import { VideoQueueProducer } from '../videos/video-queue.producer';
import { VideoReconciliationService } from '../videos/video-reconciliation.service';
import {
  PROCESS_VIDEO_JOB,
  RECONCILE_VIDEOS_JOB,
  VIDEO_QUEUE,
} from '../videos/videos.constants';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting; last value: ${JSON.stringify(value)}`,
      );
    }
    await sleep(150);
  }
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let thumbnails: ThumbnailService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queueSettings: ConfigType<typeof queueConfig>;
  let directory: string;
  let videoBytes: Buffer;
  let audioBytes: Buffer;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'processor-test-'));
    await generateTestVideo(join(directory, 'video.mp4'), 2);
    await generateTestAudio(join(directory, 'audio.m4a'));
    videoBytes = await readFile(join(directory, 'video.mp4'));
    audioBytes = await readFile(join(directory, 'audio.m4a'));

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
      providers: [
        VideoProcessor,
        MediaProbeService,
        ThumbnailService,
        VideoQueueProducer,
        VideoReconciliationService,
      ],
    }).compile();
    await module.init();

    processor = module.get(VideoProcessor);
    thumbnails = module.get(ThumbnailService);
    storage = module.get(StorageService);
    queueSettings = module.get(queueConfig.KEY);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await rm(directory, { recursive: true, force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function seedVideo(
    status: VideoStatus = VideoStatus.PROCESSING,
    content?: Buffer,
  ): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `processor_chan_${n}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    const storageKey = `integration-tests/processor/${id}/source.mp4`;
    if (content) {
      await storage.putObject(storageKey, content, 'video/mp4');
      createdKeys.push(storageKey);
    }
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'clip.mp4',
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: content?.length ?? 1,
        storage_key: storageKey,
        part_size_bytes: 67108864,
        part_count: 1,
        status,
        processing_started_at: new Date(),
      }),
    );
  }

  const jobFor = (video: Video, overrides: Partial<Job> = {}) =>
    ({
      id: `video-${video.id}`,
      name: PROCESS_VIDEO_JOB,
      data: { videoId: video.id } satisfies ProcessVideoJobData,
      opts: { attempts: 3 },
      attemptsMade: 1,
      ...overrides,
    }) as unknown as Job<ProcessVideoJobData>;

  const reload = (video: Video) =>
    videoRepository.findOneByOrFail({ id: video.id });

  describe('processing a video', () => {
    it('should mark a valid video as ready with duration, metadata and thumbnail', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING, videoBytes);

      await processor.process(jobFor(video));

      const saved = await reload(video);
      expect(saved.status).toBe(VideoStatus.READY);
      expect(saved.duration_seconds).toBeCloseTo(2, 0);
      expect(saved.error_reason).toBeNull();
      const metadata = saved.metadata as {
        streams: { codec_type: string; codec_name: string }[];
      };
      expect(
        metadata.streams.find((s) => s.codec_type === 'video')?.codec_name,
      ).toBe('h264');
      expect(saved.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
      createdKeys.push(saved.thumbnail_key!);
      const thumbnailUrl = await storage.presignGetObjectInternal(
        saved.thumbnail_key!,
        60,
      );
      const image = Buffer.from(
        await (await fetch(thumbnailUrl)).arrayBuffer(),
      );
      expect([...image.subarray(0, 3)]).toEqual(JPEG_MAGIC);
    });

    it('should fail a file that is not a video without retrying', async () => {
      const video = await seedVideo(
        VideoStatus.PROCESSING,
        Buffer.from('this is not a media file'),
      );

      await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      const saved = await reload(video);
      expect(saved.status).toBe(VideoStatus.ERROR);
      expect(saved.error_reason).toBe('invalid_media');
      expect(saved.thumbnail_key).toBeNull();
    });

    it('should fail audio-only media as invalid media', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING, audioBytes);

      await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect((await reload(video)).error_reason).toBe('invalid_media');
    });

    it('should do nothing for a video that is already ready', async () => {
      const video = await seedVideo(VideoStatus.READY, videoBytes);
      const generate = jest.spyOn(thumbnails, 'generate');

      await processor.process(jobFor(video));

      expect(generate).not.toHaveBeenCalled();
      expect((await reload(video)).thumbnail_key).toBeNull();
    });

    it('should do nothing for a video that is not processing yet', async () => {
      const video = await seedVideo(VideoStatus.DRAFT, videoBytes);
      const generate = jest.spyOn(thumbnails, 'generate');

      await processor.process(jobFor(video));

      expect(generate).not.toHaveBeenCalled();
      expect((await reload(video)).status).toBe(VideoStatus.DRAFT);
    });

    it('should ignore a job for a video that does not exist', async () => {
      const ghost = { id: randomUUID() } as Video;

      await expect(processor.process(jobFor(ghost))).resolves.toBeUndefined();
    });

    it('should reject a job name it does not know without retrying', async () => {
      const video = await seedVideo();

      await expect(
        processor.process(jobFor(video, { name: 'something-else' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('should run the reconciliation for a reconcile job', async () => {
      const reconcile = jest
        .spyOn(module.get(VideoReconciliationService), 'reconcile')
        .mockResolvedValue({ requeued: 0, abandoned: 0 });
      const video = await seedVideo();

      await processor.process(jobFor(video, { name: RECONCILE_VIDEOS_JOB }));

      expect(reconcile).toHaveBeenCalledTimes(1);
      reconcile.mockRestore();
    });
  });

  describe('recording the final failure', () => {
    it('should keep the video processing while attempts remain', async () => {
      const video = await seedVideo();

      await processor.onFailed(
        jobFor(video, { attemptsMade: 1 }),
        new Error('storage hiccup'),
      );

      expect((await reload(video)).status).toBe(VideoStatus.PROCESSING);
    });

    it('should move the video to error when the attempts are exhausted', async () => {
      const video = await seedVideo();

      await processor.onFailed(
        jobFor(video, { attemptsMade: 3 }),
        new Error('storage hiccup'),
      );

      const saved = await reload(video);
      expect(saved.status).toBe(VideoStatus.ERROR);
      expect(saved.error_reason).toBe('processing_failed');
    });

    it('should not overwrite the reason of a video that already failed for good', async () => {
      const video = await seedVideo(VideoStatus.ERROR);
      await videoRepository.update(
        { id: video.id },
        { error_reason: 'invalid_media' },
      );

      await processor.onFailed(
        jobFor(video, { attemptsMade: 1 }),
        new UnrecoverableError('invalid media'),
      );

      expect((await reload(video)).error_reason).toBe('invalid_media');
    });
  });

  describe('with a real BullMQ worker', () => {
    let queue: Queue;
    let worker: Worker;

    beforeEach(async () => {
      const connection = {
        host: queueSettings.host,
        port: queueSettings.port,
      };
      queue = new Queue(VIDEO_QUEUE, {
        connection,
        prefix: TEST_QUEUE_PREFIX,
      });
      await queue.obliterate({ force: true });
      worker = new Worker(
        VIDEO_QUEUE,
        (job: Job<ProcessVideoJobData>) => processor.process(job),
        { connection, prefix: TEST_QUEUE_PREFIX },
      );
      worker.on('failed', (job, error) => {
        void processor.onFailed(job, error);
      });
    });

    afterEach(async () => {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it('should retry with backoff and finish ready once the failure goes away', async () => {
      // The object does not exist yet: the first attempt fails (a 404 from the
      // storage is a retryable failure, not invalid media).
      const video = await seedVideo(VideoStatus.PROCESSING);
      await queue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        {
          jobId: `video-${video.id}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 300 },
        },
      );

      await waitFor(
        async () =>
          (await queue.getJob(`video-${video.id}`))?.attemptsMade ?? 0,
        (attempts) => attempts >= 1,
      );
      expect((await reload(video)).status).toBe(VideoStatus.PROCESSING);

      await storage.putObject(video.storage_key, videoBytes, 'video/mp4');
      createdKeys.push(video.storage_key);

      const saved = await waitFor(
        () => reload(video),
        (v) => v.status !== VideoStatus.PROCESSING,
      );
      expect(saved.status).toBe(VideoStatus.READY);
      createdKeys.push(`videos/${video.id}/thumbnail.jpg`);
      const job = await queue.getJob(`video-${video.id}`);
      expect(job?.attemptsMade).toBeGreaterThanOrEqual(2);
    });

    it('should end in error with processing_failed after the attempts run out', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);
      await queue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        {
          jobId: `video-${video.id}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 100 },
        },
      );

      const saved = await waitFor(
        () => reload(video),
        (v) => v.status !== VideoStatus.PROCESSING,
      );

      expect(saved.status).toBe(VideoStatus.ERROR);
      expect(saved.error_reason).toBe('processing_failed');
      const job = await queue.getJob(`video-${video.id}`);
      expect(job?.attemptsMade).toBe(2);
    });

    it('should not retry a file that is not a video', async () => {
      const video = await seedVideo(
        VideoStatus.PROCESSING,
        Buffer.from('not a video'),
      );
      await queue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        {
          jobId: `video-${video.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 100 },
        },
      );

      const saved = await waitFor(
        () => reload(video),
        (v) => v.status !== VideoStatus.PROCESSING,
      );

      expect(saved.error_reason).toBe('invalid_media');
      const job = await queue.getJob(`video-${video.id}`);
      expect(job?.attemptsMade).toBe(1);
    });
  });
});
