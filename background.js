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
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const withoutProtocol = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const hostOnly = withoutProtocol.split("/")[0].split("?")[0].split("#")[0].replace(/^\*\./, "");
  if (!DOMAIN_PATTERN.test(hostOnly)) return null;
  return hostOnly;
}

function normalizeDomainList(list) {
  const unique = new Set();
  for (const item of list || []) {
    const normalized = normalizeDomain(item);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function sanitizeSettingsPatch(patch) {
  const sanitized = {};
  if ("focusMinutes" in patch) sanitized.focusMinutes = clampNumber(patch.focusMinutes, 25, 1, 180);
  if ("shortBreakMinutes" in patch) sanitized.shortBreakMinutes = clampNumber(patch.shortBreakMinutes, 5, 1, 60);
  if ("longBreakMinutes" in patch) sanitized.longBreakMinutes = clampNumber(patch.longBreakMinutes, 15, 1, 90);
  if ("longBreakEvery" in patch) sanitized.longBreakEvery = clampNumber(patch.longBreakEvery, 4, 2, 10);
  if ("goalHours" in patch) sanitized.goalHours = clampNumber(patch.goalHours, 64, 1, 10000);
  if ("autoStartBreaks" in patch) sanitized.autoStartBreaks = Boolean(patch.autoStartBreaks);
  if ("autoStartFocus" in patch) sanitized.autoStartFocus = Boolean(patch.autoStartFocus);
  if ("blockerMode" in patch) {
    const allowed = new Set(["focusOnly", "always", "off"]);
    sanitized.blockerMode = allowed.has(patch.blockerMode) ? patch.blockerMode : "focusOnly";
  }
  if ("blockedSites" in patch) sanitized.blockedSites = normalizeDomainList(patch.blockedSites);
  if ("breakUnblockSites" in patch) sanitized.breakUnblockSites = normalizeDomainList(patch.breakUnblockSites);
  return sanitized;
}

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
  const cleaned = normalizeDomain(domain);
  return cleaned ? `||${cleaned}^` : null;
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

  const blockedSites = normalizeDomainList(state.settings.blockedSites);
  const breakUnblockSet = new Set(normalizeDomainList(state.settings.breakUnblockSites));
  const effectiveBlockedSites = isBreakPhase(state)
    ? blockedSites.filter((site) => !breakUnblockSet.has(site))
    : blockedSites;

  const addRules = effectiveBlockedSites
    .map((domain, i) => {
      const urlFilter = toUrlFilter(domain);
      if (!urlFilter) return null;
      return {
        id: i + 1,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter,
          resourceTypes: ["main_frame", "sub_frame"]
        }
      };
    })
    .filter(Boolean);

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
  state.settings = { ...state.settings, ...sanitizeSettingsPatch(patch || {}) };
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
  if (!existing.orbitState) {
    await saveState(DEFAULT_STATE);
    return;
  }
  const current = await getState();
  current.settings.blockedSites = normalizeDomainList(current.settings.blockedSites);
  current.settings.breakUnblockSites = normalizeDomainList(current.settings.breakUnblockSites);
  await saveState(current);
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
    try {
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
    } catch (error) {
      console.error("Orbit message handler error", error);
      sendResponse({ ok: false, error: "internal error" });
    }
  })();
  return true;
});
