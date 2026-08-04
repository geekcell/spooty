import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TrackService } from './track.service';
import { TrackEntity } from './track.entity';
import { EnvironmentEnum } from '../environmentEnum';

/**
 * Read a positive integer from the environment, falling back to `fallback`
 * when unset, non-numeric, or out of range.
 *
 * These are read from `process.env` rather than `ConfigService` because the
 * `@Processor` decorator is evaluated at class-definition time, before Nest's
 * DI container exists.
 */
function envInt(key: EnvironmentEnum, fallback: number, min = 0): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

/**
 * Defaults are deliberately conservative. YouTube rate-limits a session for up
 * to an hour after roughly 100 rapid downloads, and recovering from that costs
 * far more time than the throughput gained by pulling harder. 2 workers with a
 * 3s stagger caps sustained throughput at ~20 downloads/min, which has run
 * large playlist backfills without tripping the limit. Raise at your own risk.
 */
const DOWNLOAD_CONCURRENCY = envInt(EnvironmentEnum.DOWNLOAD_CONCURRENCY, 2, 1);
const DOWNLOAD_GAP_MS = envInt(EnvironmentEnum.DOWNLOAD_GAP_MS, 3000);

@Processor('track-download-processor', { concurrency: DOWNLOAD_CONCURRENCY })
export class TrackDownloadProcessor extends WorkerHost {
  private static lastStart = 0;

  constructor(private readonly trackService: TrackService) {
    super();
  }

  async process(job: Job<TrackEntity, void>): Promise<void> {
    // Stagger downloads: each one waits until DOWNLOAD_GAP_MS after the last started
    const now = Date.now();
    const wait = Math.max(0, TrackDownloadProcessor.lastStart + DOWNLOAD_GAP_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    TrackDownloadProcessor.lastStart = Date.now();
    await this.trackService.downloadFromYoutube(job.data);
  }
}
