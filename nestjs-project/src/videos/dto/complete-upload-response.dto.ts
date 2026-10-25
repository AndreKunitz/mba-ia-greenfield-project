import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
