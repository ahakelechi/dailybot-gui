// public/app.js
//
// Plain vanilla JS -- no framework, no build step. Talks to the local
// server's JSON API and renders the three tabs.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "entries") loadEntries();
      if (btn.dataset.tab === "run") loadReports();
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
    document.getElementById("settings-headless").checked = Boolean(data.headless);
    document.getElementById("password-status").textContent = data.hasPassword
      ? "A password is already saved. Leave the field blank to keep it."
      : "No password saved yet.";

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
      headless: document.getElementById("settings-headless").checked,
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
      tr.innerHTML = `
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.partner)}</td>
        <td>${escapeHtml(String(e.calls))}</td>
        <td>${escapeHtml(String(e.meetings))}</td>
        <td>${escapeHtml(e.notes)}</td>
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

  document.getElementById("add-entry-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("entry-status");
    const partner = document.getElementById("entry-partner").value.trim();
    if (!partner) {
      statusEl.textContent = "Partner is required.";
      statusEl.className = "status-msg err";
      return;
    }

    const body = {
      date: document.getElementById("entry-date").value,
      partner,
      calls: document.getElementById("entry-calls").value,
      meetings: document.getElementById("entry-meetings").value,
      blockers: document.getElementById("entry-blockers").value,
      priority: document.getElementById("entry-priority").value,
      notes: document.getElementById("entry-notes").value,
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
  let eventSource = null;

  function appendLog(line) {
    if (logOutput.textContent === "Nothing running yet.") logOutput.textContent = "";
    logOutput.textContent += line + "\n";
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function connectStream() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource("/api/run/stream");

    eventSource.addEventListener("status", (e) => {
      const { running } = JSON.parse(e.data);
      setRunning(running);
    });
    eventSource.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
    eventSource.addEventListener("done", (e) => {
      const payload = JSON.parse(e.data);
      setRunning(false);
      loadReports();
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
  // Init
  // ---------------------------------------------------------------------
  document.getElementById("entry-date").valueAsDate = new Date();
  loadSettings();
  connectStream();
})();
