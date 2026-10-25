import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTestVideo } from '../test/media-fixtures';
import { ThumbnailService } from './thumbnail.service';

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

describe('ThumbnailService (real ffmpeg)', () => {
  const service = new ThumbnailService();
  let directory: string;
  let video: string;
  let text: string;

  const leftoverTempDirectories = async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith('thumbnail-'));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'thumb-test-'));
    video = join(directory, 'video.mp4');
    text = join(directory, 'notes.txt');
    await generateTestVideo(video, 2);
    await writeFile(text, 'this is not a media file');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('should extract a JPEG frame from a video', async () => {
    const image = await service.generate(video, 2);

    expect(image.length).toBeGreaterThan(500);
    expect([...image.subarray(0, 3)]).toEqual(JPEG_MAGIC);
  });

  it('should extract a frame even when the duration is unknown', async () => {
    const image = await service.generate(video, null);

    expect([...image.subarray(0, 3)]).toEqual(JPEG_MAGIC);
  });

  it('should fail when the input is not media', async () => {
    await expect(service.generate(text, null)).rejects.toThrow('ffmpeg failed');
  });

  it('should not leave temporary files behind, on success or failure', async () => {
    const before = await leftoverTempDirectories();

    await service.generate(video, 2);
    await service.generate(text, null).catch(() => undefined);

    expect(await leftoverTempDirectories()).toEqual(before);
  });
});
