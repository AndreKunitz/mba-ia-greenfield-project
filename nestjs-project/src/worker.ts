import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  // No HTTP server: this process only consumes the video-processing queue.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM (docker stop) BullMQ lets the running job finish first.
  app.enableShutdownHooks();
}
void bootstrap();
