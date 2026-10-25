import { ApiProperty } from '@nestjs/swagger';

export class SignedPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    example:
      'http://localhost:8333/streamtube-videos/videos/.../source.mp4?...',
    description: 'Signed URL to send the part to with an HTTP PUT',
  })
  url: string;
}

export class UploadUrlsResponseDto {
  @ApiProperty({ example: 900 })
  expires_in_seconds: number;

  @ApiProperty({ type: [SignedPartUrlDto] })
  urls: SignedPartUrlDto[];
}
