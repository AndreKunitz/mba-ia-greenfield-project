import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class UploadStateResponseDto {
  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
