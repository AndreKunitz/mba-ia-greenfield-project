import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-queue.producer';
import { VideoReconciliationService } from '../videos/video-reconciliation.service';
import {
  PROCESS_VIDEO_JOB,
  RECONCILE_VIDEOS_JOB,
  VIDEO_QUEUE,
} from '../videos/videos.constants';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService, type ProbeResult } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';

const INVALID_MEDIA_REASON = 'invalid_media';
const PROCESSING_FAILED_REASON = 'processing_failed';

@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    private readonly thumbnailService: ThumbnailService,
    private readonly reconciliationService: VideoReconciliationService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        await this.processVideo(job.data.videoId);
        return;
      case RECONCILE_VIDEOS_JOB:
        await this.reconciliationService.reconcile();
        return;
      default:
        throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Runs once the retries are over: the video then goes to `error`. The
   * conditional update leaves alone a video that already reached a final state
   * (for example `invalid_media`, written before the unrecoverable failure).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) return;

    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.warn(
      `Job ${String(job.id)} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
    );
    const isFinal =
      error instanceof UnrecoverableError || job.attemptsMade >= maxAttempts;
    if (!isFinal) return;

    // Background context: nobody awaits this handler, so failures are logged.
    try {
      await this.videoRepository.update(
        {
          id: (job.data as ProcessVideoJobData).videoId,
          status: VideoStatus.PROCESSING,
        },
        { status: VideoStatus.ERROR, error_reason: PROCESSING_FAILED_REASON },
      );
    } catch (updateError) {
      this.logger.error(
        `Could not record the failure of job ${String(job.id)}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
      );
    }
  }

  private async processVideo(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found; nothing to process`);
      return;
    }
    // Idempotent: a duplicated or late job finds the work already done.
    if (video.status !== VideoStatus.PROCESSING) return;

    // FFmpeg reads the object by ranges through a signed URL on the internal
    // endpoint, so a 10GB file is never downloaded to the worker.
    const url = await this.storageService.presignGetObjectInternal(
      video.storage_key,
      this.config.urlTtlSeconds,
    );

    const probe = await this.probeOrFailPermanently(video, url);
    const thumbnail = await this.thumbnailService.generate(
      url,
      probe.durationSeconds,
    );
    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: probe.durationSeconds,
        // TypeORM's update typing rejects plain objects for jsonb columns.
        metadata: probe.metadata as QueryDeepPartialEntity<Video>['metadata'],
        thumbnail_key: thumbnailKey,
        error_reason: null,
      },
    );
  }

  private async probeOrFailPermanently(
    video: Video,
    url: string,
  ): Promise<ProbeResult> {
    try {
      return await this.mediaProbeService.probe(url);
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        await this.videoRepository.update(
          { id: video.id, status: VideoStatus.PROCESSING },
          { status: VideoStatus.ERROR, error_reason: INVALID_MEDIA_REASON },
        );
        // No retry: the content will not become a video by waiting.
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
