import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoStatusResponseDto {
  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'invalid_media',
    description: 'Why the video is in error; null otherwise',
  })
  error_reason: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 12.345,
    description: 'Known once the video was processed',
  })
  duration_seconds: number | null;

  @ApiProperty({ example: '2026-10-25T18:00:00.000Z' })
  created_at: Date;

  @ApiProperty({ example: '2026-10-25T18:05:00.000Z' })
  updated_at: Date;
}
