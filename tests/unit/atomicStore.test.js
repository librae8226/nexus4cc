import { AtomicStore } from '../../src/data/store.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AtomicStore', () => {
  let store;
  let testDir;
  let testFile;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atomicstore-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'test-data.json');
    store = new AtomicStore(testFile);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent file', async () => {
    const data = await store.read();
    expect(data).toEqual([]);
  });

  it('writes and reads back data', async () => {
    const items = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    await store.write(items);
    const result = await store.read();
    expect(result).toEqual(items);
  });

  it('update applies function atomically', async () => {
    await store.write([]);
    await store.update((data) => {
      data.push({ id: 1, name: 'first' });
    });
    await store.update((data) => {
      data.push({ id: 2, name: 'second' });
    });
    const result = await store.read();
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('first');
    expect(result[1].name).toBe('second');
  });

  it('serializes concurrent updates', async () => {
    await store.write([]);
    const results = await Promise.all([
      store.update((d) => { d.push({ id: 1 }); }),
      store.update((d) => { d.push({ id: 2 }); }),
      store.update((d) => { d.push({ id: 3 }); }),
    ]);
    expect(results.length).toBe(3);
    const data = await store.read();
    expect(data.length).toBe(3);
    const ids = data.map(x => x.id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });
});
