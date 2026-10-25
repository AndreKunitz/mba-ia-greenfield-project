import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_STATUS_ENUM_NAME } from '../videos.constants';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

// bigint and numeric columns come back from PostgreSQL as strings.
const numberTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
@Index(['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: numberTransformer })
  size_bytes: number;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: VIDEO_STATUS_ENUM_NAME,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'text', nullable: true })
  error_reason: string | null;

  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true })
  processing_started_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
