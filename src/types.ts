import type { JsonObject } from '@angular-devkit/core';

export const STORAGE_REGIONS = [
  'Falkenstein',
  'London',
  'NewYork',
  'LosAngeles',
  'Singapore',
  'Stockholm',
  'SaoPaulo',
  'Johannesburg',
  'Sydney',
] as const;
export type StorageRegion = typeof STORAGE_REGIONS[number];

export interface DeployOptions extends JsonObject {
  buildTarget: string | null;
  outputPath: string | null;
  storageZoneName: string;
  storageRegion: StorageRegion;
  targetFolder: string;
  pullZoneId: number | null;
  purgeAfterUpload: boolean;
  concurrency: number;
  retries: number;
  ignore: string[];
  dryRun: boolean;
}

export interface LocalFile {
  relPath: string;
  absPath: string;
  size: number;
  sha256: string;
}

export interface RemoteFile {
  relPath: string;
  size: number;
  sha256: string | null;
}

export interface Diff {
  toUpload: LocalFile[];
  toDelete: RemoteFile[];
  unchanged: LocalFile[];
}
