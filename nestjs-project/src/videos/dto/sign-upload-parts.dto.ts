import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { S3_MAX_PARTS } from '../videos.constants';

export class SignUploadPartsDto {
  /** Part numbers to sign, each between 1 and the video's `part_count`. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(S3_MAX_PARTS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
