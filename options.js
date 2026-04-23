function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function load() {
  const state = await send("getState");
  const target = document.querySelector(`input[name='mode'][value='${state.settings.blockerMode}']`);
  if (target) target.checked = true;
  document.querySelector("#sites").value = (state.settings.blockedSites || []).join("\n");
  document.querySelector("#breakSites").value = (state.settings.breakUnblockSites || []).join("\n");
}

document.querySelector("#save").addEventListener("click", async () => {
  const blockerMode = document.querySelector("input[name='mode']:checked")?.value || "focusOnly";
  const blockedSites = document.querySelector("#sites").value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  const breakUnblockSites = document.querySelector("#breakSites").value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);

  await send("updateSettings", {
    patch: { blockerMode, blockedSites, breakUnblockSites }
  });

  alert("Saved");
});

load();
