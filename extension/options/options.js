import { loadSettings, normalizeHost, resetSettings, saveSettings, watchSettings } from "../shared/settings.js";

const $ = id => document.getElementById(id);
let settings = await loadSettings();
let statusTimer;

function flash(message) {
  $("status").textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1500);
}

async function save(patch) {
  await saveSettings(patch);
  flash("Saved");
}

function render() {
  for (const input of document.querySelectorAll("[data-key]")) {
    const value = settings[input.dataset.key];
    if (input.type === "checkbox") {
      input.checked = value;
    } else {
      input.value = value;
    }
  }
  for (const input of document.querySelectorAll("input[type=radio]")) {
    input.checked = settings[input.name] === input.value;
  }
  if (document.activeElement !== $("bypassHosts")) {
    $("bypassHosts").value = settings.bypassHosts.join("\n");
  }
  $("preview").style.background = settings.background;
  $("preview").style.color = settings.foreground;
}

for (const input of document.querySelectorAll("[data-key]")) {
  const key = input.dataset.key;
  if (input.type === "checkbox") {
    input.addEventListener("change", () => save({ [key]: input.checked }));
  } else {
    input.addEventListener("input", () => {
      $("preview").style[key === "background" ? "background" : "color"] = input.value;
    });
    input.addEventListener("change", () => save({ [key]: input.value }));
  }
}

for (const input of document.querySelectorAll("input[type=radio]")) {
  input.addEventListener("change", () => {
    const patch = { [input.name]: input.value };
    if (input.name === "mode" && input.value !== "off") {
      patch.lastDarkMode = input.value;
    }
    save(patch);
  });
}

$("bypassHosts").addEventListener("change", event => {
  const hosts = event.target.value.split(/[\s,]+/).map(normalizeHost).filter(Boolean);
  save({ bypassHosts: [...new Set(hosts)] });
});

$("reset").addEventListener("click", async () => {
  await resetSettings();
  flash("Defaults restored");
});

watchSettings(next => {
  settings = next;
  render();
});
render();
