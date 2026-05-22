import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMock = {
  zone: {
    connect_with_accesskey: vi.fn(),
  },
  regions: {
    StorageRegion: {
      Falkenstein: 'de',
      London: 'uk',
      NewYork: 'ny',
      LosAngeles: 'la',
      Singapore: 'sg',
      Stockholm: 'se',
      SaoPaulo: 'br',
      Johannesburg: 'jh',
      Sydney: 'syd',
    },
  },
  file: {
    list: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
  },
};

vi.mock('@bunny.net/storage-sdk', () => sdkMock);

const { BunnyClient } = await import('./bunny-client.js');

describe('BunnyClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.zone.connect_with_accesskey.mockReturnValue({ id: 'zone-handle' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('connects with the right region enum value', () => {
    new BunnyClient({
      region: 'NewYork',
      zoneName: 'my-zone',
      storagePassword: 'sp',
      accountApiKey: 'ak',
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    expect(sdkMock.zone.connect_with_accesskey).toHaveBeenCalledWith('ny', 'my-zone', 'sp');
  });

  it('listAll recurses into subdirectories and normalizes paths', async () => {
    sdkMock.file.list.mockImplementation(async (_zone: unknown, path: string) => {
      if (path === '/') {
        return [
          { objectName: 'index.html', path: '/my-zone/', length: 10, checksum: 'h-index', isDirectory: false },
          { objectName: 'assets', path: '/my-zone/', length: 0, checksum: '', isDirectory: true },
        ];
      }
      if (path === '/assets/') {
        return [
          { objectName: 'app.js', path: '/my-zone/assets/', length: 20, checksum: 'h-app', isDirectory: false },
        ];
      }
      throw new Error(`unexpected list path: ${path}`);
    });

    const client = new BunnyClient({
      region: 'Falkenstein',
      zoneName: 'my-zone',
      storagePassword: 'sp',
      accountApiKey: 'ak',
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    const remote = await client.listAll('/');
    remote.sort((a, b) => a.relPath.localeCompare(b.relPath));
    expect(remote).toEqual([
      { relPath: 'assets/app.js', size: 20, sha256: 'h-app' },
      { relPath: 'index.html', size: 10, sha256: 'h-index' },
    ]);
  });

  it('purgePullZone calls the API with the AccessKey header', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BunnyClient({
      region: 'Falkenstein',
      zoneName: 'my-zone',
      storagePassword: 'sp',
      accountApiKey: 'ak',
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    await client.purgePullZone(12345);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.bunny.net/pullzone/12345/purgeCache');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ AccessKey: 'ak' });
  });

  it('purgePullZone throws on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BunnyClient({
      region: 'Falkenstein',
      zoneName: 'my-zone',
      storagePassword: 'sp',
      accountApiKey: 'ak',
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    await expect(client.purgePullZone(12345)).rejects.toThrow(/403/);
  });
});
