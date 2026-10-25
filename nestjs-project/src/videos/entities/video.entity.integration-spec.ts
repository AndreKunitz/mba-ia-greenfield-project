import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  const newVideo = (channelId: string, overrides: Partial<Video> = {}) =>
    videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'clip.mp4',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
      storage_key: 'videos/some-id/source.mp4',
      part_size_bytes: 67108864,
      part_count: 1,
      ...overrides,
    });

  it('should default the status to draft and fill the timestamps', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(newVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should leave the optional columns null until the worker fills them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(newVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.error_reason).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_started_at).toBeNull();
  });

  it('should read bigint and numeric columns back as numbers', async () => {
    const channel = await createChannel();
    const tenGiB = 10737418240;

    const saved = await videoRepository.save(
      newVideo(channel.id, {
        size_bytes: tenGiB,
        duration_seconds: 12.345,
        metadata: { format: 'mov,mp4', streams: 2 },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGiB);
    expect(found.duration_seconds).toBe(12.345);
    expect(found.metadata).toEqual({ format: 'mov,mp4', streams: 2 });
  });

  it('should enforce a unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      newVideo(channel.id, { public_id: 'AbCdEfGh123' }),
    );

    await expect(
      videoRepository.save(newVideo(channel.id, { public_id: 'AbCdEfGh123' })),
    ).rejects.toThrow();
  });

  it('should reject a public_id longer than 11 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(newVideo(channel.id, { public_id: 'A'.repeat(12) })),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(newVideo('00000000-0000-4000-8000-000000000000')),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        newVideo(channel.id, { status: 'archived' as unknown as VideoStatus }),
      ),
    ).rejects.toThrow();
  });

  it('should load the videos of a channel through the relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(newVideo(channel.id));
    await videoRepository.save(newVideo(channel.id));

    const loaded = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(loaded.videos).toHaveLength(2);
  });
});
