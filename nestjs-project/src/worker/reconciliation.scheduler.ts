import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videosConfig from '../config/videos.config';
import {
  RECONCILE_SCHEDULER_ID,
  RECONCILE_VIDEOS_JOB,
  VIDEO_QUEUE,
} from '../videos/videos.constants';

const MS_PER_SECOND = 1000;

/**
 * Registers the repeatable reconciliation job when the worker starts. The
 * scheduler id is fixed, so every worker start updates the same schedule
 * instead of piling up new ones.
 */
@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    @InjectQueue(VIDEO_QUEUE) private readonly queue: Queue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.register();
  }

  async register(): Promise<void> {
    const everyMs = this.config.reconcileIntervalSeconds * MS_PER_SECOND;
    await this.queue.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: everyMs },
      {
        name: RECONCILE_VIDEOS_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
    this.logger.log(`Reconciliation scheduled every ${everyMs} ms`);
  }
}
