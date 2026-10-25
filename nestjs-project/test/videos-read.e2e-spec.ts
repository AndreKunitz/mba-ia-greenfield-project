import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface PublicVideoBody {
  public_id: string;
  title: string;
  duration_seconds: number;
  metadata: { format_name: string };
  created_at: string;
}

interface StatusBody {
  public_id: string;
  status: string;
  error_reason: string | null;
}

interface ErrorBody {
  error: string;
}

const bodyOf = <T>(res: request.Response): T => res.body as T;

const OBJECT_BYTES = Buffer.from(
  Array.from({ length: 1000 }, (_, i) => i % 251),
);

describe('Videos read (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    // The signed URLs must be reachable from inside the Compose network.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    jwtService = moduleFixture.get(JwtService, { strict: false });
    storage = moduleFixture.get(StorageService, { strict: false });
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;
  async function createOwner(): Promise<{
    channel: Channel;
    token: string;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_read_${n}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_read_chan_${n}`,
        user_id: user.id,
      }),
    );
    const token = await jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });
    return { channel, token };
  }

  async function seedVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const id = randomUUID();
    const storageKey = `integration-tests/read/${id}/source.mp4`;
    const thumbnailKey = `integration-tests/read/${id}/thumbnail.jpg`;
    await storage.putObject(storageKey, OBJECT_BYTES, 'video/mp4');
    await storage.putObject(thumbnailKey, Buffer.from('jpeg'), 'image/jpeg');
    createdKeys.push(storageKey, thumbnailKey);
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'My Clip.mp4',
        original_filename: 'My Clip.mp4',
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

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  describe('GET /videos/:publicId', () => {
    it('returns 200 with the public data of a ready video, without authentication', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel);

      const res = await get(`/videos/${video.public_id}`).expect(200);

      const body = bodyOf<PublicVideoBody>(res);
      expect(body.public_id).toBe(video.public_id);
      expect(body.title).toBe('My Clip.mp4');
      expect(body.duration_seconds).toBe(2.5);
      expect(body.metadata.format_name).toBe('mov,mp4');
      expect(body.created_at).toBeDefined();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'returns 404 VIDEO_NOT_FOUND for a video in %s',
      async (status) => {
        const { channel } = await createOwner();
        const video = await seedVideo(channel, { status });

        const res = await get(`/videos/${video.public_id}`).expect(404);

        expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
      },
    );

    it('returns 404 for an unknown and for a malformed id alike', async () => {
      const unknown = await get('/videos/aaaaaaaaaaa').expect(404);
      const malformed = await get('/videos/not-a-valid-id!').expect(404);

      expect(bodyOf<ErrorBody>(unknown).error).toBe('VIDEO_NOT_FOUND');
      expect(bodyOf<ErrorBody>(malformed).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('returns 302 to a signed URL that the storage serves with Range', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel);

      const res = await get(`/videos/${video.public_id}/stream`).expect(302);

      expect(res.headers['cache-control']).toBe('no-store');
      const location = res.headers['location'];
      expect(new URL(location).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );
      const partial = await fetch(location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toContain('bytes 0-99/1000');
      expect(
        Buffer.from(await partial.arrayBuffer()).equals(
          OBJECT_BYTES.subarray(0, 100),
        ),
      ).toBe(true);
    });

    it('returns 404 for a video that is not ready', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel, {
        status: VideoStatus.PROCESSING,
      });

      await get(`/videos/${video.public_id}/stream`).expect(404);
    });

    it('does not throttle repeated playback requests from the same client', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel);

      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        statuses.push((await get(`/videos/${video.public_id}/stream`)).status);
      }

      expect(statuses.every((status) => status === 302)).toBe(true);
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns 302 to a URL that makes the browser save the original name', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel);

      const res = await get(`/videos/${video.public_id}/download`).expect(302);

      expect(res.headers['cache-control']).toBe('no-store');
      const file = await fetch(res.headers['location']);
      expect(file.status).toBe(200);
      const disposition = file.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('filename="My Clip.mp4"');
      expect(Buffer.from(await file.arrayBuffer()).equals(OBJECT_BYTES)).toBe(
        true,
      );
    });

    it('returns 404 for a video that is not ready', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel, { status: VideoStatus.ERROR });

      await get(`/videos/${video.public_id}/download`).expect(404);
    });
  });

  describe('GET /videos/:publicId/thumbnail', () => {
    it('returns 302 to the thumbnail of a ready video', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel);

      const res = await get(`/videos/${video.public_id}/thumbnail`).expect(302);

      const image = await fetch(res.headers['location']);
      expect(image.status).toBe(200);
      expect(await image.text()).toBe('jpeg');
    });

    it('returns 404 when the video has no thumbnail', async () => {
      const { channel } = await createOwner();
      const video = await seedVideo(channel, { thumbnail_key: null });

      const res = await get(`/videos/${video.public_id}/thumbnail`).expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/status', () => {
    it('returns the status and the error reason to the owner in any state', async () => {
      const { channel, token } = await createOwner();
      const failed = await seedVideo(channel, {
        status: VideoStatus.ERROR,
        error_reason: 'invalid_media',
        duration_seconds: null,
      });
      const processing = await seedVideo(channel, {
        status: VideoStatus.PROCESSING,
      });

      const failedRes = await get(
        `/videos/${failed.public_id}/status`,
        token,
      ).expect(200);
      const processingRes = await get(
        `/videos/${processing.public_id}/status`,
        token,
      ).expect(200);

      expect(bodyOf<StatusBody>(failedRes)).toMatchObject({
        status: 'error',
        error_reason: 'invalid_media',
      });
      expect(bodyOf<StatusBody>(processingRes).status).toBe('processing');
    });

    it('returns 404 to another user and 401 without a token', async () => {
      const owner = await createOwner();
      const stranger = await createOwner();
      const video = await seedVideo(owner.channel);

      const foreign = await get(
        `/videos/${video.public_id}/status`,
        stranger.token,
      ).expect(404);
      await get(`/videos/${video.public_id}/status`).expect(401);

      expect(bodyOf<ErrorBody>(foreign).error).toBe('VIDEO_NOT_FOUND');
    });

    it('does not throttle the owner polling the status', async () => {
      const { channel, token } = await createOwner();
      const video = await seedVideo(channel, {
        status: VideoStatus.PROCESSING,
      });

      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        statuses.push(
          (await get(`/videos/${video.public_id}/status`, token)).status,
        );
      }

      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });
});
