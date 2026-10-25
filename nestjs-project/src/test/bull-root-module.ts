import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

export const TEST_QUEUE_PREFIX = 'bull-test';

/** Redis connection for test modules; needs `queueConfig` loaded globally. */
export const bullRootForTests = () =>
  BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (queue: ConfigType<typeof queueConfig>) => ({
      connection: { host: queue.host, port: queue.port },
      // Separate keyspace: the running video-worker must not consume test jobs.
      prefix: TEST_QUEUE_PREFIX,
    }),
  });
