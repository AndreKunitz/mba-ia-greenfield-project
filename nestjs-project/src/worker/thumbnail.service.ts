import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describeToolFailure } from './media.errors';

const execFileAsync = promisify(execFile);

const THUMBNAIL_TIMEOUT_MS = 60_000;
// Implementation choice, not a project decision: a frame at 10% of the video
// is usually past the intro and never beyond the end.
const THUMBNAIL_POSITION = 0.1;
const THUMBNAIL_MAX_WIDTH = 1280;

@Injectable()
export class ThumbnailService {
  /** Extracts one JPEG frame; `input` is a file path or an HTTP(S) URL. */
  async generate(
    input: string,
    durationSeconds: number | null,
  ): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), 'thumbnail-'));
    const output = join(directory, 'thumbnail.jpg');
    const seekSeconds = durationSeconds
      ? Math.max(0, durationSeconds * THUMBNAIL_POSITION)
      : 0;

    try {
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-v',
            'error',
            '-ss',
            seekSeconds.toFixed(3),
            '-i',
            input,
            '-frames:v',
            '1',
            '-vf',
            `scale=min(${THUMBNAIL_MAX_WIDTH}\\,iw):-2`,
            '-q:v',
            '2',
            output,
          ],
          { timeout: THUMBNAIL_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(describeToolFailure('ffmpeg', error));
      }

      const image = await readFile(output);
      if (image.length === 0) {
        throw new Error('ffmpeg produced an empty thumbnail');
      }
      return image;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
