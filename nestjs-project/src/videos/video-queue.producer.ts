import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videosConfig from '../config/videos.config';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_QUEUE,
} from './videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueProducer {
  constructor(
    @InjectQueue(VIDEO_QUEUE) private readonly queue: Queue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /**
   * The job id makes the call idempotent: BullMQ ignores a job whose id already
   * exists, so re-enqueueing the same video never duplicates work.
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    const data: ProcessVideoJobData = { videoId };
    await this.withTimeout(
      this.queue.add(PROCESS_VIDEO_JOB, data, {
        jobId: `video-${videoId}`,
        attempts: this.config.jobAttempts,
        backoff: { type: 'exponential', delay: this.config.jobBackoffMs },
      }),
    );
  }

  /**
   * For videos the reconciliation found stuck in `processing`. BullMQ keeps
   * finished jobs and ignores an `add` whose id still exists, so a finished
   * job is removed first; a job still in flight (waiting, delayed, active)
   * is left alone, which is the very duplicate-protection the id provides.
   */
  async reenqueueProcessing(videoId: string): Promise<void> {
    const existing = await this.withTimeout(
      this.queue.getJob(`video-${videoId}`),
    );
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await existing.remove();
    }
    await this.enqueueProcessing(videoId);
  }

  // With Redis down, BullMQ keeps waiting for the connection instead of failing.
  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Queue did not answer within ${ENQUEUE_TIMEOUT_MS}ms`),
          ),
        ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
