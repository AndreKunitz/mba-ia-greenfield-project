import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Repository } from 'typeorm';
import { isUniqueViolationOnColumn } from '../common/database/unique-violation.util';
import {
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotUploadableException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { isStorageClientError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { PublicVideoResponseDto } from './dto/public-video-response.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { UploadStateResponseDto } from './dto/upload-state-response.dto';
import { UploadUrlsResponseDto } from './dto/upload-urls-response.dto';
import { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { buildContentDisposition } from './content-disposition.util';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoQueueProducer } from './video-queue.producer';
import {
  CONTENT_TYPE_EXTENSIONS,
  MAX_PUBLIC_ID_ATTEMPTS,
  PUBLIC_ID_COLUMN,
  S3_MAX_PARTS,
} from './videos.constants';

interface UploadableVideo {
  video: Video;
  uploadId: string;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly videoQueueProducer: VideoQueueProducer,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const extension = this.validateFormat(dto);
    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Registration always creates the channel (1:1); reaching this is a bug.
      throw new Error(`User ${userId} has no channel`);
    }

    // The part size grows if needed so the upload never exceeds the S3 limit
    // of 10,000 parts.
    const partSizeBytes = Math.max(
      this.config.partSizeBytes,
      Math.ceil(dto.size_bytes / S3_MAX_PARTS),
    );
    const partCount = Math.ceil(dto.size_bytes / partSizeBytes);

    const id = randomUUID();
    const storageKey = `videos/${id}/source${extension}`;
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    const video = await this.insertDraft(
      {
        id,
        channel_id: channel.id,
        title: dto.filename,
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
        part_size_bytes: partSizeBytes,
        part_count: partCount,
      },
      storageKey,
      uploadId,
    );

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      part_size_bytes: video.part_size_bytes,
      part_count: video.part_count,
      created_at: video.created_at,
    };
  }

  async getUploadState(
    userId: string,
    publicId: string,
  ): Promise<UploadStateResponseDto> {
    const { video, uploadId } = await this.findUploadableVideo(
      userId,
      publicId,
    );

    const parts = await this.storageService.listParts(
      video.storage_key,
      uploadId,
    );

    return {
      public_id: video.public_id,
      status: video.status,
      part_size_bytes: video.part_size_bytes,
      part_count: video.part_count,
      uploaded_parts: parts.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size_bytes: part.sizeBytes,
      })),
    };
  }

  async signUploadParts(
    userId: string,
    publicId: string,
    dto: SignUploadPartsDto,
  ): Promise<UploadUrlsResponseDto> {
    const { video, uploadId } = await this.findUploadableVideo(
      userId,
      publicId,
    );

    const outOfRange = dto.part_numbers.filter(
      (partNumber) => partNumber > video.part_count,
    );
    if (outOfRange.length > 0) {
      throw new InvalidUploadPartsException(
        `part_numbers must be between 1 and ${video.part_count}`,
      );
    }

    const expiresInSeconds = this.config.uploadUrlTtlSeconds;
    const urls = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          expiresInSeconds,
        ),
      })),
    );

    return { expires_in_seconds: expiresInSeconds, urls };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const { video, uploadId } = await this.findUploadableVideo(
      userId,
      publicId,
    );
    this.assertAllPartsPresent(video, dto);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      // The storage refuses the call when a part is missing, out of order or
      // with a different ETag; that is the client's incomplete upload.
      if (isStorageClientError(error)) throw new UploadIncompleteException();
      throw error;
    }

    const stored = await this.storageService.headObject(video.storage_key);
    if (stored.sizeBytes !== video.size_bytes) {
      await this.failUpload(video, 'upload_size_mismatch');
      throw new UploadSizeMismatchException();
    }

    // Conditional on the draft state so concurrent calls transition only once.
    const transition = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        processing_started_at: new Date(),
        upload_id: null,
      },
    );
    if (transition.affected === 0) throw new VideoNotUploadableException();

    await this.enqueueOrLeaveToReconciliation(video.id);

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  private assertAllPartsPresent(video: Video, dto: CompleteUploadDto): void {
    const sent = new Set(dto.parts.map((part) => part.part_number));
    const isComplete =
      dto.parts.length === video.part_count &&
      Array.from({ length: video.part_count }, (_, i) => i + 1).every(
        (partNumber) => sent.has(partNumber),
      );
    if (!isComplete) throw new UploadIncompleteException();
  }

  private async failUpload(video: Video, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.ERROR, error_reason: reason, upload_id: null },
    );
    // Best effort: the state already says the upload failed.
    try {
      await this.storageService.deleteObject(video.storage_key);
    } catch (error) {
      this.logger.warn(
        `Could not delete object ${video.storage_key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // The video is already `processing`; if the queue is down the reconciliation
  // job picks it up, so the client still gets its answer.
  private async enqueueOrLeaveToReconciliation(videoId: string): Promise<void> {
    try {
      await this.videoQueueProducer.enqueueProcessing(videoId);
    } catch (error) {
      this.logger.warn(
        `Could not enqueue video ${videoId}; reconciliation will retry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getPublicVideo(publicId: string): Promise<PublicVideoResponseDto> {
    const video = await this.findReadyVideo(publicId);
    return {
      public_id: video.public_id,
      title: video.title,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata ?? {},
      created_at: video.created_at,
    };
  }

  async getOwnerStatus(
    userId: string,
    publicId: string,
  ): Promise<VideoStatusResponseDto> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();

    return {
      public_id: video.public_id,
      status: video.status,
      error_reason: video.error_reason,
      duration_seconds: video.duration_seconds,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }

  /** The storage serves the bytes (and the `Range` requests) behind this URL. */
  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReadyVideo(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      expiresInSeconds: this.config.urlTtlSeconds,
    });
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyVideo(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      expiresInSeconds: this.config.urlTtlSeconds,
      contentDisposition: buildContentDisposition(video.original_filename),
    });
  }

  async getThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.findReadyVideo(publicId);
    if (!video.thumbnail_key) throw new VideoNotFoundException();
    return this.storageService.presignGetObject(video.thumbnail_key, {
      expiresInSeconds: this.config.urlTtlSeconds,
    });
  }

  private async findReadyVideo(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private validateFormat(dto: CreateVideoDto): string {
    if (!this.config.allowedContentTypes.includes(dto.content_type)) {
      throw new UnsupportedVideoFormatException();
    }

    const extension = extname(dto.filename).toLowerCase();
    const expected = CONTENT_TYPE_EXTENSIONS[dto.content_type];
    if (expected && !expected.includes(extension)) {
      throw new UnsupportedVideoFormatException();
    }
    return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
  }

  private async insertDraft(
    data: Partial<Video>,
    storageKey: string,
    uploadId: string,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        if (isUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) continue;
        await this.abortUploadQuietly(storageKey, uploadId);
        throw error;
      }
    }

    await this.abortUploadQuietly(storageKey, uploadId);
    throw new Error(
      `Could not generate a unique public id in ${MAX_PUBLIC_ID_ATTEMPTS} attempts`,
    );
  }

  // Best-effort cleanup while another error is already being propagated.
  private async abortUploadQuietly(
    storageKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
    } catch (error) {
      this.logger.warn(
        `Could not abort multipart upload ${uploadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async findUploadableVideo(
    userId: string,
    publicId: string,
  ): Promise<UploadableVideo> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException();
    }
    return { video, uploadId: video.upload_id };
  }
}
