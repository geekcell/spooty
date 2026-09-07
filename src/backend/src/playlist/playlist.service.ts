import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlaylistEntity } from './playlist.entity';
import { TrackService } from '../track/track.service';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import * as fs from 'fs';
import { resolve } from 'path';
import { Interval } from '@nestjs/schedule';
import { TrackEntity, TrackStatusEnum } from '../track/track.entity';
import { UtilsService } from '../shared/utils.service';
import { SpotifyService } from '../shared/spotify.service';

enum WsPlaylistOperation {
  New = 'playlistNew',
  Update = 'playlistUpdate',
  Delete = 'playlistDelete',
}

@WebSocketGateway()
@Injectable()
export class PlaylistService {
  @WebSocketServer() io: Server;
  private readonly logger = new Logger(TrackService.name);

  constructor(
    @InjectRepository(PlaylistEntity)
    private repository: Repository<PlaylistEntity>,
    private readonly trackService: TrackService,
    private readonly utilsService: UtilsService,
    private readonly spotifyService: SpotifyService,
  ) {}

  findAll(
    relations: Record<string, boolean> = { tracks: true },
    where?: Partial<PlaylistEntity>,
  ): Promise<PlaylistEntity[]> {
    return this.repository.find({ where, relations });
  }

  findOne(id: number): Promise<PlaylistEntity | null> {
    return this.repository.findOneBy({ id });
  }

  async remove(id: number): Promise<void> {
    await this.repository.delete(id);
    this.io.emit(WsPlaylistOperation.Delete, { id });
  }

  async create(playlist: PlaylistEntity): Promise<void> {
    // Detect if URL is for a single track or a playlist and route accordingly
    const isTrack = this.spotifyService.isTrackUrl(playlist.spotifyUrl);

    if (isTrack) {
      await this.createSingleTrack(playlist);
    } else {
      await this.createPlaylist(playlist);
    }
  }

  private async createSingleTrack(playlist: PlaylistEntity): Promise<void> {
    let trackDetail: { name: string; artist: string; image: string };
    let playlist2Save: PlaylistEntity;
    try {
      trackDetail = await this.spotifyService.getTrackDetail(
        playlist.spotifyUrl,
      );
      this.logger.debug(`Track detail retrieved: ${trackDetail.name}`);

      playlist2Save = {
        ...playlist,
        name: trackDetail.name,
        coverUrl: trackDetail.image,
        isTrack: true,
        active: false, // Single tracks cannot be subscribed
      };
      // Don't create folder structure for individual tracks - they go in root
    } catch (err) {
      this.logger.error(`Error getting track details: ${err}`);
      playlist2Save = { ...playlist, error: String(err), isTrack: true };
    }
    const savedPlaylist = await this.save(playlist2Save);

    if (trackDetail) {
      try {
        await this.trackService.create(
          {
            artist: trackDetail.artist,
            name: trackDetail.name,
            spotifyUrl: playlist.spotifyUrl,
            coverUrl: trackDetail.image,
          },
          savedPlaylist,
        );
      } catch (error) {
        this.logger.error(
          `Error creating track "${trackDetail.artist} - ${trackDetail.name}": ${error.message}`,
        );
      }
    }
  }

  private async createPlaylist(playlist: PlaylistEntity): Promise<void> {
    let detail: {
      tracks: any;
      name: any;
      image: any;
      artist?: string;
      year?: string;
      discs?: number;
    };
    let playlist2Save: PlaylistEntity;
    try {
      detail = await this.spotifyService.getPlaylistDetail(playlist.spotifyUrl);
      this.logger.debug(
        `Playlist detail retrieved with ${detail.tracks?.length || 0} tracks`,
      );

      playlist2Save = {
        ...playlist,
        name: detail.name,
        coverUrl: detail.image,
        artist: detail.artist,
        year: detail.year,
        discs: detail.discs,
      };
      this.createPlaylistFolderStructure(playlist2Save);
    } catch (err) {
      this.logger.error(`Error getting playlist details: ${err}`);
      playlist2Save = { ...playlist, error: String(err) };
    }
    const savedPlaylist = await this.save(playlist2Save);

    if (detail?.tracks && detail.tracks.length > 0) {
      this.logger.debug(
        `Starting to process ${detail.tracks.length} tracks for playlist ${savedPlaylist.name}`,
      );

      let processedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const track of detail.tracks) {
        try {
          if (!track.artist || !track.name) {
            this.logger.warn(
              `Skipping track ${processedCount + skippedCount + 1}: Missing artist or name information`,
            );
            skippedCount++;
            continue;
          }

          if (track.unavailable === true) {
            this.logger.warn(
              `Skipping unavailable track ${processedCount + skippedCount + 1}: ${track.artist} - ${track.name}`,
            );
            skippedCount++;
            continue;
          }

          await this.trackService.create(
            {
              artist: track.artist,
              name: track.name,
              spotifyUrl: track.previewUrl || null,
              coverUrl: track.coverUrl || savedPlaylist.coverUrl, // Use track's album art, fallback to playlist cover
              trackNumber: track.trackNumber,
              discNumber: track.discNumber,
              durationMs: track.durationMs,
            },
            savedPlaylist,
          );

          processedCount++;

          if (processedCount % 100 === 0) {
            this.logger.debug(
              `Processed ${processedCount} tracks so far for playlist ${savedPlaylist.name}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error creating track "${
              track?.artist || 'Unknown'
            } - ${track?.name || 'Unknown'}": ${error.message}`,
          );
          errorCount++;
        }
      }

      this.logger.debug(
        `Finished processing playlist ${savedPlaylist.name}: ` +
          `${processedCount} tracks processed, ${skippedCount} skipped, ${errorCount} errors`,
      );

      if (savedPlaylist.artist && savedPlaylist.year) {
        await this.writeAlbumExtras(savedPlaylist, detail.tracks);
      }
    } else {
      this.logger.warn(`No tracks found for playlist ${savedPlaylist.name}`);
    }
  }

  // Qobuz layout ships "cover.jpg" and "<Album Title>.m3u" next to the
  // tracks; the m3u lists the expected file names in album order (with the
  // "Disc NN/" prefix on multi-disc sets) and is written up front — the
  // actual downloads fill in asynchronously.
  private async writeAlbumExtras(
    playlist: PlaylistEntity,
    tracks: any[],
  ): Promise<void> {
    const folder = this.utilsService.getPlaylistFolderPath(playlist);
    try {
      if (playlist.coverUrl) {
        const res = await fetch(playlist.coverUrl);
        if (res.ok) {
          fs.writeFileSync(
            resolve(folder, 'cover.jpg'),
            Buffer.from(await res.arrayBuffer()),
          );
        }
      }
      const multiDisc = (playlist.discs ?? 1) > 1;
      const lines = tracks.map((t) => {
        const file = this.trackService.getTrackFileName(
          {
            artist: t.artist,
            name: t.name,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
          } as TrackEntity,
          playlist,
        );
        const prefix =
          multiDisc && t.discNumber
            ? `Disc ${this.utilsService.pad2(t.discNumber)}/`
            : '';
        return prefix + file;
      });
      const m3uName = `${this.utilsService.stripFileIllegalChars(playlist.name)}.m3u`;
      fs.writeFileSync(resolve(folder, m3uName), lines.join('\n') + '\n');
    } catch (err) {
      this.logger.warn(`Album extras (cover/m3u) failed: ${err}`);
    }
  }

  async save(playlist: PlaylistEntity): Promise<PlaylistEntity> {
    const savedPlaylist = await this.repository.save(playlist);
    this.io.emit(WsPlaylistOperation.New, savedPlaylist);
    return savedPlaylist;
  }

  async update(id: number, playlist: Partial<PlaylistEntity>): Promise<void> {
    await this.repository.update(id, playlist);
    const dbPlaylist = await this.findOne(id);
    this.io.emit(WsPlaylistOperation.Update, dbPlaylist);
  }

  async retryFailedOfPlaylist(id: number): Promise<void> {
    const tracks = await this.trackService.getAllByPlaylist(id);
    for (const track of tracks) {
      if (track.status === TrackStatusEnum.Error) {
        await this.trackService.retry(track.id);
      }
    }
  }

  private createPlaylistFolderStructure(playlist: {
    name?: string;
    artist?: string;
    year?: string;
  }): void {
    const playlistPath = this.utilsService.getPlaylistFolderPath(playlist);
    // recursive: albums nest as "<artist>/<year> - <name>"
    fs.mkdirSync(playlistPath, { recursive: true });
  }

  @Interval(3_600_000)
  async checkActivePlaylists(): Promise<void> {
    // Only check actual playlists (not individual tracks) that are subscribed
    const activePlaylists = await this.findAll({
      active: true,
      isTrack: false,
    });
    for (const playlist of activePlaylists) {
      let tracks = [];
      try {
        tracks = await this.spotifyService.getPlaylistTracks(
          playlist.spotifyUrl,
        );
        this.createPlaylistFolderStructure(playlist);
      } catch (err) {
        await this.update(playlist.id, { ...playlist, error: String(err) });
      }
      for (const track of tracks ?? []) {
        const track2Save = {
          artist: track.artist,
          name: track.name,
          spotifyUrl: track.previewUrl,
        };
        const isExist = !!(
          await this.trackService.getAll({
            ...track2Save,
            playlist: { id: playlist.id },
          })
        ).length;
        if (!isExist) {
          // Album fields go only into create, not into the existence check
          // above — old rows without numbers would otherwise duplicate.
          await this.trackService.create(
            {
              ...track2Save,
              trackNumber: track.trackNumber,
              discNumber: track.discNumber,
              durationMs: track.durationMs,
            },
            playlist,
          );
        }
      }
    }
  }
}
