import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Part number, starting at 1. */
  @IsInt()
  @Min(1)
  part_number: number;

  /** The `ETag` header the storage returned for this part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every part of the upload with the ETag returned by the storage. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique((part: CompletedPartDto) => part.part_number)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
