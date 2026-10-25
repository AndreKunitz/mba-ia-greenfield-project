import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
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

const GIB = 1024 * 1024 * 1024;

interface DraftBody {
  public_id: string;
  title: string;
  status: string;
  part_size_bytes: number;
  part_count: number;
}

interface UploadStateBody {
  status: string;
  part_count: number;
  uploaded_parts: unknown[];
}

interface UploadUrlsBody {
  expires_in_seconds: number;
  urls: { part_number: number; url: string }[];
}

interface ErrorBody {
  error: string;
}

const bodyOf = <T>(res: request.Response): T => res.body as T;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
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
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    for (const video of await videoRepository.find()) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(video.storage_key, video.upload_id);
      }
    }
  });

  let counter = 0;
  async function createAuthenticatedUser(): Promise<{
    user: User;
    token: string;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_e2e_${n}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_e2e_chan_${n}`,
        user_id: user.id,
      }),
    );
    const token = await jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });
    return { user, token };
  }

  const validBody = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1048576,
  };

  const startUpload = (token: string, body: object = validBody) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function startDraft(token: string): Promise<string> {
    const res = await startUpload(token).expect(201);
    return bodyOf<DraftBody>(res).public_id;
  }

  describe('POST /videos', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('returns 201 with the draft and stores it in the owner channel', async () => {
      const { user, token } = await createAuthenticatedUser();

      const res = await startUpload(token).expect(201);

      const body = bodyOf<DraftBody>(res);
      expect(body.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(body.status).toBe('draft');
      expect(body.title).toBe('clip.mp4');
      expect(body.part_count).toBe(1);
      const saved = await videoRepository.findOneByOrFail({
        public_id: body.public_id,
      });
      const channel = await channelRepository.findOneByOrFail({
        user_id: user.id,
      });
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe(channel.id);
      expect(saved.upload_id).toBeTruthy();
    });

    it('keeps throttling draft creation: the 11th request in a minute gets 429', async () => {
      const { token } = await createAuthenticatedUser();

      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        // An invalid body keeps the test off the storage; the throttler
        // counts the request before the validation runs.
        statuses.push((await startUpload(token, {})).status);
      }

      expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(
        true,
      );
      expect(statuses[10]).toBe(429);
    });

    it('returns 160 parts for a 10 GiB file', async () => {
      const { token } = await createAuthenticatedUser();

      const res = await startUpload(token, {
        ...validBody,
        size_bytes: 10 * GIB,
      }).expect(201);

      const body = bodyOf<DraftBody>(res);
      expect(body.part_count).toBe(160);
      expect(body.part_size_bytes).toBe(64 * 1024 * 1024);
    });

    it('returns 413 VIDEO_TOO_LARGE above the maximum size', async () => {
      const { token } = await createAuthenticatedUser();

      const res = await startUpload(token, {
        ...validBody,
        size_bytes: 10 * GIB + 1,
      }).expect(413);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_TOO_LARGE');
    });

    it('returns 400 UNSUPPORTED_VIDEO_FORMAT for a content type outside the list', async () => {
      const { token } = await createAuthenticatedUser();

      const res = await startUpload(token, {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      }).expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('UNSUPPORTED_VIDEO_FORMAT');
    });

    it('returns 400 VALIDATION_ERROR for an invalid body', async () => {
      const { token } = await createAuthenticatedUser();

      const zero = await startUpload(token, {
        ...validBody,
        size_bytes: 0,
      }).expect(400);
      const unknownField = await startUpload(token, {
        ...validBody,
        extra: true,
      }).expect(400);

      expect(bodyOf<ErrorBody>(zero).error).toBe('VALIDATION_ERROR');
      expect(bodyOf<ErrorBody>(unknownField).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /videos/:publicId/upload', () => {
    it('returns 200 with no uploaded parts right after the draft', async () => {
      const { token } = await createAuthenticatedUser();
      const publicId = await startDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = bodyOf<UploadStateBody>(res);
      expect(body.status).toBe('draft');
      expect(body.part_count).toBe(1);
      expect(body.uploaded_parts).toEqual([]);
    });

    it('returns 404 VIDEO_NOT_FOUND for another user', async () => {
      const owner = await createAuthenticatedUser();
      const stranger = await createAuthenticatedUser();
      const publicId = await startDraft(owner.token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 for an unknown or malformed id and 401 without a token', async () => {
      const { token } = await createAuthenticatedUser();

      await request(app.getHttpServer())
        .get('/videos/not-a-video/upload')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(app.getHttpServer())
        .get('/videos/aB3dE5gH7jK/upload')
        .expect(401);
    });
  });

  describe('POST /videos/:publicId/upload-urls', () => {
    const signParts = (token: string, publicId: string, body: object) =>
      request(app.getHttpServer())
        .post(`/videos/${publicId}/upload-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('returns 200 with a signed URL on the storage public endpoint', async () => {
      const { token } = await createAuthenticatedUser();
      const publicId = await startDraft(token);

      const res = await signParts(token, publicId, {
        part_numbers: [1],
      }).expect(200);

      const body = bodyOf<UploadUrlsBody>(res);
      expect(body.expires_in_seconds).toBe(900);
      expect(body.urls).toHaveLength(1);
      expect(body.urls[0].part_number).toBe(1);
      expect(new URL(body.urls[0].url).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );
    });

    it('returns 400 VALIDATION_ERROR for part numbers that are invalid', async () => {
      const { token } = await createAuthenticatedUser();
      const publicId = await startDraft(token);

      const zero = await signParts(token, publicId, { part_numbers: [0] });
      const duplicated = await signParts(token, publicId, {
        part_numbers: [1, 1],
      });
      const beyondCount = await signParts(token, publicId, {
        part_numbers: [2],
      });

      for (const res of [zero, duplicated, beyondCount]) {
        expect(res.status).toBe(400);
        expect(bodyOf<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
      }
    });

    it('returns 404 for another user and 409 once the video left the draft state', async () => {
      const owner = await createAuthenticatedUser();
      const stranger = await createAuthenticatedUser();
      const publicId = await startDraft(owner.token);

      const foreign = await signParts(stranger.token, publicId, {
        part_numbers: [1],
      });
      await videoRepository.update(
        { public_id: publicId },
        { status: VideoStatus.PROCESSING },
      );
      const notDraft = await signParts(owner.token, publicId, {
        part_numbers: [1],
      });

      expect(foreign.status).toBe(404);
      expect(bodyOf<ErrorBody>(foreign).error).toBe('VIDEO_NOT_FOUND');
      expect(notDraft.status).toBe(409);
      expect(bodyOf<ErrorBody>(notDraft).error).toBe('VIDEO_NOT_UPLOADABLE');
    });
  });
});
