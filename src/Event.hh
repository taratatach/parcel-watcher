#ifndef EVENT_H
#define EVENT_H

#include <string>
#include <napi.h>
#include <mutex>
#include <map>
#include <iostream>
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
  Event(std::string path, bool isDir = false, ino_t ino = FAKE_INO, std::string fileId = FAKE_FILEID) : path(path), oldPath(""), ino(ino), fileId(fileId), isCreated(false), isDeleted(false), isDir(isDir) {
    //std::cout << "New Event { " << path << ", ino: " << ino << " }" << std::endl;
  }

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

  void print(std::string fn) {
    return;
    std::string id = fileId != "" ? fileId : std::to_string(ino);

    std::cout << fn << " Event { " << type() << " ";
    if (isRenamed()) {
      std::cout << oldPath << " → ";
    }
    std::cout << path << " " << kind() << " " << id << " }" << std::endl;
  }
};

class EventList {
public:
  void create(std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    //std::cout << std::endl << "EventList::create " << path << std::endl;
    Event *event = internalUpdate(path, isDir, ino, fileId);
    if (event->isDeleted) {
      // Assume update event when rapidly removed and created
      // https://github.com/parcel-bundler/watcher/issues/72
      event->isDeleted = false;
    } else {
      event->isCreated = true;
    }
    event->print("create");
  }

  Event *update(std::string path, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    //std::cout << std::endl << "EventList::update " << path << std::endl;
    Event *event = internalUpdate(path, false, ino, fileId);
    event->print("update");
    return event;
  }

  void remove(std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    //std::cout << std::endl << "EventList::remove " << path << std::endl;
    Event *event = internalUpdate(path, isDir, ino, fileId);
    if (event->isCreated) {
      // Ignore event when rapidly created and removed
      erase(path);
      event->print("ignore");
    } else {
      event->isDeleted = true;
      event->print("delete");
    }
  }

  void rename(std::string oldPath, std::string path, bool isDir, ino_t ino, std::string fileId = FAKE_FILEID) {
    std::lock_guard<std::mutex> l(mMutex);
    //std::cout << std::endl << "EventList::rename " << oldPath << " → " << path << std::endl;

    Event *overwritten = find(path);
    if (overwritten) {
      overwritten = internalUpdate(overwritten->path, overwritten->isDir, overwritten->ino, overwritten->fileId);
      if (overwritten->isCreated) {
        // Ignore event when rapidly created and removed
        erase(overwritten->path);
        overwritten->print("rename/ignore");
      } else {
        overwritten->isDeleted = true;
        overwritten->print("rename/delete");
      }
    }

    Event *oldEvent = find(oldPath);
    if (oldEvent) {
      //oldEvent->print("rename");
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
      event.print("rename");
    } else {
      // Replace moved temporary doc (i.e. rapidly created and removed) with
      // creation non temporary one.
      Event *event = internalUpdate(path, isDir, ino, fileId);
      if (event->isDeleted) {
        // Assume update of overwritten doc
        event->isDeleted = false;
      } else {
        event->isCreated = false;
      }
      event->oldPath = oldPath;
      event->print("rename/create");
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
      event.print("getEvents");
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
    //std::cout << "internalUpdate { " << path << ", ino: " << ino << " }" << std::endl;
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

    //for(auto it = mEvents.begin(); it != mEvents.end(); ++it) {
    //  it->print("internalUpdate");
    //}

    return event;
  }
  Event *find(std::string path) {
    //std::cout << "find " << path << std::endl;
    for(unsigned i=0; i<mEvents.size(); i++) {
      //std::cout << "  " << mEvents.at(i).path << std::endl;
      if (mEvents.at(i).path == path) {
        //std::cout << "found " << mEvents.at(i).path << " ⇓ " << std::endl;
        return &(mEvents.at(i));
      }
    }
    //std::cout << "find(" << path << ") = not found" << std::endl;
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
