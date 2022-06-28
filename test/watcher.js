const watcher = require('../');
const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const {execSync} = require('child_process');

let backends = [];
if (process.platform === 'darwin') {
  backends = ['fs-events', 'watchman'];
} else if (process.platform === 'linux') {
  backends = ['inotify', 'watchman'];
} else if (process.platform === 'win32') {
  backends = ['windows', 'watchman'];
}

const getMetadata = async (p) => {
  // XXX: Use lstat to get stats of symlinks rather than their targets
  const stats = await fs.lstat(p);
  return {
    ino: stats.ino,
    kind: stats.isDirectory() ? "directory" : "file"
  };
};

describe('watcher', () => {
  backends.forEach((backend) => {
    describe(backend, () => {
      let tmpDir;
      let cbs = [];
      let subscribed = false;
      let nextEvent = () => {
        return new Promise((resolve) => {
          cbs.push(resolve);
        });
      };

      let fn = (err, events) => {
        if (err) {
          throw err;
        }

        setImmediate(() => {
          for (let cb of cbs) {
            cb(events);
          }

          cbs = [];
        });
      };

      let c = 0;
      const getFilename = (...dir) =>
        path.join(
          tmpDir,
          ...dir,
          `test${c++}${Math.random().toString(31).slice(2)}`,
        );
      let ignoreDir, ignoreFile, fileToRename, dirToRename, sub;

      before(async () => {
        tmpDir = path.join(
          fs.realpathSync(require('os').tmpdir()),
          Math.random().toString(31).slice(2),
        );
        fs.mkdirpSync(tmpDir);
        ignoreDir = getFilename();
        ignoreFile = getFilename();
        fileToRename = getFilename();
        dirToRename = getFilename();
        fs.writeFileSync(fileToRename, 'hi');
        fs.mkdirpSync(dirToRename);
        await new Promise((resolve) => setTimeout(resolve, 100));
        sub = await watcher.subscribe(tmpDir, fn, {
          backend,
          ignore: [ignoreDir, ignoreFile],
        });
      });

      after(async () => {
        await sub.unsubscribe();
      });

      describe('files', () => {
        it('should emit when a file is created', async () => {
          let f = getFilename();
          await fs.writeFile(f, 'hello world');
          let { ino, kind } = await getMetadata(f);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f, kind, ino}]);
        });

        it('should emit when a file is updated', async () => {
          let f = getFilename();
          await fs.writeFile(f, 'hello world');
          await nextEvent();

          await fs.writeFile(f, 'hi');
          let { ino, kind } = await getMetadata(f);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'update', path: f, kind, ino}]);
        });

        it('should emit when a file is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          let { ino, kind } = await getMetadata(f1);
          await fs.rename(f1, f2);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f1, path: f2, kind, ino},
          ]);
        });

        it('should emit when an existing file is renamed', async () => {
          let f2 = getFilename();
          let { ino, kind } = await getMetadata(fileToRename);
          await fs.rename(fileToRename, f2);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: fileToRename, path: f2, kind, ino},
          ]);
        });

        it('should emit when a file is renamed only changing case', async () => {
          let f1 = getFilename();
          let f2 = path.join(path.dirname(f1), path.basename(f1).toUpperCase());
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          let { ino, kind } = await getMetadata(f1);
          await fs.rename(f1, f2);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f1, path: f2, kind, ino},
          ]);
        });

        it('should emit when a file is deleted', async () => {
          let f = getFilename();
          await fs.writeFile(f, 'hello world');
          await nextEvent();

          let { ino, kind } = await getMetadata(f);
          fs.unlink(f);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f, kind, ino}]);
        });

        it('should store UTF-8 paths properly in the tree', async function() {
          let f = path.join(tmpDir, 'spécial');
          await fs.writeFile(f, 'hello');
          let { ino, kind } = await getMetadata(f);

          async function listen(dir) {
            let cbs = [];
            let nextEvent = () => {
              return new Promise((resolve) => {
                cbs.push(resolve);
              });
            };

            let fn = (err, events) => {
              if (err) {
                throw err;
              }

              setImmediate(() => {
                for (let cb of cbs) {
                  cb(events);
                }

                cbs = [];
              });
            };
            let sub = await watcher.subscribe(dir, fn, {backend});

            return [nextEvent, sub];
          };

          let [nextEvent, sub] = await listen(tmpDir);

          await fs.remove(f);

          try {
            // XXX: no events emitted if non-ascii characters are not handled
            // properly in BruteForceBackend::readTree on Windows.
            let res = await nextEvent();
            assert.deepEqual(res, [{type: 'delete', path: f, kind}]);
          } finally {
            await sub.unsubscribe();
          }
        });
      });

      describe('directories', () => {
        it('should emit when a directory is created', async () => {
          let f = getFilename();
          await fs.mkdir(f);
          let { ino, kind } = await getMetadata(f);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f, kind, ino}]);
        });

        it('should emit when a directory is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.mkdir(f1);
          await nextEvent();

          let { ino, kind } = await getMetadata(f1);
          await fs.rename(f1, f2);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f1, path: f2, kind, ino},
          ]);
        });

        it('should emit when an existing directory is renamed', async () => {
          let f2 = getFilename();
          let { ino, kind } = await getMetadata(dirToRename);
          await fs.rename(dirToRename, f2);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: dirToRename, path: f2, kind, ino},
          ]);
        });

        it('should emit when a directory is deleted', async () => {
          let f = getFilename();
          await fs.mkdir(f);
          await nextEvent();

          let { ino, kind } = await getMetadata(f);
          fs.remove(f);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f, kind, ino}]);
        });

        it('should handle when the directory to watch is deleted', async () => {
          if (backend === 'watchman') {
            // Watchman doesn't handle this correctly
            return;
          }

          let dir = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.mkdirpSync(dir);
          await new Promise((resolve) => setTimeout(resolve, 100));

          let sub = await watcher.subscribe(dir, fn, {backend});

          try {
            let { ino, kind } = await getMetadata(dir);
            fs.remove(dir);

            let res = await nextEvent();
            assert.deepEqual(res, [{type: 'delete', path: dir, kind, ino}]);

            fs.mkdirp(dir);
            res = await Promise.race([
              new Promise((resolve) => setTimeout(resolve, 100)),
              nextEvent(),
            ]);
            assert.equal(res, undefined);
          } finally {
            await sub.unsubscribe();
          }
        });
      });

      describe('sub-files', () => {
        it('should emit when a sub-file is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.writeFile(f2, 'hello world');
          let { ino, kind } = await getMetadata(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a sub-file is updated', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.writeFile(f2, 'hello world');
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();
          await fs.writeFile(f2, 'hi');

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'update', path: f2, kind, ino}]);
        });

        it('should emit when a sub-file is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          let f3 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.writeFile(f2, 'hello world');
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();
          await fs.rename(f2, f3);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a sub-file is deleted', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.writeFile(f2, 'hello world');
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();
          fs.unlink(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f2, kind, ino}]);
        });
      });

      describe('sub-directories', () => {
        it('should emit when a sub-directory is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.mkdir(f2);
          let { ino, kind } = await getMetadata(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a sub-directory is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          let f3 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.mkdir(f2);
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();
          await fs.rename(f2, f3);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a sub-directory is deleted with files inside', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(f1));
          await fs.mkdir(f1);
          await nextEvent();

          await fs.writeFile(f2, 'hello world');
          await nextEvent();

          let { ino: f1Ino, kind: f1Kind } = await getMetadata(f1);
          let { ino: f2Ino, kind: f2Kind } = await getMetadata(f2);
          fs.remove(f1);

          let res = await nextEvent();
          if (backend === 'watchman') {
            // Watchman does not notify of individual actions but that changes
            // occured on some watched elements. The WatchmanBackend then
            // generates events for every changed document in path order.
            assert.deepEqual(res, [
              {type: 'delete', path: f1, kind: f1Kind, ino: f1Ino},
              {type: 'delete', path: f2, kind: f2Kind, ino: f2Ino},
            ]);
          } else {
            assert.deepEqual(res, [
              {type: 'delete', path: f2, kind: f2Kind, ino: f2Ino},
              {type: 'delete', path: f1, kind: f1Kind, ino: f1Ino},
            ]);
          }
        });

        it('should emit when a sub-directory is deleted with directories inside', async () => {
          if (backend === 'watchman') {
            // It seems that watchman emits the second delete event before the
            // first create event when rapidly renaming a directory and one of
            // its child so our test is failing in that case.
            return;
          }

          let base = getFilename();
          await fs.mkdir(base);
          await nextEvent();

          let getPath = p => path.join(base, p);

          await fs.mkdir(getPath('dir'));
          let { ino: dirIno, kind: dirKind } = await getMetadata(getPath('dir'));
          await nextEvent();
          await fs.mkdir(getPath('dir/subdir'));
          let { ino: subdirIno, kind: subdirKind } = await getMetadata(getPath('dir/subdir'));
          await nextEvent();

          await fs.rename(getPath('dir'), getPath('dir2'));
          await fs.rename(getPath('dir2/subdir'), getPath('dir2/subdir2'));

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: getPath('dir'), path: getPath('dir2'), ino: dirIno, kind: dirKind},
            {type: 'rename', oldPath: getPath('dir2/subdir'), path: getPath('dir2/subdir2'), ino: subdirIno, kind: subdirKind},
          ]);
        });

        it('should emit when a directory is deleted after its ancestor was renamed', async () => {
          if (backend === 'watchman' || backend === 'fsevents') {
            // Not implemented yet
            return;
          }

          let base = getFilename();
          await fs.mkdir(base);
          await nextEvent();

          let getPath = p => path.join(base, p);

          await fs.mkdir(getPath('dir'));
          let { ino: dirIno, kind: dirKind } = await getMetadata(getPath('dir'));
          await nextEvent();
          await fs.mkdir(getPath('dir/subdir'));
          let { ino: subdirIno, kind: subdirKind } = await getMetadata(getPath('dir/subdir'));
          await nextEvent();
          await fs.mkdir(getPath('dir/subdir/subsubdir'));
          let { ino: subsubdirIno, kind: subsubdirKind } = await getMetadata(getPath('dir/subdir/subsubdir'));
          await nextEvent();

          await fs.rename(getPath('dir'), getPath('dir2'));
          await fs.remove(getPath('dir2/subdir/subsubdir'));

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: getPath('dir'), path: getPath('dir2'), ino: dirIno, kind: dirKind},
            // XXX: No ino here as the dir entry for subsubdir was removed with
            // dir's dir entry when it was renamed.
            {type: 'delete', path: getPath('dir2/subdir/subsubdir'), kind: subsubdirKind},
          ]);
        });
      });

      describe('symlinks', () => {
        it('should emit when a symlink is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          await fs.symlink(f1, f2);
          let { ino, kind } = await getMetadata(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
        });

        it('should emit when a symlink is updated', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          await fs.symlink(f1, f2);
          await nextEvent();

          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(f2, 'hi');

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'update', path: f1, kind, ino}]);
        });

        it('should emit when a symlink is renamed', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          let f3 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          await fs.symlink(f1, f2);
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();

          await fs.rename(f2, f3);

          let res = await nextEvent();
          assert.deepEqual(res, [
            {type: 'rename', oldPath: f2, path: f3, kind, ino},
          ]);
        });

        it('should emit when a symlink is deleted', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          await fs.symlink(f1, f2);
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();

          fs.unlink(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f2, kind, ino}]);
        });

        it('should not crash when a folder symlink is created', async () => {
          let f1 = getFilename();
          let f2 = getFilename();
          await fs.mkdir(f1);
          await nextEvent();

          await fs.symlink(f1, f2);
          let { ino, kind } = await getMetadata(f2);
          await nextEvent();

          fs.unlink(f2);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f2, kind, ino}]);
        });
      });

      describe('rapid changes', () => {
        it('should coalese create and update events', async () => {
          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await fs.writeFile(f1, 'updated');
          let { ino, kind } = await getMetadata(f1);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });

        it('should coalese delete and create events into a single update event', async () => {
          if (backend === 'watchman' && process.platform === 'linux') {
            // It seems that watchman on Linux emits a single event
            // when rapidly deleting and creating a file so our event
            // coalescing is not working in that case
            // https://github.com/parcel-bundler/watcher/pull/84#issuecomment-981117725
            // https://github.com/facebook/watchman/issues/980
            return;
          }

          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          await nextEvent();

          await fs.unlink(f1);
          await fs.writeFile(f1, 'hello world again');
          let { ino, kind } = await getMetadata(f1);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'update', path: f1, kind, ino}]);
        });

        if (backend !== 'fs-events') {
          it('should ignore files that are created and deleted rapidly', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await fs.writeFile(f2, 'hello world');
            fs.unlink(f2);

            let res = await nextEvent();
            assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
          });

          it('should coalese create and rename events', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await fs.rename(f1, f2);

            let res = await nextEvent();
            assert.deepEqual(res, [{type: 'create', path: f2, kind, ino}]);
          });

          it('should coalese multiple rename events', async () => {
            let f1 = getFilename();
            let f2 = getFilename();
            let f3 = getFilename();
            let f4 = getFilename();
            await fs.writeFile(f1, 'hello world');
            let { ino, kind } = await getMetadata(f1);
            await nextEvent();

            await fs.rename(f1, f2);
            await fs.rename(f2, f3);
            await fs.rename(f3, f4);

            let res = await nextEvent();
            assert.deepEqual(res, [{type: 'rename', oldPath: f1, path: f4, kind, ino}]);
          });
        }

        it('should coalese multiple update events', async () => {
          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          let { ino, kind } = await getMetadata(f1);
          await nextEvent();

          await fs.writeFile(f1, 'update');
          await fs.writeFile(f1, 'update2');
          await fs.writeFile(f1, 'update3');

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'update', path: f1, kind, ino}]);
        });

        it('should coalese update and delete events', async () => {
          let f1 = getFilename();
          await fs.writeFile(f1, 'hello world');
          let { ino, kind } = await getMetadata(f1);
          await nextEvent();

          await fs.writeFile(f1, 'update');
          fs.unlink(f1);

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'delete', path: f1, kind, ino}]);
        });
      });

      describe('ignore', () => {
        it('should ignore a directory', async () => {
          let f1 = getFilename();
          let f2 = getFilename(path.basename(ignoreDir));
          await fs.mkdir(ignoreDir);

          await fs.writeFile(f1, 'hello');
          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(f2, 'sup');

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });

        it('should ignore a file', async () => {
          let f1 = getFilename();

          await fs.writeFile(f1, 'hello');
          let { ino, kind } = await getMetadata(f1);
          await fs.writeFile(ignoreFile, 'sup');

          let res = await nextEvent();
          assert.deepEqual(res, [{type: 'create', path: f1, kind, ino}]);
        });
      });

      describe('multiple', () => {
        it('should support multiple watchers for the same directory', async () => {
          let dir = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.mkdirpSync(dir);
          await new Promise((resolve) => setTimeout(resolve, 100));

          function listen() {
            return new Promise(async (resolve) => {
              let sub = await watcher.subscribe(
                dir,
                async (err, events) => {
                  setImmediate(async () => {
                    await sub.unsubscribe();

                    resolve(events);
                  });
                },
                {backend},
              );
            });
          }

          let l1 = listen();
          let l2 = listen();
          await new Promise((resolve) => setTimeout(resolve, 100));

          let test1 = path.join(dir, 'test1.txt');
          await fs.writeFile(test1, 'test1');
          let { ino, kind } = await getMetadata(test1);

          let res = await Promise.all([l1, l2]);
          assert.deepEqual(res, [
            [{type: 'create', path: test1, kind, ino}],
            [{type: 'create', path: test1, kind, ino}],
          ]);
        });

        it('should support multiple watchers for the same directory with different ignore paths', async () => {
          let dir = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.mkdirpSync(dir);
          await new Promise((resolve) => setTimeout(resolve, 100));

          function listen(ignore) {
            return new Promise(async (resolve) => {
              let sub = await watcher.subscribe(
                dir,
                async (err, events) => {
                  setImmediate(async () => {
                    await sub.unsubscribe();

                    resolve(events);
                  });
                },
                {backend, ignore},
              );
            });
          }

          let test1 = path.join(dir, 'test1.txt');
          let test2 = path.join(dir, 'test2.txt');
          let l1 = listen([test1]);
          let l2 = listen([test2]);
          await new Promise((resolve) => setTimeout(resolve, 100));

          await fs.writeFile(test1, 'test1');
          let { ino: test1Ino, kind: test1Kind } = await getMetadata(test1);
          await fs.writeFile(test2, 'test1');
          let { ino: test2Ino, kind: test2Kind } = await getMetadata(test2);

          let res = await Promise.all([l1, l2]);
          assert.deepEqual(res, [
            [{type: 'create', path: test2, kind: test1Kind, ino: test2Ino}],
            [{type: 'create', path: test1, kind: test2Kind, ino: test1Ino}],
          ]);
        });

        it('should support multiple watchers for different directories', async () => {
          let dir1 = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          let dir2 = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.mkdirpSync(dir1);
          fs.mkdirpSync(dir2);
          await new Promise((resolve) => setTimeout(resolve, 100));

          function listen(dir) {
            return new Promise(async (resolve) => {
              let sub = await watcher.subscribe(
                dir,
                async (err, events) => {
                  setImmediate(async () => {
                    await sub.unsubscribe();

                    resolve(events);
                  });
                },
                {backend},
              );
            });
          }

          let test1 = path.join(dir1, 'test1.txt');
          let test2 = path.join(dir2, 'test1.txt');
          let l1 = listen(dir1);
          let l2 = listen(dir2);
          await new Promise((resolve) => setTimeout(resolve, 100));

          await fs.writeFile(test1, 'test1');
          let { ino: test1Ino, kind: test1Kind } = await getMetadata(test1);
          await fs.writeFile(test2, 'test1');
          let { ino: test2Ino, kind: test2Kind } = await getMetadata(test2);

          let res = await Promise.all([l1, l2]);
          assert.deepEqual(res, [
            [{type: 'create', path: test1, kind: test1Kind, ino: test1Ino}],
            [{type: 'create', path: test2, kind: test2Kind, ino: test2Ino}],
          ]);
        });

        it('should work when getting events since a snapshot on an already watched directory', async () => {
          let dir = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          let snapshot = path.join(
            fs.realpathSync(require('os').tmpdir()),
            Math.random().toString(31).slice(2),
          );
          fs.mkdirpSync(dir);
          await new Promise((resolve) => setTimeout(resolve, 100));

          function listen(dir) {
            return new Promise(async (resolve) => {
              let sub = await watcher.subscribe(
                dir,
                (err, events) => {
                  setImmediate(() => resolve([events, sub]));
                },
                {backend},
              );
            });
          }

          let test1 = path.join(dir, 'test1.txt');
          let test2 = path.join(dir, 'test2.txt');
          let l = listen(dir);
          await new Promise((resolve) => setTimeout(resolve, 100));

          await fs.writeFile(test1, 'hello1');
          let { ino: test1Ino, kind: test1Kind } = await getMetadata(test1);
          await new Promise((resolve) => setTimeout(resolve, 100));

          await watcher.writeSnapshot(dir, snapshot, {backend});
          await new Promise((resolve) => setTimeout(resolve, 1000));

          await fs.writeFile(test2, 'hello2');
          let { ino: test2Ino, kind: test2Kind } = await getMetadata(test2);
          await new Promise((resolve) => setTimeout(resolve, 100));

          let [watched, sub] = await l;
          assert.deepEqual(watched, [
            {type: 'create', path: test1, kind: test1Kind, ino: test1Ino},
          ]);

          let since = await watcher.getEventsSince(dir, snapshot, {backend});
          assert.deepEqual(since, [
            {type: 'create', path: test2, kind: test2Kind, ino: test2Ino},
          ]);

          await sub.unsubscribe();
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
            await watcher.subscribe(
              dir,
              (err, events) => {
                assert(false, 'Should not get here');
              },
              {backend},
            );
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
            await watcher.subscribe(
              file,
              (err, events) => {
                assert(false, 'Should not get here');
              },
              {backend},
            );
          } catch (err) {
            threw = true;
          }

          assert(threw, 'did not throw');
        });
      });
    });
  });

  if (backends.includes('watchman')) {
    describe('watchman errors', () => {
      it('should emit an error when watchman dies', async () => {
        let dir = path.join(
          fs.realpathSync(require('os').tmpdir()),
          Math.random().toString(31).slice(2),
        );
        fs.mkdirpSync(dir);
        await new Promise((resolve) => setTimeout(resolve, 100));

        let p = new Promise((resolve) => {
          watcher.subscribe(
            dir,
            (err, events) => {
              setImmediate(() => resolve(err));
            },
            {backend: 'watchman'},
          );
        });

        execSync('watchman shutdown-server');

        let err = await p;
        assert(err, 'No error was emitted');
      });
    });
  }
});
