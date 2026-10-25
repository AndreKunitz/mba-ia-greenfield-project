import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
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

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // Tests run inside the Compose network, where the browser-facing address
    // is not reachable; host selection is covered by the storage unit test.
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
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    const pending = await videoRepository.find();
    for (const video of pending) {
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
        email: `videos_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos_svc_chan_${n}`,
        user_id: user.id,
      }),
    );
    return user;
  }

  const dto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 2048,
  };

  it('should persist the draft and create the multipart upload in the storage', async () => {
    const user = await createUserWithChannel();

    const result = await service.createDraft(user.id, dto);

    const saved = await videoRepository.findOneByOrFail({
      public_id: result.public_id,
    });
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.title).toBe('clip.mp4');
    expect(saved.size_bytes).toBe(2048);
    expect(saved.part_count).toBe(1);
    expect(saved.upload_id).toBeTruthy();
    expect(saved.storage_key).toMatch(/^videos\/[0-9a-f-]{36}\/source\.mp4$/);
    const channel = await channelRepository.findOneByOrFail({
      user_id: user.id,
    });
    expect(saved.channel_id).toBe(channel.id);
    await expect(
      storage.listParts(saved.storage_key, saved.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should report an uploaded part in the upload state', async () => {
    const user = await createUserWithChannel();
    const { public_id } = await service.createDraft(user.id, dto);
    const { urls } = await service.signUploadParts(user.id, public_id, {
      part_numbers: [1],
    });

    const put = await fetch(urls[0].url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 7),
    });
    expect(put.status).toBe(200);

    const state = await service.getUploadState(user.id, public_id);
    expect(state.uploaded_parts).toHaveLength(1);
    expect(state.uploaded_parts[0].part_number).toBe(1);
    expect(state.uploaded_parts[0].size_bytes).toBe(1024);
  });

  it('should sign part URLs with the storage endpoint host', async () => {
    const user = await createUserWithChannel();
    const { public_id } = await service.createDraft(user.id, dto);

    const { urls, expires_in_seconds } = await service.signUploadParts(
      user.id,
      public_id,
      { part_numbers: [1] },
    );

    expect(new URL(urls[0].url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    expect(expires_in_seconds).toBe(900);
  });

  it('should hide a video from a user that does not own it', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const { public_id } = await service.createDraft(owner.id, dto);

    await expect(
      service.getUploadState(stranger.id, public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    await expect(
      service.signUploadParts(stranger.id, public_id, { part_numbers: [1] }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
