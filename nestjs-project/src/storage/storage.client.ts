import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';

type StorageConfig = ConfigType<typeof storageConfig>;

/**
 * Checksums are only calculated when the operation requires them: recent SDK
 * versions add CRC32 headers by default, and S3-compatible servers that are
 * not AWS may reject the signed checksum headers.
 */
export function createS3Client(
  config: StorageConfig,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
