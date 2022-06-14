#include <string>
#include <fstream>
#include "../DirTree.hh"
#include "../Event.hh"
#include "./BruteForceBackend.hh"

std::shared_ptr<DirTree> BruteForceBackend::getTree(Watcher &watcher, bool shouldRead, bool recursiveRemove) {
  auto tree = DirTree::getCached(watcher.mDir, recursiveRemove);
  //std::cout << "getTree " << watcher.mDir << std::endl;

  // If the tree is not complete, read it if needed.
  if (!tree->isComplete && shouldRead) {
    readTree(watcher, tree);
    tree->isComplete = true;
  }

  //std::cout << "entries: " << std::endl;

  return tree;
}

void BruteForceBackend::scan(Watcher &watcher) {
  std::unique_lock<std::mutex> lock(mMutex);
  auto tree = getTree(watcher);
  for (auto it = tree->entries.begin(); it != tree->entries.end(); it++) {
    //std::cout << "BruteForceBackend::scan entry " << it->first << " " << it->second.path << std::endl;
    watcher.mEvents.create(it->second.path, it->second.ino, it->second.isDir, it->second.fileId);
  }
}

void BruteForceBackend::writeSnapshot(Watcher &watcher, std::string *snapshotPath) {
  std::unique_lock<std::mutex> lock(mMutex);
  auto tree = getTree(watcher);
  std::ofstream ofs(*snapshotPath);
  tree->write(ofs);
}

void BruteForceBackend::updateSnapshot(Watcher &watcher, std::string *snapshotPath, std::shared_ptr<DirEntry> direntry, std::string *eventType) {
  std::unique_lock<std::mutex> lock(mMutex);
  auto tree = DirTree::getCached(watcher.mDir);

  auto found = tree->entries.find(direntry->path);
  if (*eventType == "create" || *eventType == "update") {
    if (found == tree->entries.end()) {
      tree->add(direntry->path, direntry->ino, direntry->mtime, direntry->isDir, direntry->fileId);
    } else if (found->second.isDir == direntry->isDir) {
      tree->update(direntry->path, direntry->ino, direntry->mtime, direntry->fileId);
    } else {
      tree->remove(direntry->path);
      tree->add(direntry->path, direntry->ino, direntry->mtime, direntry->isDir, direntry->fileId);
    }
  } else if (*eventType == "delete") {
    if (found != tree->entries.end()) {
      tree->remove(direntry->path);
    }
  }
}

void BruteForceBackend::getEventsSince(Watcher &watcher, std::string *snapshotPath) {
  std::unique_lock<std::mutex> lock(mMutex);
  std::ifstream ifs(*snapshotPath);
  if (ifs.fail()) {
    return;
  }

  DirTree snapshot{watcher.mDir, ifs};
  auto now = getTree(watcher);
  now->getChanges(&snapshot, watcher.mEvents);
}
