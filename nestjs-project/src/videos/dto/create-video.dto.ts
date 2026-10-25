import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class CreateVideoDto {
  /** Original file name, including its extension. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** MIME type declared by the client; must be in the allowed list. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  content_type: string;

  /** File size in bytes, up to the configured maximum (10 GiB by default). */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
