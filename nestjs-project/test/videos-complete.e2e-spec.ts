import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
import { VIDEO_QUEUE } from '../src/videos/videos.constants';

interface DraftBody {
  public_id: string;
}

interface UploadUrlsBody {
  urls: { url: string }[];
}

interface CompleteBody {
  public_id: string;
  status: string;
}

interface ErrorBody {
  error: string;
}

const bodyOf = <T>(res: request.Response): T => res.body as T;

describe('Videos complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // The signed URLs must be reachable from inside the Compose network.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // Separate keyspace: the running video-worker must not consume test jobs.
    process.env.QUEUE_PREFIX = 'bull-test';

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE), {
      strict: false,
    });
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
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
  async function createAuthenticatedUser(): Promise<string> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_complete_e2e_${n}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_complete_e2e_chan_${n}`,
        user_id: user.id,
      }),
    );
    return jwtService.signAsync({ sub: user.id, email: user.email });
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Starts an upload declaring `declared` bytes and PUTs `sent` bytes. */
  async function uploadOnePart(
    token: string,
    declared: number,
    sent: number,
  ): Promise<{ publicId: string; etag: string }> {
    const started = await request(app.getHttpServer())
      .post('/videos')
      .set(auth(token))
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: declared,
      })
      .expect(201);
    const publicId = bodyOf<DraftBody>(started).public_id;

    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload-urls`)
      .set(auth(token))
      .send({ part_numbers: [1] })
      .expect(200);
    const put = await fetch(bodyOf<UploadUrlsBody>(signed).urls[0].url, {
      method: 'PUT',
      body: Buffer.alloc(sent, 9),
    });
    expect(put.status).toBe(200);
    return { publicId, etag: put.headers.get('etag') ?? '' };
  }

  const complete = (token: string, publicId: string, body: object) =>
    request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .set(auth(token))
      .send(body);

  it('returns 202 with processing, persists the transition and queues the job', async () => {
    const token = await createAuthenticatedUser();
    const { publicId, etag } = await uploadOnePart(token, 2048, 2048);

    const res = await complete(token, publicId, {
      parts: [{ part_number: 1, etag }],
    }).expect(202);

    const body = bodyOf<CompleteBody>(res);
    expect(body).toEqual({ public_id: publicId, status: 'processing' });
    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    expect(saved.status).toBe(VideoStatus.PROCESSING);
    expect(saved.upload_id).toBeNull();
    expect(await queue.getJob(`video-${saved.id}`)).toBeDefined();
  });

  it('returns 409 VIDEO_NOT_UPLOADABLE when completing a second time', async () => {
    const token = await createAuthenticatedUser();
    const { publicId, etag } = await uploadOnePart(token, 2048, 2048);
    const parts = { parts: [{ part_number: 1, etag }] };
    await complete(token, publicId, parts).expect(202);

    const res = await complete(token, publicId, parts).expect(409);

    expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_UPLOADABLE');
  });

  it('returns 409 UPLOAD_INCOMPLETE when a part is missing', async () => {
    const token = await createAuthenticatedUser();
    const { publicId } = await uploadOnePart(token, 2048, 2048);

    const res = await complete(token, publicId, {
      parts: [
        { part_number: 1, etag: '"a"' },
        { part_number: 2, etag: '"b"' },
      ],
    }).expect(409);

    expect(bodyOf<ErrorBody>(res).error).toBe('UPLOAD_INCOMPLETE');
  });

  it('returns 422 UPLOAD_SIZE_MISMATCH and fails the video when the stored size differs', async () => {
    const token = await createAuthenticatedUser();
    const { publicId, etag } = await uploadOnePart(token, 2048, 1024);

    const res = await complete(token, publicId, {
      parts: [{ part_number: 1, etag }],
    }).expect(422);

    expect(bodyOf<ErrorBody>(res).error).toBe('UPLOAD_SIZE_MISMATCH');
    const saved = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    expect(saved.status).toBe(VideoStatus.ERROR);
    expect(saved.error_reason).toBe('upload_size_mismatch');
  });

  it('returns 404 for another user, 401 without a token and 400 for a bad body', async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const { publicId, etag } = await uploadOnePart(owner, 2048, 2048);
    const parts = { parts: [{ part_number: 1, etag }] };

    const foreign = await complete(stranger, publicId, parts);
    await request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .send(parts)
      .expect(401);
    const empty = await complete(owner, publicId, { parts: [] });
    const malformed = await complete(owner, publicId, {
      parts: [{ part_number: 0, etag: '' }],
    });

    expect(foreign.status).toBe(404);
    expect(bodyOf<ErrorBody>(foreign).error).toBe('VIDEO_NOT_FOUND');
    expect(empty.status).toBe(400);
    expect(bodyOf<ErrorBody>(empty).error).toBe('VALIDATION_ERROR');
    expect(malformed.status).toBe(400);
    expect(bodyOf<ErrorBody>(malformed).error).toBe('VALIDATION_ERROR');
  });
});
