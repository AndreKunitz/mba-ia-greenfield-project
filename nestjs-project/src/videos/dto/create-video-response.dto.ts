import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CreateVideoResponseDto {
  @ApiProperty({ example: 'aB3dE5gH7jK', description: 'Public video id' })
  public_id: string;

  @ApiProperty({ example: 'clip.mp4', description: 'Provisional title' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({ example: '2026-10-25T18:00:00.000Z' })
  created_at: Date;
}
