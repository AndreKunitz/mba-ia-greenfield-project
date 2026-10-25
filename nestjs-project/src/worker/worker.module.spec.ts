import { Test } from '@nestjs/testing';
import { VideoReconciliationService } from '../videos/video-reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { WorkerModule } from './worker.module';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';
import { VideoProcessor } from './video.processor';

describe('WorkerModule', () => {
  it('should compile and resolve the processor and its collaborators', async () => {
    // compile() does not run the lifecycle hooks, so no BullMQ worker is
    // started and the real video-worker keeps its queue to itself.
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);
    expect(module.get(ThumbnailService)).toBeInstanceOf(ThumbnailService);
    expect(module.get(VideoReconciliationService)).toBeInstanceOf(
      VideoReconciliationService,
    );
    expect(module.get(ReconciliationScheduler)).toBeInstanceOf(
      ReconciliationScheduler,
    );
    await module.close();
  }, 30000);
});
