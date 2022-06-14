#include <unordered_set>
#include <iostream>
#include <napi.h>
#include <node_api.h>
#include "Event.hh"
#include "Backend.hh"
#include "Watcher.hh"
#include "PromiseRunner.hh"

using namespace Napi;

std::unordered_set<std::string> getIgnore(Env env, Value opts) {
  std::unordered_set<std::string> ignore;

  if (opts.IsObject()) {
    Value v = opts.As<Object>().Get(String::New(env, "ignore"));
    if (v.IsArray()) {
      Array items = v.As<Array>();
      for (size_t i = 0; i < items.Length(); i++) {
        Value item = items.Get(Number::New(env, i));
        if (item.IsString()) {
          ignore.insert(std::string(item.As<String>().Utf8Value().c_str()));
        }
      }
    }
  }

  return ignore;
}

std::shared_ptr<Backend> getBackend(Env env, Value opts) {
  Value b = opts.As<Object>().Get(String::New(env, "backend"));
  std::string backendName;
  if (b.IsString()) {
    backendName = std::string(b.As<String>().Utf8Value().c_str());
  }

  return Backend::getShared(backendName);
}

std::shared_ptr<DirEntry> buildDirEntry(Env env, Value entry) {
  Value path = entry.As<Object>().Get(String::New(env, "path"));
  Value ino = entry.As<Object>().Get(String::New(env, "ino"));
  Value mtime = entry.As<Object>().Get(String::New(env, "mtime"));
  Value isDir = entry.As<Object>().Get(String::New(env, "isDir"));

  DirEntry direntry{
    std::string(path.As<String>().Utf8Value().c_str()),
    ino_t(ino.As<Number>().Int64Value()),
    uint64_t(mtime.As<Number>().Int64Value()),
    bool(isDir.As<Boolean>())
  };

  return std::make_shared<DirEntry>(direntry);
}

class WriteSnapshotRunner : public PromiseRunner {
public:
  WriteSnapshotRunner(Env env, Value dir, Value snap, Value opts)
    : PromiseRunner(env),
      snapshotPath(std::string(snap.As<String>().Utf8Value().c_str())) {
    watcher = Watcher::getShared(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    backend = getBackend(env, opts);
  }

  ~WriteSnapshotRunner() {
    watcher->unref();
    backend->unref();
  }
private:
  std::shared_ptr<Backend> backend;
  std::shared_ptr<Watcher> watcher;
  std::string snapshotPath;

  void execute() override {
    backend->writeSnapshot(*watcher, &snapshotPath);
  }
};

class UpdateSnapshotRunner : public PromiseRunner {
public:
  UpdateSnapshotRunner(Env env, Value dir, Value snap, Value entry, Value opts)
    : PromiseRunner(env),
      snapshotPath(std::string(snap.As<String>().Utf8Value().c_str())),
      eventType(std::string(entry.As<Object>().Get(String::New(env, "eventType")).As<String>().Utf8Value().c_str())) {
    watcher = Watcher::getShared(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    direntry = buildDirEntry(env, entry);

    backend = getBackend(env, opts);
  }

  ~UpdateSnapshotRunner() {
    watcher->unref();
    backend->unref();
  }
private:
  std::shared_ptr<Backend> backend;
  std::shared_ptr<Watcher> watcher;
  std::shared_ptr<DirEntry> direntry;
  std::string snapshotPath;
  std::string eventType;

  void execute() override {
    backend->updateSnapshot(*watcher, &snapshotPath, direntry, &eventType);
  }
};

class GetEventsSinceRunner : public PromiseRunner {
public:
  GetEventsSinceRunner(Env env, Value dir, Value snap, Value opts)
    : PromiseRunner(env),
      snapshotPath(std::string(snap.As<String>().Utf8Value().c_str())) {
    watcher = std::make_shared<Watcher>(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    backend = getBackend(env, opts);
  }

  ~GetEventsSinceRunner() {
    watcher->unref();
    backend->unref();
  }
private:
  std::shared_ptr<Backend> backend;
  std::shared_ptr<Watcher> watcher;
  std::string snapshotPath;

  void execute() override {
    backend->getEventsSince(*watcher, &snapshotPath);
  }

  Value getResult() override {
    std::vector<Event> events = watcher->mEvents.getEvents();
    Array eventsArray = Array::New(env, events.size());
    size_t i = 0;
    for (auto it = events.begin(); it != events.end(); it++) {
      eventsArray.Set(i++, it->toJS(env));
    }
    return eventsArray;
  }
};

template<class Runner>
Value queueSnapshotWork(const CallbackInfo& info) {
  Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 2 || !info[1].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() >= 3 && !info[2].IsObject()) {
    TypeError::New(env, "Expected an object").ThrowAsJavaScriptException();
    return env.Null();
  }

  Runner *runner = new Runner(info.Env(), info[0], info[1], info[2]);
  return runner->queue();
}

Value writeSnapshot(const CallbackInfo& info) {
  return queueSnapshotWork<WriteSnapshotRunner>(info);
}

Value updateSnapshot(const CallbackInfo& info) {
  Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 2 || !info[1].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 3 || !info[2].IsObject()) {
    TypeError::New(env, "Expected an object").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() >= 4 || !info[3].IsObject()) {
    TypeError::New(env, "Expected an object").ThrowAsJavaScriptException();
    return env.Null();
  }

  UpdateSnapshotRunner *runner = new UpdateSnapshotRunner(info.Env(), info[0], info[1], info[2], info[3]);
  return runner->queue();
}

Value getEventsSince(const CallbackInfo& info) {
  return queueSnapshotWork<GetEventsSinceRunner>(info);
}

class ScanRunner : public PromiseRunner {
public:
  ScanRunner(Env env, Value dir, Value opts) : PromiseRunner(env) {
    watcher = std::make_shared<Watcher>(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    backend = getBackend(env, opts);
  }

  ~ScanRunner() {
    watcher->unref();
    backend->unref();
  }

private:
  std::shared_ptr<Watcher> watcher;
  std::shared_ptr<Backend> backend;
  std::string scannedDir;

  void execute() override {
    backend->scan(*watcher);
  }

  Value getResult() override {
    std::vector<Event> events = watcher->mEvents.getEvents();
    Array eventsArray = Array::New(env, events.size());
    size_t i = 0;
    for (auto it = events.begin(); it != events.end(); it++) {
      if (it->path != watcher->mDir) {
        eventsArray.Set(i++, it->toJS(env));
      }
    }
    return eventsArray;
  }
};

class SubscribeRunner : public PromiseRunner {
public:
  SubscribeRunner(Env env, Value dir, Value fn, Value opts) : PromiseRunner(env) {
    watcher = Watcher::getShared(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    backend = getBackend(env, opts);
    callback = Persistent(fn.As<Function>());
  }

private:
  std::shared_ptr<Watcher> watcher;
  std::shared_ptr<Backend> backend;
  FunctionReference callback;

  void execute() override {
    backend->watch(*watcher);
    watcher->watch(std::move(callback));
  }
};

class UnsubscribeRunner : public PromiseRunner {
public:
  UnsubscribeRunner(Env env, Value dir, Value fn, Value opts) : PromiseRunner(env) {
    watcher = Watcher::getShared(
      std::string(dir.As<String>().Utf8Value().c_str()),
      getIgnore(env, opts)
    );

    backend = getBackend(env, opts);
    shouldUnwatch = watcher->unwatch(fn.As<Function>());
  }

private:
  std::shared_ptr<Watcher> watcher;
  std::shared_ptr<Backend> backend;
  bool shouldUnwatch;

  void execute() override {
    if (shouldUnwatch) {
      backend->unwatch(*watcher);
    }
  }
};

template<class Runner>
Value queueSubscriptionWork(const CallbackInfo& info) {
  Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 2 || !info[1].IsFunction()) {
    TypeError::New(env, "Expected a function").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() >= 3 && !info[2].IsObject()) {
    TypeError::New(env, "Expected an object").ThrowAsJavaScriptException();
    return env.Null();
  }

  Runner *runner = new Runner(info.Env(), info[0], info[1], info[2]);
  return runner->queue();
}

Value subscribe(const CallbackInfo& info) {
  return queueSubscriptionWork<SubscribeRunner>(info);
}

Value unsubscribe(const CallbackInfo& info) {
  return queueSubscriptionWork<UnsubscribeRunner>(info);
}

Value scan(const CallbackInfo& info) {
  Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    TypeError::New(env, "Expected a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() >= 2 && !info[1].IsObject()) {
    TypeError::New(env, "Expected an object").ThrowAsJavaScriptException();
    return env.Null();
  }

  ScanRunner *runner = new ScanRunner(info.Env(), info[0], info[1]);
  return runner->queue();
}

Object Init(Env env, Object exports) {
  exports.Set(
    String::New(env, "scan"),
    Function::New(env, scan)
  );
  exports.Set(
    String::New(env, "writeSnapshot"),
    Function::New(env, writeSnapshot)
  );
  exports.Set(
    String::New(env, "updateSnapshot"),
    Function::New(env, updateSnapshot)
  );
  exports.Set(
    String::New(env, "getEventsSince"),
    Function::New(env, getEventsSince)
  );
  exports.Set(
    String::New(env, "subscribe"),
    Function::New(env, subscribe)
  );
  exports.Set(
    String::New(env, "unsubscribe"),
    Function::New(env, unsubscribe)
  );
  return exports;
}

NODE_API_MODULE(watcher, Init)
