import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
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
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const OBJECT_BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

describe('VideosService reading (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const createdKeys: string[] = [];

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
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_read_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_read_svc_chan_${n}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function seedVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const id = randomUUID();
    const storageKey = `integration-tests/read-svc/${id}/source.mp4`;
    const thumbnailKey = `integration-tests/read-svc/${id}/thumbnail.jpg`;
    await storage.putObject(storageKey, OBJECT_BYTES, 'video/mp4');
    await storage.putObject(thumbnailKey, Buffer.from('jpeg'), 'image/jpeg');
    createdKeys.push(storageKey, thumbnailKey);
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'Férias 2026.mp4',
        original_filename: 'Férias 2026.mp4',
        content_type: 'video/mp4',
        size_bytes: OBJECT_BYTES.length,
        storage_key: storageKey,
        thumbnail_key: thumbnailKey,
        part_size_bytes: 67108864,
        part_count: 1,
        status: VideoStatus.READY,
        duration_seconds: 2.5,
        metadata: { format_name: 'mov,mp4' },
        ...overrides,
      }),
    );
  }

  it('should give a stream URL that the storage answers with 206 for a Range', async () => {
    const { channel } = await createUserWithChannel();
    const video = await seedVideo(channel);

    const url = await service.getStreamUrl(video.public_id);
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
  });

  it('should give a download URL that carries the original file name', async () => {
    const { channel } = await createUserWithChannel();
    const video = await seedVideo(channel);

    const response = await fetch(await service.getDownloadUrl(video.public_id));

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(decodeURIComponent(disposition)).toContain('Férias 2026.mp4');
  });

  it('should give a thumbnail URL that serves the image', async () => {
    const { channel } = await createUserWithChannel();
    const video = await seedVideo(channel);

    const response = await fetch(
      await service.getThumbnailUrl(video.public_id),
    );

    expect(await response.text()).toBe('jpeg');
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'should hide a video in %s from the public reads',
    async (status) => {
      const { channel } = await createUserWithChannel();
      const video = await seedVideo(channel, { status });

      await expect(
        service.getPublicVideo(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getStreamUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getDownloadUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getThumbnailUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    },
  );

  it('should hide the thumbnail of a ready video that has none', async () => {
    const { channel } = await createUserWithChannel();
    const video = await seedVideo(channel, { thumbnail_key: null });

    await expect(
      service.getThumbnailUrl(video.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should show the owner the status in any state and hide it from others', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const video = await seedVideo(owner.channel, {
      status: VideoStatus.ERROR,
      error_reason: 'invalid_media',
    });

    const status = await service.getOwnerStatus(owner.user.id, video.public_id);

    expect(status).toMatchObject({
      public_id: video.public_id,
      status: VideoStatus.ERROR,
      error_reason: 'invalid_media',
    });
    await expect(
      service.getOwnerStatus(stranger.user.id, video.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should return the public data with the metadata of a ready video', async () => {
    const { channel } = await createUserWithChannel();
    const video = await seedVideo(channel);

    const data = await service.getPublicVideo(video.public_id);

    expect(data).toMatchObject({
      public_id: video.public_id,
      title: 'Férias 2026.mp4',
      duration_seconds: 2.5,
      metadata: { format_name: 'mov,mp4' },
    });
  });
});
