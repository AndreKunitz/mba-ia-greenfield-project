export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadedPart extends CompletedPart {
  sizeBytes: number;
}

export interface ObjectInfo {
  sizeBytes: number;
  contentType: string | undefined;
}

export interface PresignGetOptions {
  expiresInSeconds: number;
  contentDisposition?: string;
}
