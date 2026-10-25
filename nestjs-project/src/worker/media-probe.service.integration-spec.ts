import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTestAudio, generateTestVideo } from '../test/media-fixtures';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';

describe('MediaProbeService (real ffprobe)', () => {
  const service = new MediaProbeService();
  let directory: string;
  let video: string;
  let audio: string;
  let text: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'probe-test-'));
    video = join(directory, 'video.mp4');
    audio = join(directory, 'audio.m4a');
    text = join(directory, 'notes.txt');
    await generateTestVideo(video, 2);
    await generateTestAudio(audio);
    await writeFile(text, 'this is not a media file');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('should extract duration and stream metadata from a video', async () => {
    const result = await service.probe(video);

    expect(result.durationSeconds).toBeCloseTo(2, 0);
    const metadata = result.metadata as {
      format_name: string;
      streams: { codec_type: string; codec_name: string; width?: number }[];
    };
    expect(metadata.format_name).toContain('mp4');
    const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
    expect(videoStream).toMatchObject({
      codec_name: 'h264',
      width: 320,
      height: 240,
    });
    expect(metadata.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  });

  it('should reject a file that is not media', async () => {
    await expect(service.probe(text)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('should reject media that has no video stream', async () => {
    await expect(service.probe(audio)).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  });

  it('should treat a missing input as a retryable failure, not as invalid media', async () => {
    const failure = service.probe(join(directory, 'missing.mp4'));

    await expect(failure).rejects.toThrow('ffprobe failed');
    await expect(failure).rejects.not.toBeInstanceOf(InvalidMediaError);
  });

  it('should not leak a URL in the failure message', async () => {
    const failure = service.probe(
      'http://127.0.0.1:1/video.mp4?X-Amz-Signature=secret',
    );

    await expect(failure).rejects.toThrow('ffprobe failed');
    await expect(failure).rejects.not.toThrow(/X-Amz-Signature|secret/);
  });
});
