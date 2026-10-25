import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { httpStatusOf, isStorageClientError } from './storage.errors';
import {
  CORS_ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import type {
  CompletedPart,
  ObjectInfo,
  PresignGetOptions,
  UploadedPart,
} from './storage.types';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    await this.run(async () => {
      try {
        await this.internalClient.send(new HeadBucketCommand({ Bucket }));
      } catch (error) {
        if (httpStatusOf(error) !== 404) throw error;
        await this.internalClient.send(new CreateBucketCommand({ Bucket }));
      }
      await this.internalClient.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: this.config.corsAllowedOrigins,
                AllowedMethods: [...CORS_ALLOWED_METHODS],
                AllowedHeaders: ['*'],
                ExposeHeaders: [...CORS_EXPOSED_HEADERS],
                MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
              },
            ],
          },
        }),
      );
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    return this.run(async () => {
      const response = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!response.UploadId) throw new StorageUnavailableException();
      return response.UploadId;
    });
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    return this.run(async () => {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            sizeBytes: part.Size ?? 0,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.run(async () => {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    });
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.run(async () => {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    });
  }

  async headObject(key: string): Promise<ObjectInfo> {
    return this.run(async () => {
      const response = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType,
      };
    });
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  async presignGetObjectInternal(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.run(async () => {
      await this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.run(async () => {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    });
  }

  /**
   * 4xx answers are business outcomes the caller must interpret (missing
   * object, unknown upload, invalid part) and propagate untouched. Anything
   * else (connection refused, timeout, 5xx) means the storage is unavailable.
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StorageUnavailableException) throw error;
      if (isStorageClientError(error)) throw error;
      this.logger.warn(
        `Storage call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new StorageUnavailableException();
    }
  }
}
