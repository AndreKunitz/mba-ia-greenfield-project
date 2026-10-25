import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { isStorageClientError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoQueueProducer } from './video-queue.producer';
import { RECONCILE_BATCH_SIZE } from './videos.constants';

const UPLOAD_ABANDONED_REASON = 'upload_abandoned';
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;

export interface ReconciliationResult {
  requeued: number;
  abandoned: number;
}

/**
 * Runs inside the worker on a schedule. It is a background task: a failure on
 * one video is logged and the next video is still handled, because rethrowing
 * would drop the rest of the batch until the next round.
 */
@Injectable()
export class VideoReconciliationService {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoQueueProducer: VideoQueueProducer,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async reconcile(): Promise<ReconciliationResult> {
    const requeued = await this.requeueStaleProcessing();
    const abandoned = await this.abortAbandonedUploads();
    if (requeued > 0 || abandoned > 0) {
      this.logger.log(
        `Reconciliation: ${requeued} video(s) requeued, ${abandoned} abandoned upload(s) closed`,
      );
    }
    return { requeued, abandoned };
  }

  /** Videos in `processing` for too long without a job in flight. */
  async requeueStaleProcessing(): Promise<number> {
    const threshold = new Date(
      Date.now() - this.config.processingStaleSeconds * MS_PER_SECOND,
    );
    const stale = await this.videoRepository.find({
      where: {
        status: VideoStatus.PROCESSING,
        processing_started_at: LessThan(threshold),
      },
      order: { processing_started_at: 'ASC' },
      take: RECONCILE_BATCH_SIZE,
    });

    let requeued = 0;
    for (const video of stale) {
      try {
        await this.videoQueueProducer.reenqueueProcessing(video.id);
        requeued++;
      } catch (error) {
        this.logger.warn(
          `Could not requeue video ${video.id}: ${this.describe(error)}`,
        );
      }
    }
    return requeued;
  }

  /** Drafts that nobody finished: free the multipart and close the video. */
  async abortAbandonedUploads(): Promise<number> {
    const threshold = new Date(
      Date.now() - this.config.uploadTtlHours * MS_PER_HOUR,
    );
    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(threshold) },
      order: { created_at: 'ASC' },
      take: RECONCILE_BATCH_SIZE,
    });

    let closed = 0;
    for (const video of abandoned) {
      try {
        if (video.upload_id) await this.abortInStorage(video);
        await this.videoRepository.update(
          { id: video.id, status: VideoStatus.DRAFT },
          {
            status: VideoStatus.ERROR,
            error_reason: UPLOAD_ABANDONED_REASON,
            upload_id: null,
          },
        );
        closed++;
      } catch (error) {
        // Storage unavailable: leave the draft as it is for the next round.
        this.logger.warn(
          `Could not close abandoned upload ${video.id}: ${this.describe(error)}`,
        );
      }
    }
    return closed;
  }

  private async abortInStorage(video: Video): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id as string,
      );
    } catch (error) {
      // A 4xx (for example NoSuchUpload) means the multipart is already gone.
      if (!isStorageClientError(error)) throw error;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
