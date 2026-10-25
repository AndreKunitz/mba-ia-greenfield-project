import { Injectable, type PipeTransform } from '@nestjs/common';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { PUBLIC_ID_PATTERN } from './videos.constants';

/**
 * A value that cannot be a public id answers 404, not 400: from the outside a
 * malformed id and an unknown id must look the same.
 */
@Injectable()
export class PublicIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!PUBLIC_ID_PATTERN.test(value)) throw new VideoNotFoundException();
    return value;
  }
}
