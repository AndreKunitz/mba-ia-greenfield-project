import { ApiProperty } from '@nestjs/swagger';

export class PublicVideoResponseDto {
  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({ example: 'clip.mp4' })
  title: string;

  @ApiProperty({
    nullable: true,
    example: 12.345,
    description: 'Duration in seconds; null if the file did not report one',
  })
  duration_seconds: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Summary of what ffprobe found: format, codecs, resolution',
  })
  metadata: Record<string, unknown>;

  @ApiProperty({ example: '2026-10-25T18:00:00.000Z' })
  created_at: Date;
}
