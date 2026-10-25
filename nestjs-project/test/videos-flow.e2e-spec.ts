import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';

const execFileAsync = promisify(execFile);

const MIN_PART_BYTES = 5 * 1024 * 1024;
const READY_TIMEOUT_MS = 60_000;

interface DraftBody {
  public_id: string;
  part_size_bytes: number;
  part_count: number;
}
interface UploadUrlsBody {
  urls: { part_number: number; url: string }[];
}
interface StatusBody {
  status: string;
  error_reason: string | null;
  duration_seconds: number | null;
}
interface VideoBody {
  public_id: string;
  duration_seconds: number;
  metadata: Record<string, unknown>;
}

const bodyOf = <T>(res: request.Response): T => res.body as T;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uses the real infrastructure of the Compose network: API (in process),
 * database, storage, Redis and the running `video-worker` container. The queue
 * prefix is therefore the default one, shared with that worker.
 */
describe('Videos flow with the real worker (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let workDir: string;
  let filePath: string;

  beforeAll(async () => {
    // The signed URLs must be reachable from inside the Compose network.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // S3's minimum part size, so that a small file still has several parts.
    process.env.VIDEO_PART_SIZE_BYTES = String(MIN_PART_BYTES);

    workDir = await mkdtemp(join(tmpdir(), 'videos-flow-'));
    filePath = join(workDir, 'flow.mp4');
    // Noise does not compress, so a few seconds exceed two 5 MiB parts.
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=size=640x480:rate=15,geq=random(1)*255:128:128',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      filePath,
    ]);

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await app.close();
    await rm(workDir, { recursive: true, force: true });
    delete process.env.VIDEO_PART_SIZE_BYTES;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function createToken(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: 'videos_flow_e2e@example.com',
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: 'Flow',
        nickname: 'videos_flow_e2e_chan',
        user_id: user.id,
      }),
    );
    return jwtService.signAsync({ sub: user.id, email: user.email });
  }

  async function waitForTerminalStatus(
    token: string,
    publicId: string,
  ): Promise<StatusBody> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: StatusBody | undefined;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      last = bodyOf<StatusBody>(res);
      if (last.status === 'ready' || last.status === 'error') return last;
      await sleep(500);
    }
    throw new Error(`Video did not finish in time; last: ${last?.status}`);
  }

  it('should take a multipart upload to ready and serve it with ranges', async () => {
    const token = await createToken();
    const auth = { Authorization: `Bearer ${token}` };
    const content = await readFile(filePath);
    const size = (await stat(filePath)).size;
    expect(size).toBeGreaterThan(MIN_PART_BYTES * 2);

    const draft = bodyOf<DraftBody>(
      await request(app.getHttpServer())
        .post('/videos')
        .set(auth)
        .send({
          filename: 'flow.mp4',
          content_type: 'video/mp4',
          size_bytes: size,
        })
        .expect(201),
    );
    expect(draft.part_size_bytes).toBe(MIN_PART_BYTES);
    expect(draft.part_count).toBeGreaterThanOrEqual(3);

    const partNumbers = Array.from(
      { length: draft.part_count },
      (_, i) => i + 1,
    );
    const { urls } = bodyOf<UploadUrlsBody>(
      await request(app.getHttpServer())
        .post(`/videos/${draft.public_id}/upload-urls`)
        .set(auth)
        .send({ part_numbers: partNumbers })
        .expect(200),
    );

    const parts: { part_number: number; etag: string }[] = [];
    for (const { part_number, url } of urls) {
      const start = (part_number - 1) * draft.part_size_bytes;
      const body = content.subarray(start, start + draft.part_size_bytes);
      const put = await fetch(url, { method: 'PUT', body });
      expect(put.status).toBe(200);
      parts.push({ part_number, etag: put.headers.get('etag') ?? '' });
    }

    await request(app.getHttpServer())
      .post(`/videos/${draft.public_id}/complete`)
      .set(auth)
      .send({ parts })
      .expect(202);

    const finished = await waitForTerminalStatus(token, draft.public_id);
    expect(finished.error_reason).toBeNull();
    expect(finished.status).toBe('ready');
    expect(finished.duration_seconds).toBeGreaterThan(3);

    const video = bodyOf<VideoBody>(
      await request(app.getHttpServer())
        .get(`/videos/${draft.public_id}`)
        .expect(200),
    );
    expect(video.duration_seconds).toBeCloseTo(4, 0);
    expect(video.metadata).toEqual(
      expect.objectContaining({
        streams: [expect.objectContaining({ codec_name: 'h264', width: 640 })],
      }),
    );

    const thumb = await request(app.getHttpServer())
      .get(`/videos/${draft.public_id}/thumbnail`)
      .expect(302);
    const thumbnail = await fetch(thumb.headers.location);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toContain('image/jpeg');

    const stream = await request(app.getHttpServer())
      .get(`/videos/${draft.public_id}/stream`)
      .expect(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const download = await request(app.getHttpServer())
      .get(`/videos/${draft.public_id}/download`)
      .expect(302);
    expect(download.headers.location).toContain('attachment');
    const downloaded = await fetch(download.headers.location);
    expect(downloaded.status).toBe(200);
    expect((await downloaded.arrayBuffer()).byteLength).toBe(size);
  }, 120_000);
});
