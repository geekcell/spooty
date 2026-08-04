import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TrackService } from './track.service';
import { TrackEntity } from './track.entity';
import { EnvironmentEnum } from '../environmentEnum';

/**
 * See track-download.processor.ts for why this reads `process.env` directly
 * rather than going through ConfigService.
 *
 * Search is cheaper than downloading but still hits YouTube, so it stays
 * modest. It runs ahead of the download queue, so raising it much past the
 * download concurrency mostly just grows the queued backlog.
 */
const parsedSearchConcurrency = Number(
  process.env[EnvironmentEnum.SEARCH_CONCURRENCY],
);
const SEARCH_CONCURRENCY =
  Number.isFinite(parsedSearchConcurrency) && parsedSearchConcurrency >= 1
    ? Math.floor(parsedSearchConcurrency)
    : 3;

@Processor('track-search-processor', { concurrency: SEARCH_CONCURRENCY })
export class TrackSearchProcessor extends WorkerHost {
  constructor(private readonly trackService: TrackService) {
    super();
  }

  async process(job: Job<TrackEntity, void, string>): Promise<void> {
    await this.trackService.findOnYoutube(job.data);
  }
}
