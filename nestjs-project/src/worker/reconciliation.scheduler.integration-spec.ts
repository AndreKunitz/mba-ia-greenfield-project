import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import { bullRootForTests } from '../test/bull-root-module';
import {
  RECONCILE_SCHEDULER_ID,
  RECONCILE_VIDEOS_JOB,
  VIDEO_QUEUE,
} from '../videos/videos.constants';
import { ReconciliationScheduler } from './reconciliation.scheduler';

describe('ReconciliationScheduler (integration)', () => {
  let module: TestingModule;
  let scheduler: ReconciliationScheduler;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        bullRootForTests(),
        BullModule.registerQueue({ name: VIDEO_QUEUE }),
      ],
      providers: [ReconciliationScheduler],
    }).compile();
    scheduler = module.get(ReconciliationScheduler);
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should register a single repeatable reconciliation schedule', async () => {
    await scheduler.register();
    await scheduler.register();

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toEqual(
      expect.objectContaining({
        key: RECONCILE_SCHEDULER_ID,
        name: RECONCILE_VIDEOS_JOB,
        every: 300_000,
      }),
    );
  });
});
