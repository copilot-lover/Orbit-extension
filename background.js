const DEFAULT_STATE = {
  settings: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakEvery: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    blockedSites: ["youtube.com", "twitter.com", "x.com", "reddit.com"],
    blockerMode: "focusOnly",
    breakUnblockSites: ["youtube.com"],
    goalHours: 64
  },
  timer: {
    phase: "focus",
    status: "idle",
    startedAt: null,
    targetAt: null,
    pausedRemainingMs: null,
    completedFocusCount: 0,
    activeTaskId: null
  },
  tasks: [],
  stats: {
    manualHours: 0
  }
};

const ALARM_NAME = "orbit-phase-end";

async function getState() {
  const data = await chrome.storage.local.get(["orbitState"]);
  return {
    ...DEFAULT_STATE,
    ...(data.orbitState || {}),
    settings: { ...DEFAULT_STATE.settings, ...(data.orbitState?.settings || {}) },
    timer: { ...DEFAULT_STATE.timer, ...(data.orbitState?.timer || {}) },
    stats: { ...DEFAULT_STATE.stats, ...(data.orbitState?.stats || {}) }
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ orbitState: state });
}

const nowMs = () => Date.now();
const minutesToMs = (minutes) => minutes * 60 * 1000;

function phaseDurationMs(state, phase) {
  if (phase === "focus") return minutesToMs(state.settings.focusMinutes);
  if (phase === "shortBreak") return minutesToMs(state.settings.shortBreakMinutes);
  return minutesToMs(state.settings.longBreakMinutes);
}

function nextBreakPhase(state) {
  return state.timer.completedFocusCount > 0 &&
    state.timer.completedFocusCount % state.settings.longBreakEvery === 0
    ? "longBreak"
    : "shortBreak";
}

function isBlockedModeActive(state) {
  return state.settings.blockerMode === "always" ||
    (state.settings.blockerMode === "focusOnly" && state.timer.phase === "focus" && state.timer.status === "running");
}

function isBreakPhase(state) {
  return state.timer.phase === "shortBreak" || state.timer.phase === "longBreak";
}

function toUrlFilter(domain) {
  const cleaned = domain.replace(/^https?:\/\//, "").replace(/^\*\./, "").trim();
  return `||${cleaned}^`;
}

async function applyBlockingRules(state) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  if (!isBlockedModeActive(state)) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  const blockedSites = state.settings.blockedSites.filter(Boolean);
  const breakUnblockSet = new Set((state.settings.breakUnblockSites || []).map((s) => s.trim()).filter(Boolean));
  const effectiveBlockedSites = isBreakPhase(state)
    ? blockedSites.filter((site) => !breakUnblockSet.has(site.trim()))
    : blockedSites;

  const addRules = effectiveBlockedSites.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: toUrlFilter(domain),
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

function getRemainingMs(state) {
  if (state.timer.status === "paused") return state.timer.pausedRemainingMs ?? 0;
  if (state.timer.status !== "running" || !state.timer.targetAt) return phaseDurationMs(state, state.timer.phase);
  return Math.max(0, state.timer.targetAt - nowMs());
}

function awardCompletedFocusToTask(state) {
  if (!state.timer.activeTaskId) return;
  const task = state.tasks.find((t) => t.id === state.timer.activeTaskId);
  if (!task) return;
  const deltaSec = Math.floor(phaseDurationMs(state, "focus") / 1000);
  task.trackedSeconds = (task.trackedSeconds || 0) + deltaSec;
}

async function transitionToPhase(state, nextPhase, autoStart) {
  state.timer.phase = nextPhase;
  state.timer.status = autoStart ? "running" : "idle";
  state.timer.startedAt = autoStart ? nowMs() : null;
  state.timer.targetAt = autoStart ? nowMs() + phaseDurationMs(state, nextPhase) : null;
  state.timer.pausedRemainingMs = null;

  if (nextPhase !== "focus") {
    state.timer.activeTaskId = null;
  }

  await chrome.alarms.clear(ALARM_NAME);
  if (autoStart) {
    await chrome.alarms.create(ALARM_NAME, { when: state.timer.targetAt });
  }

  await applyBlockingRules(state);
  await saveState(state);
}

async function startTimer(activeTaskId = null) {
  const state = await getState();
  state.timer.status = "running";
  state.timer.startedAt = nowMs();
  state.timer.targetAt = nowMs() + phaseDurationMs(state, state.timer.phase);
  state.timer.pausedRemainingMs = null;
  state.timer.activeTaskId = state.timer.phase === "focus" ? activeTaskId : null;

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: state.timer.targetAt });
  await applyBlockingRules(state);
  await saveState(state);
}

async function pauseTimer() {
  const state = await getState();
  state.timer.pausedRemainingMs = getRemainingMs(state);
  state.timer.status = "paused";
  state.timer.targetAt = null;
  state.timer.startedAt = null;
  await chrome.alarms.clear(ALARM_NAME);
  await applyBlockingRules(state);
  await saveState(state);
}

async function resumeTimer() {
  const state = await getState();
  if (state.timer.status !== "paused") return;
  state.timer.status = "running";
  state.timer.startedAt = nowMs();
  state.timer.targetAt = nowMs() + (state.timer.pausedRemainingMs || 0);
  state.timer.pausedRemainingMs = null;
  await chrome.alarms.create(ALARM_NAME, { when: state.timer.targetAt });
  await applyBlockingRules(state);
  await saveState(state);
}

async function resetTimer() {
  const state = await getState();
  state.timer.status = "idle";
  state.timer.startedAt = null;
  state.timer.targetAt = null;
  state.timer.pausedRemainingMs = null;
  state.timer.phase = "focus";
  state.timer.activeTaskId = null;
  await chrome.alarms.clear(ALARM_NAME);
  await applyBlockingRules(state);
  await saveState(state);
}

async function updateSettings(patch) {
  const state = await getState();
  state.settings = { ...state.settings, ...patch };
  await applyBlockingRules(state);
  await saveState(state);
}

async function updateManualProgress(hours) {
  const state = await getState();
  state.stats.manualHours = Math.max(0, Number(hours) || 0);
  await saveState(state);
}

async function addTask(title) {
  const state = await getState();
  state.tasks.push({ id: crypto.randomUUID(), title: title.trim(), done: false, trackedSeconds: 0 });
  await saveState(state);
}

async function toggleTask(taskId) {
  const state = await getState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (task) task.done = !task.done;
  await saveState(state);
}

async function deleteTask(taskId) {
  const state = await getState();
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  if (state.timer.activeTaskId === taskId) state.timer.activeTaskId = null;
  await saveState(state);
}

async function getViewState() {
  const state = await getState();
  return { ...state, timer: { ...state.timer, remainingMs: getRemainingMs(state) } };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["orbitState"]);
  if (!existing.orbitState) await saveState(DEFAULT_STATE);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const state = await getState();

  if (state.timer.phase === "focus") {
    awardCompletedFocusToTask(state);
    state.timer.completedFocusCount += 1;
    const breakPhase = nextBreakPhase(state);
    await transitionToPhase(state, breakPhase, state.settings.autoStartBreaks);
  } else {
    await transitionToPhase(state, "focus", state.settings.autoStartFocus);
  }

  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "Orbit Focus Guard",
    message: "Phase complete. Open the extension to continue."
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "getState": sendResponse(await getViewState()); break;
      case "start": await startTimer(message.activeTaskId || null); sendResponse({ ok: true }); break;
      case "pause": await pauseTimer(); sendResponse({ ok: true }); break;
      case "resume": await resumeTimer(); sendResponse({ ok: true }); break;
      case "reset": await resetTimer(); sendResponse({ ok: true }); break;
      case "skip": {
        const state = await getState();
        if (state.timer.phase === "focus") {
          state.timer.completedFocusCount += 1;
          await transitionToPhase(state, nextBreakPhase(state), false);
        } else {
          await transitionToPhase(state, "focus", false);
        }
        sendResponse({ ok: true });
        break;
      }
      case "updateSettings": await updateSettings(message.patch || {}); sendResponse({ ok: true }); break;
      case "updateManualProgress": await updateManualProgress(message.hours); sendResponse({ ok: true }); break;
      case "addTask": await addTask(message.title || ""); sendResponse({ ok: true }); break;
      case "toggleTask": await toggleTask(message.taskId); sendResponse({ ok: true }); break;
      case "deleteTask": await deleteTask(message.taskId); sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;
});
