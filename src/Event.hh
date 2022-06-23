#ifndef EVENT_H
#define EVENT_H

#include <string>
#include <napi.h>
#include <mutex>
#include <map>
#include "const.hh"

using namespace Napi;

struct Event {
  std::string path;
  std::string oldPath;
  ino_t ino;
  std::string fileId;
  bool isCreated;
  bool isDeleted;
  bool isDir;
  Event(std::string path, bool isDir = false, ino_t ino = FAKE_INO, std::string fileId = FAKE_FILEID) : path(path), oldPath(""), ino(ino), fileId(fileId), isCreated(false), isDeleted(false), isDir(isDir) {}

  bool isRenamed() {
    return !isCreated && !isDeleted && oldPath != "";
  }

  std::string type() {
    return isRenamed() ? "rename" : isCreated ? "create" : isDeleted ? "delete" : "update";
  }

  std::string kind() {
    return isDir ? "directory" : "file";
  }

  Value toJS(const Env& env) {
    EscapableHandleScope scope(env);
    Object res = Object::New(env);
    res.Set(String::New(env, "path"), String::New(env, path.c_str()));
    res.Set(String::New(env, "type"), String::New(env, type().c_str()));
    res.Set(String::New(env, "kind"), String::New(env, kind().c_str()));

    if (ino != FAKE_INO) {
      res.Set(String::New(env, "ino"), String::New(env, std::to_string(ino).c_str()));
    }
    if (fileId != FAKE_FILEID) {
      res.Set(String::New(env, "fileId"), String::New(env, fileId.c_str()));
    }

    if (isRenamed()) {
      res.Set(String::New(env, "oldPath"), String::New(env, oldPath.c_str()));
    }

    return scope.Escape(res);
  }
};

class EventList {
public:
  void create(std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    Event *event = internalUpdate(path, isDir, ino, fileId);
    if (event->isDeleted) {
      // Assume update event when rapidly removed and created
      // https://github.com/parcel-bundler/watcher/issues/72
      event->isDeleted = false;
    } else {
      event->isCreated = true;
    }
  }

  Event *update(std::string path, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    return internalUpdate(path, false, ino, fileId);
  }

  void remove(std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    Event *event = internalUpdate(path, isDir, ino, fileId);
    if (event->isCreated) {
      // Ignore event when rapidly created and removed
      erase(path);
    } else {
      event->isDeleted = true;
    }
  }

  void rename(std::string oldPath, std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);

    Event *overwritten = find(path);
    if (overwritten) {
      overwritten = internalUpdate(overwritten->path, overwritten->isDir, overwritten->ino, overwritten->fileId);
      if (overwritten->isCreated) {
        // Ignore event when rapidly created and removed
        erase(overwritten->path);
      } else {
        overwritten->isDeleted = true;
      }
    }

    Event *oldEvent = find(oldPath);
    if (oldEvent) {
      ino_t oldIno = oldEvent->ino;
      std::string oldFileId = oldEvent->fileId;
      std::string oldOldPath = oldEvent->oldPath;
      erase(oldPath);

      Event event = Event(
          path,
          isDir,
          ino == FAKE_INO ? oldIno : ino,
          fileId == FAKE_FILEID ? oldFileId : fileId
        );
      event.oldPath = oldOldPath != "" ? oldOldPath : oldPath;
      mEvents.push_back(event);
    } else {
      // Replace moved temporary doc (i.e. rapidly created and removed) with
      // creation non temporary one.
      Event *event = internalUpdate(path, isDir, ino, fileId);
      if (event->isDeleted) {
        // Assume update of overwritten doc
        event->isDeleted = false;
      } else {
        event->isCreated = true;
      }
    }
  }

  size_t size() {
    std::lock_guard<std::mutex> l(mMutex);
    return mEvents.size();
  }

  std::vector<Event> getEvents() {
    std::lock_guard<std::mutex> l(mMutex);
    std::vector<Event> eventsCloneVector;
    for(auto event : mEvents) {
      eventsCloneVector.push_back(event);
    }
    return eventsCloneVector;
  }

  void clear() {
    std::lock_guard<std::mutex> l(mMutex);
    mEvents.clear();
  }

private:
  mutable std::mutex mMutex;
  std::vector<Event> mEvents;
  Event *internalUpdate(std::string path, bool isDir, ino_t ino = FAKE_INO, std::string fileId = FAKE_FILEID) {
    Event *event;

    event = find(path);
    if (!event) {
      mEvents.push_back(Event(path, isDir, ino, fileId));
      event = &(mEvents.back());
    } else {
      if (ino != FAKE_INO) {
        event->ino = ino;
      }
      if (fileId != FAKE_FILEID) {
       event->fileId = fileId;
      }
    }
    event->isDir = isDir;

    return event;
  }
  Event *find(std::string path) {
    for(unsigned i=0; i<mEvents.size(); i++) {
      if (mEvents.at(i).path == path) {
        return &(mEvents.at(i));
      }
    }
    return nullptr;
  }
  void erase(std::string path) {
    for(auto it = mEvents.begin(); it != mEvents.end(); ++it) {
      if (it->path == path) {
        mEvents.erase(it);
        return;
      }
    }
  }
};

#endif
