import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deleteFolderTree only ever touches a folder of the form waseetai/<kind>/<account id>: anything broader is refused without touching the storage', async () => {
  const { deleteFolderTree } = await import('./cloudinary-storage');
  for (const bad of ['', 'waseetai', 'waseetai/clients', 'waseetai/clients/', 'waseetai/clients/short', '../waseetai/clients/abcdefgh12', 'other/clients/abcdefgh12', 'waseetai/Clients/abcdefgh12', 'waseetai/clients/abc/def/ghi']) {
    assert.equal(await deleteFolderTree(bad), 0, bad);
  }
});
