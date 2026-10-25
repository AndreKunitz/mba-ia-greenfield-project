import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosModule', () => {
  it('should compile and resolve the controller, service and queue producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosController)).toBeInstanceOf(VideosController);
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(VideoQueueProducer)).toBeInstanceOf(VideoQueueProducer);
    await module.close();
  }, 30000);
});
