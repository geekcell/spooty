import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'path';
import { EnvironmentEnum } from '../environmentEnum';

@Injectable()
export class UtilsService {
  constructor(private readonly configService: ConfigService) {}

  getRootDownloadsPath(): string {
    return resolve(
      __dirname,
      '..',
      this.configService.get<string>(EnvironmentEnum.DOWNLOADS_PATH),
    );
  }

  // Albums are stored as "<artist>/<year> - <name>", playlists stay flat.
  getPlaylistFolderPath(playlist: {
    name?: string;
    artist?: string;
    year?: string;
  }): string {
    const name = this.stripFileIllegalChars(
      playlist?.name || 'unknown_playlist',
    );
    if (playlist?.artist && playlist?.year) {
      return resolve(
        this.getRootDownloadsPath(),
        this.stripFileIllegalChars(playlist.artist),
        `${playlist.year} - ${name}`,
      );
    }
    return resolve(this.getRootDownloadsPath(), name);
  }

  stripFileIllegalChars(text: string): string {
    return text.replace(/[/\\?%*:|"<>]/g, '-');
  }

  pad2(n: number): string {
    return String(n).padStart(2, '0');
  }
}
