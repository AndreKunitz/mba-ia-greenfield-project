import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InvalidMediaError, describeToolFailure } from './media.errors';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// ffprobe answers with these when the content is not media, as opposed to a
// network or storage problem, which is worth retrying.
const NOT_MEDIA_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
];

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface FfprobeFormat {
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
}

@Injectable()
export class MediaProbeService {
  /** `input` is a file path or an HTTP(S) URL; ffprobe reads it with ranges. */
  async probe(input: string): Promise<ProbeResult> {
    const output = await this.runFfprobe(input);
    const streams = output.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    if (!videoStream) {
      throw new InvalidMediaError('The file has no video stream');
    }

    const format = output.format ?? {};
    return {
      durationSeconds: this.toNumber(format.duration ?? videoStream.duration),
      metadata: {
        format_name: format.format_name,
        format_long_name: format.format_long_name,
        size_bytes: this.toNumber(format.size),
        bit_rate: this.toNumber(format.bit_rate),
        streams: streams.map((stream) => ({
          index: stream.index,
          codec_type: stream.codec_type,
          codec_name: stream.codec_name,
          width: stream.width,
          height: stream.height,
          frame_rate: stream.r_frame_rate,
          sample_rate: this.toNumber(stream.sample_rate),
          channels: stream.channels,
        })),
      },
    };
  }

  private async runFfprobe(input: string): Promise<FfprobeOutput> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          input,
        ],
        { maxBuffer: PROBE_MAX_BUFFER_BYTES, timeout: PROBE_TIMEOUT_MS },
      );
      return JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (NOT_MEDIA_PATTERNS.some((pattern) => pattern.test(stderr))) {
        throw new InvalidMediaError('The file is not a valid media file');
      }
      throw new Error(describeToolFailure('ffprobe', error));
    }
  }

  private toNumber(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
