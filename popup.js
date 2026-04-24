const $ = (sel) => document.querySelector(sel);

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function fmtMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtHours(sec) {
  return (sec / 3600).toFixed(1);
}

function humanPhase(phase) {
  if (phase === "focus") return "Focus";
  if (phase === "shortBreak") return "Short Break";
  return "Long Break";
}

async function refresh() {
  const state = await send("getState");
  $("#phaseLabel").textContent = `${humanPhase(state.timer.phase)} (${state.timer.status})`;
  $("#countdown").textContent = fmtMs(state.timer.remainingMs);
  $("#hourProgress").textContent = `${(state.stats.manualHours || 0).toFixed(1)} / ${(state.settings.goalHours || 64).toFixed(0)}h`;

  $("#manualHours").value = (state.stats.manualHours || 0).toFixed(1);
  $("#goalHours").value = state.settings.goalHours || 64;

  $("#focusMinutes").value = state.settings.focusMinutes;
  $("#shortBreakMinutes").value = state.settings.shortBreakMinutes;
  $("#longBreakMinutes").value = state.settings.longBreakMinutes;
  $("#longBreakEvery").value = state.settings.longBreakEvery;
  $("#autoStartBreaks").checked = state.settings.autoStartBreaks;
  $("#autoStartFocus").checked = state.settings.autoStartFocus;

  const taskList = $("#taskList");
  taskList.innerHTML = "";

  for (const task of state.tasks) {
    const li = document.createElement("li");
    li.className = task.done ? "done" : "";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "activeTask";
    radio.checked = state.timer.activeTaskId === task.id;
    radio.disabled = state.timer.phase !== "focus";
    radio.dataset.taskId = task.id;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = task.done;
    check.addEventListener("change", async () => {
      await send("toggleTask", { taskId: task.id });
      await refresh();
    });

    const label = document.createElement("span");
    label.textContent = `${task.title} (${fmtHours(task.trackedSeconds || 0)}h)`;

    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      await send("deleteTask", { taskId: task.id });
      await refresh();
    });

    li.append(check, label, radio, del);
    taskList.append(li);
  }
}

window.orbitUI = {
  async start() {
    const activeRadio = document.querySelector("input[name='activeTask']:checked");
    await send("start", { activeTaskId: activeRadio?.dataset.taskId || null });
    await refresh();
  },
  async pause() { await send("pause"); await refresh(); },
  async resume() { await send("resume"); await refresh(); },
  async reset() { await send("reset"); await refresh(); },
  async skip() { await send("skip"); await refresh(); }
};

$("#startBtn").addEventListener("click", () => window.orbitUI.start());
$("#pauseBtn").addEventListener("click", () => window.orbitUI.pause());
$("#resumeBtn").addEventListener("click", () => window.orbitUI.resume());
$("#skipBtn").addEventListener("click", () => window.orbitUI.skip());
$("#resetBtn").addEventListener("click", () => window.orbitUI.reset());

$("#taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#taskInput").value.trim();
  if (!title) return;
  await send("addTask", { title });
  $("#taskInput").value = "";
  await refresh();
});

$("#saveSettings").addEventListener("click", async () => {
  await send("updateSettings", {
    patch: {
      focusMinutes: Number($("#focusMinutes").value),
      shortBreakMinutes: Number($("#shortBreakMinutes").value),
      longBreakMinutes: Number($("#longBreakMinutes").value),
      longBreakEvery: Number($("#longBreakEvery").value),
      autoStartBreaks: $("#autoStartBreaks").checked,
      autoStartFocus: $("#autoStartFocus").checked,
      goalHours: Number($("#goalHours").value) || 64
    }
  });
  await refresh();
});

$("#saveProgress").addEventListener("click", async () => {
  await send("updateManualProgress", { hours: Number($("#manualHours").value) });
  await refresh();
});

$("#plusHalf").addEventListener("click", async () => {
  await send("updateManualProgress", { hours: Number($("#manualHours").value) + 0.5 });
  await refresh();
});

$("#minusHalf").addEventListener("click", async () => {
  await send("updateManualProgress", { hours: Math.max(0, Number($("#manualHours").value) - 0.5) });
  await refresh();
});

refresh();
setInterval(refresh, 1000);
