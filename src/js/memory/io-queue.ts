type Task<T> = () => Promise<T> | T;

// Serialize disk/CLI IO per userId to prevent bursts from causing IO storms.
const queueByUserId = new Map<string, Promise<unknown>>();

export function enqueueUserIo<T>(userId: string, task: Task<T>): Promise<T> {
  const key = String(userId || "unknown");
  const prev = queueByUserId.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  queueByUserId.set(key, run.then(() => undefined, () => undefined));
  return run;
}

