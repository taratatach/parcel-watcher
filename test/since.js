const watcher = require('../');
const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const snapshotPath = path.join(__dirname, 'snapshot.txt');
const tmpDir = path.join(
  fs.realpathSync(require('os').tmpdir()),
  Math.random().toString(31).slice(2),
);
fs.mkdirpSync(tmpDir);

let backends = [];
if (process.platform === 'darwin') {
  backends = ['fs-events', 'watchman'];
} else if (process.platform === 'linux') {
  backends = ['inotify', 'watchman'];
} else if (process.platform === 'win32') {
  backends = ['windows', 'watchman'];
}

let c = 0;
const getFilename = (...dir) =>
  path.join(tmpDir, ...dir, `test${c++}${Math.random().toString(31).slice(2)}`);

function testPrecision() {
  let f = getFilename();
  fs.writeFileSync(f, '.');
  let stat = fs.statSync(f);
  return ((stat.atimeMs / 1000) | 0) === stat.atimeMs / 1000;
}

const isSecondPrecision = testPrecision();

const getMetadata = async (p) => {
  // XXX: Use lstat to get stats of symlinks rather than their targets
  const stats = await fs.lstat(p);
  return {
    ino: stats.ino,
    kind: stats.isDirectory() ? "directory" : "file"
  };
};

describe('since', () => {
  const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  before(async () => {
    // wait for tmp dir to be created.
    await sleep();
  });

  after(async () => {
    try {
      await fs.unlink(snapshotPath);
    } catch (err) {}
  });

  backends.forEach((backend) => {
    describe(backend, () => {
      describe('files', () => {
        it('should emit when a file is created', async () => {
          let f = getFilename();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
          if (isSecondPrecision) {
            await sleep(1000);
          }
          await fs.writeFile(f, 'hello world');
          let { ino, kind } = await getMetadata(f);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f, kind, ino}]);
        });

        it('should emit when a file is updated', async () => {
          let f = getFilename();
          await fs.writeFile(f, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.writeFile(f, 'hi');
          let { ino, kind } = await getMetadata(f);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'update', path: f, kind, ino}]);
        });

        it('should emit when a file is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f1);
          await fs.rename(f1, f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f1, path: f2, kind, ino},
          ]);
        });

        it('should emit when a file is deleted', async () => {
          let f = getFilename();
          await fs.writeFile(f, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f);
          await fs.unlink(f);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'delete', path: f, kind, ino}]);
        });
      });

      describe('directories', () => {
        it('should emit when a directory is created', async () => {
          let f1 = getFilename();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
          await fs.mkdir(f1);
          let { ino, kind } = await getMetadata(f1);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });

        it('should emit when a directory is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.mkdir(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f1);
          await fs.rename(f1, f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });

          assert.deepEqual(res, [
            {type: 'rename', oldPath: f1, path: f2, kind, ino},
          ]);
        });

        it('should emit when a directory is deleted', async () => {
          let f1 = getFilename();
          await fs.mkdir(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f1);
          await fs.remove(f1);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });

          assert.deepEqual(res, [{type: 'delete', path: f1, kind, ino}]);
        });
      });

      describe('sub-files', () => {
        it('should emit when a sub-file is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
          if (isSecondPrecision) {
            await sleep(1000);
          }

          await fs.writeFile(f2, 'hello world');
          let { ino, kind } = await getMetadata(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a sub-file is updated', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await fs.writeFile(f2, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.writeFile(f2, 'hi');
          let { ino, kind } = await getMetadata(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'update', path: f2, kind, ino}]);
        });

        it('should emit when a sub-file is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          let f3 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await fs.writeFile(f2, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f2);
          await fs.rename(f2, f3);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a sub-file is deleted', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await fs.writeFile(f2, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f2);
          await fs.unlink(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'delete', path: f2, kind, ino}]);
        });
      });

      describe('sub-directories', () => {
        it('should emit when a sub-directory is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.mkdir(f2);
          let { ino, kind } = await getMetadata(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a sub-directory is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          let f3 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await fs.mkdir(f2);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f2);
          await fs.rename(f2, f3);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a sub-directory is deleted with files inside', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await fs.writeFile(f2, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino: f1Ino, kind: f1Kind } = await getMetadata(f1);
          let { ino: f2Ino, kind: f2Kind } = await getMetadata(f2);
          await fs.remove(f1);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          try {
            assert.deepEqual(res, [
              {type: 'delete', path: f2, kind: f2Kind, ino: f2Ino},
              {type: 'delete', path: f1, kind: f1Kind, ino: f1Ino},
            ]);
          } catch (err) {
            // XXX: when deleting a directory and its content, events can be
            // notified in either order.
            assert.deepEqual(res, [
              {type: 'delete', path: f1, kind: f1Kind, ino: f1Ino},
              {type: 'delete', path: f2, kind: f2Kind, ino: f2Ino},
            ]);
          }
        });
      });

      describe('symlinks', () => {
        it('should emit when a symlink is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.symlink(f1, f2);
          let { ino, kind } = await getMetadata(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a symlink is updated', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await fs.symlink(f1, f2);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(f2, 'hi');
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'update', path: f1, kind, ino}]);
        });

        it('should emit when a symlink is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          let f3 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await fs.symlink(f1, f2);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f2);
          await fs.rename(f2, f3);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a symlink is deleted', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await fs.symlink(f1, f2);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          let { ino, kind } = await getMetadata(f2);
          await fs.unlink(f2);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'delete', path: f2, kind, ino}]);
        });
      });

      describe('rapid changes', () => {
        // fsevents doesn't provide the granularity to ignore rapid creates + deletes/renames
        if (backend !== 'fs-events') {
          it('should ignore files that are created and deleted rapidly', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            await sleep();
            await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await fs.writeFile(f2, 'hello world');
            await fs.unlink(f2);
            await sleep();

            let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
              backend,
            });
            assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
          });
        }

        it('should coalese create and update events', async () => {
          let f1 = getFilename();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
          if (isSecondPrecision) {
            await sleep(1000);
          }
          await fs.writeFile(f1, 'hello world');
          await fs.writeFile(f1, 'updated');
          let { ino, kind } = await getMetadata(f1);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });

        if (backend !== 'fs-events') {
          it('should coalese create and rename events', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await fs.rename(f1, f2);
            await sleep();

            let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
              backend,
            });
            assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
          });

          it('should coalese multiple rename events', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            let f3 = getFilename();
            let f4 = getFilename();
            await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await fs.rename(f1, f2);
            await fs.rename(f2, f3);
            await fs.rename(f3, f4);
            await sleep();

            let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
              backend,
            });
            assert.deepEqual(res, [{type: 'create', path: f4, kind, ino}]);
          });
        }

        it('should coalese multiple update events', async () => {
          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          let { ino, kind } = await getMetadata(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.writeFile(f1, 'update');
          await fs.writeFile(f1, 'update2');
          await fs.writeFile(f1, 'update3');
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'update', path: f1, kind, ino}]);
        });

        it('should coalese update and delete events', async () => {
          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          let { ino, kind } = await getMetadata(f1);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend});

          await fs.writeFile(f1, 'update');
          await fs.unlink(f1);
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
          });
          assert.deepEqual(res, [{type: 'delete', path: f1, kind, ino}]);
        });
      });

      describe('ignore', () => {
        it('should ignore a directory', async () => {
          let f1 = getFilename();
          let dir = getFilename();
          let f2 = getFilename(path.basename(dir));
          let ignore = [dir];
          await fs.mkdir(dir);
          await sleep();
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend, ignore});
          if (isSecondPrecision) {
            await sleep(1000);
          }

          await fs.writeFile(f1, 'hello');
          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(f2, 'sup');
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
            ignore,
          });
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });

        it('should ignore a file', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          let ignore = [f2];
          await watcher.writeSnapshot(tmpDir, snapshotPath, {backend, ignore});
          if (isSecondPrecision) {
            await sleep(1000);
          }

          await fs.writeFile(f1, 'hello');
          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(f2, 'sup');
          await sleep();

          let res = await watcher.getEventsSince(tmpDir, snapshotPath, {
            backend,
            ignore,
          });
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });
      });

      describe('errors', () => {
        it('should error if the watched directory does not exist', async () => {
          let dir = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );

          let threw = false;
          try {
            await watcher.writeSnapshot(dir, snapshotPath, {backend});
          } catch (err) {
            threw = true;
          }

          assert(threw, 'did not throw');
        });

        it('should error if the watched path is not a directory', async () => {
          if (backend === 'watchman' && process.platform === 'win32') {
            // There is a bug in watchman on windows where the `watch` command hangs if the path is not a directory.
            return;
          }

          let file = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.writeFileSync(file, 'test');

          let threw = false;
          try {
            await watcher.writeSnapshot(file, snapshotPath, {backend});
          } catch (err) {
            threw = true;
          }

          assert(threw, 'did not throw');
        });
      });
    });
  });
});
