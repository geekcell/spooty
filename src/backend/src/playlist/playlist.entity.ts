import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { TrackEntity } from '../track/track.entity';

@Entity()
export class PlaylistEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  name?: string;

  @Column()
  spotifyUrl: string;

  @Column({ nullable: true })
  error?: string;

  @Column({ default: false })
  active?: boolean;

  @Column({ default: false })
  isTrack?: boolean; // True for individual tracks, false for actual playlists

  @Column({ default: () => Date.now() })
  createdAt?: number;

  @Column({ nullable: true })
  coverUrl?: string;

  // Album metadata (only set for album URLs): switches the download layout
  // to "<artist>/<year> - <name>" instead of the flat playlist folder.
  @Column({ nullable: true })
  artist?: string;

  @Column({ nullable: true })
  year?: string;

  // Highest disc number of the album — >1 nests tracks into "Disc NN".
  @Column({ nullable: true })
  discs?: number;

  @OneToMany(() => TrackEntity, (track) => track.playlist)
  tracks?: TrackEntity[];
}
