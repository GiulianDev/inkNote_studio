import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDockAutoHideController,
  DOCK_BUFFER_STATES,
  DEFAULT_WRITING_INACTIVITY_MS
} from './dock-autohide.js';

function createFakeClock(initialMs = 1000) {
  let timeMs = initialMs;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => timeMs,
    scheduleTimer: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, triggerAt: timeMs + delay });
      return id;
    },
    cancelTimer: (id) => {
      timers.delete(id);
    },
    advanceBy: (ms) => {
      const target = timeMs + ms;
      while (true) {
        let earliest = null;
        for (const [id, entry] of timers.entries()) {
          if (entry.triggerAt <= target && (!earliest || entry.triggerAt < earliest.triggerAt)) {
            earliest = { id, ...entry };
          }
        }
        if (!earliest) break;
        timeMs = earliest.triggerAt;
        timers.delete(earliest.id);
        earliest.fn();
      }
      timeMs = target;
    },
    activeTimerCount: () => timers.size
  };
}

test('stays idle and visible when disabled', () => {
  const events = [];
  const clock = createFakeClock();
  const ctrl = createDockAutoHideController({
    enabled: false,
    onVisibilityChange: (hidden) => events.push(hidden),
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer
  });

  assert.equal(ctrl.beginWriting(), false);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.deepEqual(events, []);
});

test('buffers across natural writing pauses without flickering', () => {
  const events = [];
  const clock = createFakeClock();
  const ctrl = createDockAutoHideController({
    inactivityDelayMs: DEFAULT_WRITING_INACTIVITY_MS,
    enabled: true,
    onVisibilityChange: (hidden) => events.push(hidden),
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer
  });

  // Stroke 1
  ctrl.beginWriting();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.WRITING);
  assert.equal(ctrl.isHidden(), true);

  clock.advanceBy(250);
  ctrl.endWriting();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);
  assert.equal(ctrl.isHidden(), true);

  // Natural pause between letters/words (900ms < 1200ms)
  clock.advanceBy(900);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);
  assert.equal(ctrl.isHidden(), true);
  assert.deepEqual(events, [true]);

  // Stroke 2 restarts writing cleanly with zero reveal flicker
  ctrl.beginWriting();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.WRITING);
  assert.equal(clock.activeTimerCount(), 0);
  clock.advanceBy(180);
  ctrl.endWriting();

  // Pause 1ms short of threshold -> still hidden in buffering state
  clock.advanceBy(DEFAULT_WRITING_INACTIVITY_MS - 1);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);
  assert.equal(ctrl.isHidden(), true);
  assert.deepEqual(events, [true]);

  // Consistent inactivity threshold reached -> transitions to idle and reveals once
  clock.advanceBy(1);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.deepEqual(events, [true, false]);
});

test('keepWritingAlive extends buffering countdown from latest activity timestamp', () => {
  const events = [];
  const clock = createFakeClock();
  const ctrl = createDockAutoHideController({
    inactivityDelayMs: 1000,
    enabled: true,
    onVisibilityChange: (hidden) => events.push(hidden),
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer
  });

  ctrl.beginWriting();
  ctrl.endWriting();
  clock.advanceBy(700);
  assert.equal(ctrl.isHidden(), true);

  // Activity ping resets consistent inactivity requirement
  ctrl.keepWritingAlive();
  clock.advanceBy(700);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);
  assert.equal(ctrl.isHidden(), true);

  clock.advanceBy(300);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.deepEqual(events, [true, false]);
});

test('reschedules if timer callback fires early before full inactivity window', () => {
  let scheduledCb = null;
  let scheduledDelay = null;
  let timeMs = 5000;
  const events = [];

  const ctrl = createDockAutoHideController({
    inactivityDelayMs: 1200,
    enabled: true,
    onVisibilityChange: (hidden) => events.push(hidden),
    now: () => timeMs,
    scheduleTimer: (fn, ms) => {
      scheduledCb = fn;
      scheduledDelay = ms;
      return 1;
    },
    cancelTimer: () => {
      scheduledCb = null;
    }
  });

  ctrl.beginWriting();
  ctrl.endWriting();
  assert.equal(scheduledDelay, 1200);

  // Simulate browser firing timer early at +800ms
  timeMs += 800;
  scheduledCb();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);
  assert.equal(ctrl.isHidden(), true);
  assert.equal(scheduledDelay, 400);

  // Remaining 400ms elapses -> reveals now
  timeMs += 400;
  scheduledCb();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.deepEqual(events, [true, false]);
});

test('revealNow and setEnabled(false) cancel pending buffer immediately', () => {
  const events = [];
  const clock = createFakeClock();
  const ctrl = createDockAutoHideController({
    inactivityDelayMs: 1200,
    enabled: true,
    onVisibilityChange: (hidden) => events.push(hidden),
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer
  });

  ctrl.beginWriting();
  ctrl.endWriting();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.BUFFERING);

  ctrl.revealNow();
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.equal(clock.activeTimerCount(), 0);
  assert.deepEqual(events, [true, false]);

  ctrl.beginWriting();
  ctrl.endWriting();
  ctrl.setEnabled(false);
  assert.equal(ctrl.getState(), DOCK_BUFFER_STATES.IDLE);
  assert.equal(ctrl.isHidden(), false);
  assert.equal(clock.activeTimerCount(), 0);
  assert.deepEqual(events, [true, false, true, false]);
});
