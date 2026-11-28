/**
 * @module shared/core/tab-sync
 *
 * Coordinamento multi-tab tramite BroadcastChannel.
 * Notifica alle altre schede aperte creazioni/eliminazioni/aggiornamenti
 * della libreria, modifiche a quaderni aperti e completamento cloud sync.
 */

const CHANNEL_NAME = 'inknote_studio_tab_sync_v1';

function _generateTabId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createTabSyncController({
  channelFactory = null,
  tabId = _generateTabId(),
  channelName = CHANNEL_NAME
} = {}) {
  const listeners = new Map();
  let channel = null;

  const resolveFactory = () => {
    if (typeof channelFactory === 'function') return channelFactory;
    if (typeof BroadcastChannel === 'function') {
      return (name) => new BroadcastChannel(name);
    }
    return null;
  };

  const ensureChannel = () => {
    if (channel) return channel;
    const factory = resolveFactory();
    if (!factory) return null;
    try {
      channel = factory(channelName);
      if (channel) {
        channel.onmessage = (event) => {
          const msg = event?.data;
          if (!msg || typeof msg !== 'object') return;
          if (!msg.type || msg.senderTabId === tabId) return;
          const set = listeners.get(msg.type);
          if (!set || set.size === 0) return;
          for (const fn of Array.from(set)) {
            try {
              fn(msg.payload, msg);
            } catch (err) {
              console.error('[tab-sync] listener failed:', err);
            }
          }
        };
      }
    } catch {
      channel = null;
    }
    return channel;
  };

  const onTabEvent = (type, fn) => {
    if (!type || typeof fn !== 'function') return () => {};
    ensureChannel();
    if (!listeners.has(type)) listeners.set(type, new Set());
    const set = listeners.get(type);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };

  const broadcast = (type, payload = {}) => {
    if (!type) return false;
    const ch = ensureChannel();
    if (!ch || typeof ch.postMessage !== 'function') return false;
    try {
      ch.postMessage({
        type,
        payload,
        senderTabId: tabId,
        ts: Date.now()
      });
      return true;
    } catch {
      return false;
    }
  };

  const destroy = () => {
    listeners.clear();
    if (channel) {
      try {
        channel.onmessage = null;
        if (typeof channel.close === 'function') channel.close();
      } catch {
        // ignore close errors
      }
      channel = null;
    }
  };

  return {
    tabId,
    onTabEvent,
    broadcast,
    destroy
  };
}

let _defaultController = null;

function _getDefaultController() {
  if (!_defaultController) {
    _defaultController = createTabSyncController();
  }
  return _defaultController;
}

export function initTabSync(handlers = {}) {
  const ctrl = _getDefaultController();
  const unsubs = [];
  for (const [type, fn] of Object.entries(handlers || {})) {
    if (typeof fn === 'function') {
      unsubs.push(ctrl.onTabEvent(type, fn));
    }
  }
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function broadcastTabEvent(type, payload = {}) {
  return _getDefaultController().broadcast(type, payload);
}

export function getTabId() {
  return _getDefaultController().tabId;
}

export function destroyTabSync() {
  if (_defaultController) {
    _defaultController.destroy();
    _defaultController = null;
  }
}
