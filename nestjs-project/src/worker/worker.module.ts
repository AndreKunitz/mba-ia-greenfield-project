import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoQueueProducer } from '../videos/video-queue.producer';
import { VideoReconciliationService } from '../videos/video-reconciliation.service';
import { VIDEO_QUEUE } from '../videos/videos.constants';
import { MediaProbeService } from './media-probe.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ThumbnailService } from './thumbnail.service';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig, videosConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: db.host,
        port: db.port,
        username: db.username,
        password: db.password,
        database: db.name,
        // The worker has no HTTP modules to register entities; Video needs its
        // Channel and User relations in the metadata even if it never reads them.
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.host, port: queue.port },
        prefix: queue.prefix,
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    StorageModule,
  ],
  providers: [
    VideoProcessor,
    MediaProbeService,
    ThumbnailService,
    VideoQueueProducer,
    VideoReconciliationService,
    ReconciliationScheduler,
  ],
})
export class WorkerModule {}
