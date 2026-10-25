import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import videosConfig from '../config/videos.config';
import { VideoQueueProducer } from './video-queue.producer';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_QUEUE,
} from './videos.constants';

describe('VideoQueueProducer', () => {
  const queue = { add: jest.fn(), getJob: jest.fn() };
  let producer: VideoQueueProducer;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoQueueProducer,
        { provide: getQueueToken(VIDEO_QUEUE), useValue: queue },
        {
          provide: videosConfig.KEY,
          useValue: { jobAttempts: 3, jobBackoffMs: 5000 },
        },
      ],
    }).compile();
    producer = module.get(VideoQueueProducer);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should add the job with a deterministic id, retries and exponential backoff', async () => {
    queue.add.mockResolvedValue({});

    await producer.enqueueProcessing('video-uuid');

    expect(queue.add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: 'video-uuid' },
      {
        jobId: 'video-video-uuid',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  });

  it('should propagate an error raised by the queue', async () => {
    const failure = new Error('redis error');
    queue.add.mockRejectedValue(failure);

    await expect(producer.enqueueProcessing('video-uuid')).rejects.toBe(
      failure,
    );
  });

  it('should give up instead of waiting forever when the queue never answers', async () => {
    jest.useFakeTimers();
    queue.add.mockReturnValue(new Promise(() => undefined));

    const result = producer.enqueueProcessing('video-uuid');
    const assertion = expect(result).rejects.toThrow('did not answer');
    await jest.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);

    await assertion;
  });

  describe('reenqueueProcessing', () => {
    it('should add the job when none exists', async () => {
      queue.getJob.mockResolvedValue(undefined);
      queue.add.mockResolvedValue({});

      await producer.reenqueueProcessing('video-uuid');

      expect(queue.getJob).toHaveBeenCalledWith('video-video-uuid');
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it.each(['waiting', 'active', 'delayed'])(
      'should leave a job that is %s alone',
      async (state) => {
        const job = {
          getState: jest.fn().mockResolvedValue(state),
          remove: jest.fn(),
        };
        queue.getJob.mockResolvedValue(job);

        await producer.reenqueueProcessing('video-uuid');

        expect(job.remove).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it.each(['completed', 'failed'])(
      'should remove a %s job and add it again',
      async (state) => {
        const job = {
          getState: jest.fn().mockResolvedValue(state),
          remove: jest.fn(),
        };
        queue.getJob.mockResolvedValue(job);
        queue.add.mockResolvedValue({});

        await producer.reenqueueProcessing('video-uuid');

        expect(job.remove).toHaveBeenCalledTimes(1);
        expect(queue.add).toHaveBeenCalledTimes(1);
      },
    );
  });
});
