import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

const execFileAsync = promisify(execFile);

const MIB = 1024 * 1024;
const PART_BYTES = 64 * MIB;
const PART_COUNT = 5;
const TOTAL_BYTES = PART_BYTES * PART_COUNT; // ~335 MB

interface DraftBody {
  public_id: string;
}
interface UploadUrlsBody {
  urls: { url: string }[];
}

const bodyOf = <T>(res: request.Response): T => res.body as T;

/**
 * The bytes never pass through the API: they go from a separate `curl`
 * process straight to the storage through signed URLs. While that happens the
 * API (running in this process) must keep answering and must not grow by
 * anything close to the size sent.
 */
describe('Upload responsiveness (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let workDir: string;
  let partFile: string;

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // Not the shared queue: no worker must pick this video up.
    process.env.QUEUE_PREFIX = 'bull-test';

    workDir = await mkdtemp(join(tmpdir(), 'videos-responsiveness-'));
    partFile = join(workDir, 'part.bin');
    await execFileAsync('dd', [
      'if=/dev/zero',
      `of=${partFile}`,
      'bs=1048576',
      `count=${PART_BYTES / MIB}`,
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
    storage = moduleFixture.get(StorageService, { strict: false });
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    const videos: Repository<Video> = dataSource.getRepository(Video);
    for (const video of await videos.find()) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(video.storage_key, video.upload_id);
      }
    }
    await app.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('should keep answering and not grow while ~335 MB go to the storage', async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const user = await dataSource.getRepository(User).save({
      email: 'videos_responsiveness_e2e@example.com',
      password: 'hashed',
      is_confirmed: true,
    });
    await dataSource.getRepository(Channel).save({
      name: 'Responsiveness',
      nickname: 'videos_resp_e2e_chan',
      user_id: user.id,
    });
    const token = await jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });
    const auth = { Authorization: `Bearer ${token}` };

    const draft = bodyOf<DraftBody>(
      await request(app.getHttpServer())
        .post('/videos')
        .set(auth)
        .send({
          filename: 'big.mp4',
          content_type: 'video/mp4',
          size_bytes: TOTAL_BYTES,
        })
        .expect(201),
    );
    const { urls } = bodyOf<UploadUrlsBody>(
      await request(app.getHttpServer())
        .post(`/videos/${draft.public_id}/upload-urls`)
        .set(auth)
        .send({ part_numbers: [1, 2, 3, 4, 5] })
        .expect(200),
    );

    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    let uploading = true;
    const statuses: number[] = [];

    const upload = (async () => {
      try {
        for (const { url } of urls) {
          await execFileAsync('curl', [
            '-sS',
            '--fail',
            '-X',
            'PUT',
            '-T',
            partFile,
            '-o',
            '/dev/null',
            url,
          ]);
        }
      } finally {
        uploading = false;
      }
    })();

    const probe = (async () => {
      do {
        const res = await request(app.getHttpServer()).get('/');
        statuses.push(res.status);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (uploading);
    })();

    await Promise.all([upload, probe]);

    expect(statuses.length).toBeGreaterThan(5);
    expect(statuses.every((status) => status === 200)).toBe(true);
    // Far below the ~335 MB sent: the API did not hold the upload.
    expect(rssPeak - rssBefore).toBeLessThan(TOTAL_BYTES / 4);
  }, 300_000);
});
