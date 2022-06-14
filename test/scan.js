const watcher = require('../');
const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const winFs = require('@gyselroth/windows-fsstat');

const tmpDir = path.join(
  fs.realpathSync(require('os').tmpdir()),
  Math.random().toString(31).slice(2),
);

let backends = [];
// FIXME: Watchman and FSEvents are not supported yet
if (process.platform === 'darwin') {
  backends = [];
} else if (process.platform === 'linux') {
  backends = ['inotify'];
} else if (process.platform === 'win32') {
  backends = ['windows'];
}

let c = 0;
const getFilename = (...dir) =>
  path.join(tmpDir, ...dir, `test${c++}${Math.random().toString(31).slice(2)}`);

const getMetadata = async (p) => {
  // XXX: Use lstat to get stats of symlinks rather than their targets
  if (process.platform === 'win32') {
    const stats = winFs.lstatSync(p);
    return {
      fileId: stats.fileid,
      kind: stats.directory ? "directory" : "file"
    };
  } else {
    const stats = await fs.lstat(p);
    return {
      ino: stats.ino,
      kind: stats.isDirectory() ? "directory" : "file"
    };
  }
};

backends.forEach((backend) => {
  describe(backend, () => {
    describe('scan', () => {
      beforeEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
        await fs.mkdirpSync(tmpDir);
      });

      it('should not emit for the scanned directory itself', async () => {
        let res = await watcher.scan(tmpDir, {backend});

        assert.deepEqual(res, []);
      });

      it('should emit when a file is found', async () => {
        let f = getFilename();
        await fs.writeFile(f, 'test');
        let { ino, fileId, kind } = await getMetadata(f);

        let res = await watcher.scan(tmpDir, {backend});

        if (process.platform === 'linux') {
          assert.deepEqual(res, [{type: 'create', path: f, kind, ino}]);
        } else if (process.platform === 'win32') {
          assert.deepEqual(res, [{type: 'create', path: f, kind, fileId}]);
        }
      });

      it('should emit when a directory is found', async () => {
        let dir = getFilename();
        await fs.mkdir(dir);
        let { ino, fileId, kind } = await getMetadata(dir);

        let res = await watcher.scan(tmpDir, {backend});

        if (process.platform === 'linux') {
          assert.deepEqual(res, [{type: 'create', path: dir, kind, ino}]);
        } else if (process.platform === 'win32') {
          assert.deepEqual(res, [{type: 'create', path: dir, kind, fileId}]);
        }
      });

      it('should emit for sub-directories content', async () => {
        let dir = getFilename();
        let subdir = getFilename(path.basename(dir));
        let file = getFilename(path.basename(dir), path.basename(subdir));
        await fs.mkdir(dir);
        await fs.mkdir(subdir);
        await fs.writeFile(file, 'test');
        let { ino: dirIno, fileId: dirFileId, kind: dirKind } = await getMetadata(dir);
        let { ino: subdirIno, fileId: subdirFileId, kind: subdirKind } = await getMetadata(subdir);
        let { ino: fileIno, fileId: fileFileId, kind: fileKind } = await getMetadata(file);

        let res = await watcher.scan(tmpDir, {backend});

        if (process.platform === 'linux') {
          assert.deepEqual(res, [
            {type: 'create', path: dir, kind: dirKind, ino: dirIno},
            {type: 'create', path: subdir, kind: subdirKind, ino: dirIno},
            {type: 'create', path: file, kind: fileKind, ino: fileIno},
          ]);
        } else if (process.platform === 'win32') {
          assert.deepEqual(res, [
            {type: 'create', path: dir, kind: dirKind, fileId: dirFileId},
            {type: 'create', path: subdir, kind: subdirKind, fileId: subdirFileId},
            {type: 'create', path: file, kind: fileKind, fileId: fileFileId},
          ]);
        }
      });
    });
  });
});
