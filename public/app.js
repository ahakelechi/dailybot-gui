// public/app.js
//
// Plain vanilla JS -- no framework, no build step. Talks to the local
// server's JSON API and renders the three tabs.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Theme (Ink / Paper)
  // ---------------------------------------------------------------------
  (function initTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById("themeToggle");
    var stored = null;
    try { stored = localStorage.getItem("dailybot-theme"); } catch (e) {}
    if (stored) root.setAttribute("data-theme", stored);

    function current() {
      if (root.getAttribute("data-theme")) return root.getAttribute("data-theme");
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    toggle.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("dailybot-theme", next); } catch (e) {}
    });
  })();

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "entries") {
        loadEntries();
        loadLocations();
      }
      if (btn.dataset.tab === "run") {
        loadReports();
        loadSession();
      }
      if (btn.dataset.tab === "scheduler") loadScheduler();
    });
  });

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  async function loadSettings() {
    const res = await fetch("/api/settings");
    const data = await res.json();
    document.getElementById("settings-email").value = data.email || "";
    document.getElementById("settings-lat").value = data.geoLatitude ?? "";
    document.getElementById("settings-lng").value = data.geoLongitude ?? "";
    document.getElementById("settings-headless").value = data.headless ? "true" : "false";

    // The field itself always clears after saving (a saved password is
    // never sent back to the browser to redisplay) -- without something
    // else to look at, an empty box right after saving reads as "did
    // that not work?". The badge + placeholder answer that at a glance,
    // without needing to notice the hint line below.
    const passwordInput = document.getElementById("settings-password");
    const passwordBadge = document.getElementById("password-badge");
    const passwordStatus = document.getElementById("password-status");
    if (data.hasPassword) {
      passwordBadge.textContent = "✓ Saved";
      passwordBadge.className = "badge badge-ok";
      passwordBadge.style.display = "";
      passwordInput.placeholder = "•••••••• (saved -- leave blank to keep it)";
      passwordStatus.textContent = "Type a new password to replace it, or leave this field blank to keep the saved one.";
    } else {
      passwordBadge.textContent = "Not set";
      passwordBadge.className = "badge badge-off";
      passwordBadge.style.display = "";
      passwordInput.placeholder = "Enter your portal password";
      passwordStatus.textContent = "No password saved yet -- DailyBot can't log in until you add one.";
    }

    document.getElementById("settings-slowmo").value = data.slowMo ?? 0;
    document.getElementById("settings-timeout-nav").value = data.timeoutNavigation ?? 30000;
    document.getElementById("settings-timeout-action").value = data.timeoutAction ?? 15000;
    document.getElementById("settings-timeout-otp").value = data.timeoutOtp ?? 90000;
    document.getElementById("settings-retry-attempts").value = data.retryAttempts ?? 3;
    document.getElementById("settings-retry-delay").value = data.retryDelayMs ?? 3000;
    document.getElementById("settings-max-edit-age").value = data.maxEditAgeDays ?? 2;
    document.getElementById("settings-log-level").value = data.logLevel || "info";
  }

  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("settings-status");
    statusEl.textContent = "Saving...";
    statusEl.className = "status-msg";

    const body = {
      email: document.getElementById("settings-email").value,
      password: document.getElementById("settings-password").value,
      geoLatitude: document.getElementById("settings-lat").value,
      geoLongitude: document.getElementById("settings-lng").value,
      headless: document.getElementById("settings-headless").value === "true",
      slowMo: document.getElementById("settings-slowmo").value,
      timeoutNavigation: document.getElementById("settings-timeout-nav").value,
      timeoutAction: document.getElementById("settings-timeout-action").value,
      timeoutOtp: document.getElementById("settings-timeout-otp").value,
      retryAttempts: document.getElementById("settings-retry-attempts").value,
      retryDelayMs: document.getElementById("settings-retry-delay").value,
      maxEditAgeDays: document.getElementById("settings-max-edit-age").value,
      logLevel: document.getElementById("settings-log-level").value,
    };

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Save failed");
      statusEl.textContent = result.restartRequired
        ? "Saved. Restart DailyBot GUI for the log-level change to apply."
        : "Saved.";
      statusEl.className = "status-msg ok";
      document.getElementById("settings-password").value = "";
      loadSettings();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status-msg err";
    }
  });

  // ---------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------
  async function loadEntries() {
    const res = await fetch("/api/entries");
    const entries = await res.json();
    const tbody = document.getElementById("entries-tbody");
    tbody.innerHTML = "";

    document.getElementById("entries-empty").style.display = entries.length ? "none" : "block";

    for (const e of entries) {
      const tr = document.createElement("tr");
      const location = e.latitude !== "" && e.longitude !== "" ? `${e.latitude}, ${e.longitude}` : "Default";
      tr.innerHTML = `
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.partner)}</td>
        <td>${escapeHtml(String(e.calls))}</td>
        <td>${escapeHtml(String(e.meetings))}</td>
        <td>${escapeHtml(e.notes)}</td>
        <td>${escapeHtml(location)}</td>
        <td><button class="row-delete-btn" data-row="${e.rowNumber}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(".row-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/entries/${btn.dataset.row}`, { method: "DELETE" });
        loadEntries();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Saved Locations
  // ---------------------------------------------------------------------
  let savedLocations = [];

  async function loadLocations() {
    const res = await fetch("/api/locations");
    savedLocations = await res.json();

    const tbody = document.getElementById("locations-tbody");
    tbody.innerHTML = "";
    document.getElementById("locations-empty").style.display = savedLocations.length ? "none" : "block";
    savedLocations.forEach((loc, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(loc.name)}</td>
        <td>${escapeHtml(String(loc.latitude))}</td>
        <td>${escapeHtml(String(loc.longitude))}</td>
        <td><button class="row-delete-btn" data-index="${index}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".row-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/locations/${btn.dataset.index}`, { method: "DELETE" });
        loadLocations();
      });
    });

    // Repopulate the entry form's location dropdown, keeping "Use the
    // default" and "Custom coordinates" fixed at the top.
    const select = document.getElementById("entry-location-preset");
    const currentValue = select.value;
    select.innerHTML = `
      <option value="default">Use the default location (from Settings)</option>
      <option value="custom">Custom coordinates for just this entry</option>
    `;
    savedLocations.forEach((loc, index) => {
      const opt = document.createElement("option");
      opt.value = `saved:${index}`;
      opt.textContent = loc.name;
      select.appendChild(opt);
    });
    // Keep whatever was selected if it still exists (e.g. after saving a
    // new location while a different one was already picked).
    if ([...select.options].some((o) => o.value === currentValue)) {
      select.value = currentValue;
    }
  }

  document.getElementById("entry-location-preset").addEventListener("change", (e) => {
    const value = e.target.value;
    const coordRow = document.getElementById("entry-coord-row");
    const latInput = document.getElementById("entry-latitude");
    const lngInput = document.getElementById("entry-longitude");

    if (value === "default") {
      coordRow.style.display = "none";
      latInput.value = "";
      lngInput.value = "";
    } else if (value === "custom") {
      coordRow.style.display = "";
    } else if (value.startsWith("saved:")) {
      const loc = savedLocations[Number(value.split(":")[1])];
      coordRow.style.display = "";
      if (loc) {
        latInput.value = loc.latitude;
        lngInput.value = loc.longitude;
      }
    }
  });

  document.getElementById("add-location-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("location-status");
    const body = {
      name: document.getElementById("location-name").value,
      latitude: document.getElementById("location-latitude").value,
      longitude: document.getElementById("location-longitude").value,
    };

    try {
      const res = await fetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Could not save location");
      statusEl.textContent = "Saved.";
      statusEl.className = "status-msg ok";
      ["location-name", "location-latitude", "location-longitude"].forEach(
        (id) => (document.getElementById(id).value = "")
      );
      loadLocations();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status-msg err";
    }
  });

  document.getElementById("add-entry-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("entry-status");
    const partner = document.getElementById("entry-partner").value.trim();
    if (!partner) {
      statusEl.textContent = "Partner is required.";
      statusEl.className = "status-msg err";
      return;
    }

    // "default" means send no coordinates at all -- blank Latitude/
    // Longitude columns are exactly what tells the automation engine to
    // fall back to the Settings default for this entry.
    const locationPreset = document.getElementById("entry-location-preset").value;
    const latitude = locationPreset === "default" ? "" : document.getElementById("entry-latitude").value;
    const longitude = locationPreset === "default" ? "" : document.getElementById("entry-longitude").value;

    const body = {
      date: document.getElementById("entry-date").value,
      partner,
      calls: document.getElementById("entry-calls").value,
      meetings: document.getElementById("entry-meetings").value,
      blockers: document.getElementById("entry-blockers").value,
      priority: document.getElementById("entry-priority").value,
      notes: document.getElementById("entry-notes").value,
      latitude,
      longitude,
    };

    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Could not add entry");
      statusEl.textContent = "Added.";
      statusEl.className = "status-msg ok";
      ["entry-partner", "entry-calls", "entry-meetings", "entry-blockers", "entry-priority", "entry-notes"].forEach(
        (id) => (document.getElementById(id).value = "")
      );
      document.getElementById("entry-location-preset").value = "default";
      document.getElementById("entry-coord-row").style.display = "none";
      document.getElementById("entry-latitude").value = "";
      document.getElementById("entry-longitude").value = "";
      loadEntries();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status-msg err";
    }
  });

  // ---------------------------------------------------------------------
  // Run + live log stream
  // ---------------------------------------------------------------------
  const logOutput = document.getElementById("log-output");
  const runBtn = document.getElementById("run-btn");
  const runIndicator = document.getElementById("run-indicator");
  const attentionBanner = document.getElementById("attention-banner");
  const attentionList = document.getElementById("attention-list");
  let eventSource = null;

  function appendLog(line) {
    if (logOutput.textContent === "Nothing running yet.") logOutput.textContent = "";
    logOutput.textContent += line + "\n";
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function renderAttention(payload) {
    if (!payload || !payload.issues || payload.issues.length === 0) {
      attentionBanner.style.display = "none";
      attentionList.innerHTML = "";
      return;
    }
    attentionList.innerHTML = payload.issues.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join("");
    attentionBanner.style.display = "block";
  }

  function connectStream() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource("/api/run/stream");

    eventSource.addEventListener("status", (e) => {
      const { running } = JSON.parse(e.data);
      setRunning(running);
    });
    eventSource.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
    eventSource.addEventListener("attention", (e) => renderAttention(e.data ? JSON.parse(e.data) : null));
    eventSource.addEventListener("done", (e) => {
      const payload = JSON.parse(e.data);
      setRunning(false);
      loadReports();
      loadSession();
    });
  }

  function setRunning(running) {
    runBtn.disabled = running;
    runIndicator.textContent = running ? "Running..." : "";
  }

  runBtn.addEventListener("click", async () => {
    const res = await fetch("/api/run", { method: "POST" });
    if (res.status === 409) {
      runIndicator.textContent = "Already running.";
      return;
    }
    setRunning(true);
  });

  async function loadSession() {
    const el = document.getElementById("session-status");
    try {
      const res = await fetch("/api/session");
      const data = await res.json();
      if (!data.exists) {
        el.textContent = "No saved session yet -- the next run will need the login code.";
        el.className = "hint";
      } else if (!data.expiresAt) {
        el.textContent = "Signed in (session has no fixed expiry to report).";
        el.className = "hint";
      } else if (data.expired) {
        el.textContent = `Session expired ${new Date(data.expiresAt).toLocaleString()} -- the next run will need the login code.`;
        el.className = "hint warning";
      } else {
        el.textContent = `Signed in -- session good until ${new Date(data.expiresAt).toLocaleString()}.`;
        el.className = "hint";
      }
    } catch (err) {
      el.textContent = "";
    }
  }

  async function loadReports() {
    const res = await fetch("/api/reports");
    const reports = await res.json();
    const list = document.getElementById("reports-list");
    list.innerHTML = "";
    document.getElementById("reports-empty").style.display = reports.length ? "none" : "block";

    for (const r of reports) {
      const li = document.createElement("li");
      const time = new Date(r.mtime).toLocaleString();
      li.innerHTML = `<a href="${r.url}" target="_blank">${escapeHtml(r.name)}</a><span class="report-time">${time}</span>`;
      list.appendChild(li);
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------
  function renderSchedulerStatus(data) {
    const el = document.getElementById("scheduler-next-run");
    if (!data.active) {
      el.textContent = "Scheduler is off.";
      el.className = "status-msg";
    } else if (data.nextRun) {
      el.textContent = `Scheduler is on -- next run: ${new Date(data.nextRun).toLocaleString()}`;
      el.className = "status-msg ok";
    } else {
      el.textContent = "Scheduler is on.";
      el.className = "status-msg ok";
    }
  }

  async function loadScheduler() {
    const res = await fetch("/api/scheduler");
    const data = await res.json();

    document.getElementById("scheduler-enabled").value = data.active ? "true" : "false";
    document.getElementById("scheduler-timezone").value = data.timezone || "";

    if (data.friendly) {
      // A simple "daily at HH:MM on these weekdays" pattern -- the picker
      // can represent it exactly, so show it there and leave the raw
      // cron field blank (blank means "use the picker" when saving).
      document.getElementById("scheduler-time").value = data.friendly.time;
      document.querySelectorAll("#scheduler-weekdays input").forEach((cb) => {
        cb.checked = data.friendly.weekdays.includes(Number(cb.value));
      });
      document.getElementById("scheduler-cron").value = "";
    } else if (data.cronExpression) {
      // Something more custom than the picker can represent -- show it
      // in the raw field instead so it's still visible and editable.
      document.getElementById("scheduler-cron").value = data.cronExpression;
    }

    renderSchedulerStatus(data);
  }

  document.getElementById("save-scheduler-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("scheduler-status");
    statusEl.textContent = "Saving...";
    statusEl.className = "status-msg";

    const weekdays = [...document.querySelectorAll("#scheduler-weekdays input:checked")].map((cb) => Number(cb.value));

    const body = {
      enabled: document.getElementById("scheduler-enabled").value === "true",
      time: document.getElementById("scheduler-time").value,
      weekdays,
      cronExpression: document.getElementById("scheduler-cron").value,
      timezone: document.getElementById("scheduler-timezone").value,
    };

    try {
      const res = await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Save failed");
      statusEl.textContent = "Saved.";
      statusEl.className = "status-msg ok";
      renderSchedulerStatus(result);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status-msg err";
    }
  });

  // ---------------------------------------------------------------------
  // Software Update
  // ---------------------------------------------------------------------
  const updateBtn = document.getElementById("update-btn");
  const updateLog = document.getElementById("update-log");
  const updateStatus = document.getElementById("update-status");
  const updateDot = document.getElementById("update-dot");
  let updateEventSource = null;

  async function loadVersion() {
    const versionEl = document.getElementById("update-version");
    try {
      const res = await fetch("/api/version");
      const data = await res.json();
      if (!data.isGit) {
        versionEl.textContent = "Plain copy (not tracked by git)";
        return;
      }
      if (!data.commit) {
        versionEl.textContent = "Version unknown";
        return;
      }
      const date = data.date ? new Date(data.date).toLocaleDateString() : "";
      versionEl.textContent = `Version ${data.commit}${date ? " · " + date : ""}`;
    } catch (err) {
      versionEl.textContent = "Could not check version";
    }
  }

  function appendUpdateLog(line) {
    updateLog.style.display = "block";
    updateLog.textContent += line + "\n";
    updateLog.scrollTop = updateLog.scrollHeight;
  }

  function setUpdating(updating) {
    updateBtn.disabled = updating;
    updateBtn.textContent = updating ? "Updating…" : "Check for Update";
    updateDot.className = "update-dot" + (updating ? " update-dot-active" : "");
  }

  function connectUpdateStream() {
    if (updateEventSource) updateEventSource.close();
    updateEventSource = new EventSource("/api/update/stream");

    updateEventSource.addEventListener("status", (e) => {
      const { updating } = JSON.parse(e.data);
      setUpdating(updating);
    });
    updateEventSource.addEventListener("log", (e) => appendUpdateLog(JSON.parse(e.data)));
    updateEventSource.addEventListener("done", (e) => {
      const payload = JSON.parse(e.data);
      setUpdating(false);
      updateEventSource.close();
      updateEventSource = null;

      if (payload.ok && payload.mode === "inplace") {
        updateStatus.textContent = "Updated. Close and reopen “Run DailyBot GUI” for the changes to take effect.";
        updateStatus.className = "status-msg ok";
        loadVersion();
      } else if (payload.ok && payload.mode === "newfolder") {
        updateStatus.textContent = `Updated copy ready at ${payload.path}. Use that folder from now on -- start "Run DailyBot GUI.bat" there instead of here.`;
        updateStatus.className = "status-msg ok";
      } else if (payload.ok && payload.mode === "newfolder-no-node") {
        updateStatus.textContent = `Files ready at ${payload.path}, but Node.js isn't installed on this computer. Double-click Setup.bat in that folder to finish.`;
        updateStatus.className = "status-msg ok";
      } else {
        updateStatus.textContent = payload.error || "Update failed -- see the log above.";
        updateStatus.className = "status-msg err";
      }
    });
  }

  updateBtn.addEventListener("click", async () => {
    updateStatus.textContent = "";
    updateStatus.className = "status-msg";
    updateLog.textContent = "";
    updateLog.style.display = "block";

    const res = await fetch("/api/update", { method: "POST" });
    if (res.status === 409) {
      const result = await res.json();
      updateStatus.textContent = result.error;
      updateStatus.className = "status-msg err";
      return;
    }
    setUpdating(true);
    connectUpdateStream();
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  document.getElementById("entry-date").valueAsDate = new Date();
  loadSettings();
  loadLocations();
  loadScheduler();
  loadVersion();
  loadSession();
  connectStream();
})();
