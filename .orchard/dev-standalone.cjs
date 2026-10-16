const Module = require('node:module');
const { sep } = require('node:path');

const target = `${sep}apply${sep}apply-queue.service.js`;
const load = Module._load;

Module._load = function (request, parent, isMain) {
  const exported = load.apply(this, arguments);
  if (!request.includes('apply-queue.service')) return exported;
  let file;
  try {
    file = Module._resolveFilename(request, parent, isMain);
  } catch {
    return exported;
  }
  const Queue = exported?.ApplyQueueService;
  if (!file.endsWith(target) || !Queue || Queue.prototype.__orchardDevStandalone) return exported;
  const init = Queue.prototype.onModuleInit;
  Queue.prototype.onModuleInit = function () {
    const lease = this.lease;
    if (lease.canCoordinate) return init.call(this);
    Object.defineProperty(lease, 'canCoordinate', { value: true, configurable: true });
    try {
      return init.call(this);
    } finally {
      delete lease.canCoordinate;
      console.log('[dev] apply queue draining without a cluster (.orchard/dev-standalone.cjs)');
    }
  };
  Queue.prototype.__orchardDevStandalone = true;
  return exported;
};
