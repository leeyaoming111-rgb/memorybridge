/**
 * MemoryBridge — Popup Controller (popup.js)
 * v0.8.1 — Clean rollback with null-safe DOM access.
 */

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  loadStats();
  loadMemoryProfile();
  loadSettings();
  loadBuffer();
  loadContextPrompt();
  loadUpdateInfo();
  bindActions();
});

// ─── Safe DOM Helpers ─────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, v) { const el = $(id); if (el) el.textContent = v; }
function on(id, evt, fn) { const el = $(id); if (el) el.addEventListener(evt, fn); }

// ─── Messaging ────────────────────────────────────────────────
function sendBg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function sendTab(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return reject(new Error("No active tab"));
      chrome.tabs.sendMessage(tabs[0].id, { type, payload }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  });
}

// ─── Tabs ──────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      const panel = $(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add("active");

      const tabName = tab.dataset.tab;
      if (tabName === "memory") { loadStats(); loadMemoryProfile(); }
      if (tabName === "capture") { loadBuffer(); }
      if (tabName === "inject") { loadContextPrompt(); }
    });
  });
}

// ─── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await sendBg("GET_STATS");
    setText("statMessages", stats.totalMessages || 0);
    setText("statDistills", stats.totalDistillations || 0);

    const profile = await sendBg("GET_MEMORY_PROFILE");
    const ip = profile.interaction_preferences || {};
    const prefCount = (ip.learning_style?.length || 0) + (ip.response_format?.length || 0) +
      (ip.tone?.length || 0) + (ip.pet_peeves?.length || 0) + (ip.likes?.length || 0);
    const factCount = prefCount +
      (profile.expertise?.length || 0) +
      (profile.tools_and_stack?.length || 0) +
      (profile.facts?.length || 0);
    setText("statFacts", factCount);

    const dot = $("statusDot");
    if (dot) {
      try {
        const status = await sendTab("GET_CAPTURE_STATUS");
        dot.classList.toggle("inactive", !status.enabled);
        dot.title = status.enabled ? `Capturing on ${status.provider}` : "Capture paused";
      } catch {
        dot.classList.add("inactive");
        dot.title = "Not on a chatbot page";
      }
    }
  } catch (err) {
    console.error("Failed to load stats:", err);
  }
}

// ─── Memory Profile ────────────────────────────────────────────
async function loadMemoryProfile() {
  try {
    const profile = await sendBg("GET_MEMORY_PROFILE");
    renderProfile(profile);
  } catch (err) {
    console.error("Failed to load profile:", err);
  }
}

function renderProfile(profile) {
  const container = $("profileContent");
  if (!container) return;

  const hasData = profile.lastUpdated ||
    (profile.interaction_preferences && Object.values(profile.interaction_preferences).some(v => v && (Array.isArray(v) ? v.length > 0 : true))) ||
    (profile.facts || []).length > 0 ||
    (profile.expertise || []).length > 0 ||
    Object.keys(profile.identity || {}).length > 0;

  if (!hasData) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><img src="icons/icon48.png" style="width: 32px; height: 32px; opacity: 0.4;" /></div>
        <div class="empty-state-title">No memory yet</div>
        <div class="empty-state-text">Start chatting with any AI assistant.<br>MemoryBridge will capture and learn.</div>
      </div>`;
    return;
  }

  let html = "";

  const ip = profile.interaction_preferences || {};
  const prefSections = [
    { key: "learning_style", label: "How I Learn" },
    { key: "response_format", label: "Response Format" },
    { key: "tone", label: "Preferred Tone" },
    { key: "likes", label: "Things I Like" },
    { key: "pet_peeves", label: "Pet Peeves" }
  ];

  const hasPrefs = prefSections.some(s => ip[s.key]?.length) || ip.depth || ip.verbosity;
  if (hasPrefs) {
    html += `<div class="profile-card"><h3>Interaction Preferences</h3>`;
    if (ip.verbosity || ip.depth) {
      html += `<div style="display: flex; gap: 8px; margin-bottom: 8px;">`;
      if (ip.verbosity) html += `<span class="tag accent">${escapeHtml(ip.verbosity)} verbosity</span>`;
      if (ip.depth) html += `<span class="tag accent">${escapeHtml(ip.depth)} depth</span>`;
      html += `</div>`;
    }
    for (const section of prefSections) {
      const items = ip[section.key];
      if (items?.length) {
        html += `<div style="margin-bottom: 8px;">`;
        html += `<div style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); margin-bottom: 4px;">${section.label}</div>`;
        items.forEach(item => {
          html += `<div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0; padding-left: 8px; border-left: 2px solid ${section.key === 'pet_peeves' ? 'var(--danger)' : 'var(--accent)'};">${escapeHtml(item)}</div>`;
        });
        html += `</div>`;
      }
    }
    html += `</div>`;
  }

  const cp = profile.communication_patterns || {};
  if (cp.tone || cp.vocabulary_level || cp.asks_questions_like?.length) {
    html += `<div class="profile-card"><h3>Communication Style</h3>`;
    if (cp.tone) html += `<p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">${escapeHtml(cp.tone)}</p>`;
    if (cp.vocabulary_level) html += profileField("Vocabulary", cp.vocabulary_level);
    if (cp.asks_questions_like?.length) {
      html += `<div class="tag-list" style="margin-top: 6px;">`;
      cp.asks_questions_like.forEach(p => { html += `<span class="tag">${escapeHtml(p)}</span>`; });
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (profile.expertise?.length) {
    html += `<div class="profile-card"><h3>Expertise</h3><div class="tag-list">`;
    profile.expertise.forEach(e => {
      const isHigh = e.level === "expert" || e.level === "advanced";
      html += `<span class="tag ${isHigh ? 'accent' : ''}">${escapeHtml(e.domain)} · ${e.level}</span>`;
    });
    html += `</div></div>`;
  }

  if (profile.tools_and_stack?.length) {
    html += `<div class="profile-card"><h3>Tools & Stack</h3><div class="tag-list">`;
    profile.tools_and_stack.forEach(t => { html += `<span class="tag">${escapeHtml(t)}</span>`; });
    html += `</div></div>`;
  }

  if (profile.active_projects?.length) {
    html += `<div class="profile-card"><h3>Active Projects</h3>`;
    profile.active_projects.forEach(p => {
      html += `<div style="padding: 4px 0; border-bottom: 1px solid var(--border);">`;
      html += `<div style="font-size: 12px; font-weight: 500; color: var(--text-primary);">${escapeHtml(p.name)}</div>`;
      if (p.description) html += `<div style="font-size: 11px; color: var(--text-secondary);">${escapeHtml(p.description)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  const id = profile.identity || {};
  if (id.name || id.role || id.organization) {
    html += `<div class="profile-card"><h3>Identity</h3>`;
    if (id.name) html += profileField("Name", id.name);
    if (id.role) html += profileField("Role", id.role);
    if (id.organization) html += profileField("Organization", id.organization);
    html += `</div>`;
  }

  if (profile.facts?.length) {
    html += `<div class="profile-card"><h3>Facts</h3>`;
    profile.facts.forEach(f => {
      html += `<div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0; padding-left: 8px; border-left: 2px solid var(--border);">${escapeHtml(typeof f === "string" ? f : f.content || JSON.stringify(f))}</div>`;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
}

function profileField(label, value) {
  return `<div style="font-size: 12px; margin-bottom: 4px;">
    <span style="color: var(--text-muted);">${escapeHtml(label)}:</span>
    <span style="color: var(--text-secondary); margin-left: 4px;">${escapeHtml(value)}</span></div>`;
}

// ─── Buffer ────────────────────────────────────────────────────
async function loadBuffer() {
  try {
    const { buffer } = await sendBg("GET_RAW_BUFFER");
    setText("bufferCount", buffer.length);

    const listEl = $("bufferList");
    if (!listEl) return;

    if (buffer.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><img src="icons/icon48.png" style="width: 32px; height: 32px; opacity: 0.4;" /></div>
          <div class="empty-state-title">Buffer empty</div>
          <div class="empty-state-text">No messages captured yet.<br>Visit ChatGPT, Claude, or Gemini to start.</div>
        </div>`;
      return;
    }

    const recent = buffer.slice(-50).reverse();
    listEl.innerHTML = recent.map(entry => {
      const preview = entry.message?.text?.substring(0, 120) || entry.text?.substring(0, 120) || "(empty)";
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "";
      return `
        <div class="buffer-item">
          <div class="buffer-item-header" style="display: flex; gap: 8px; align-items: center; margin-bottom: 2px;">
            <span class="buffer-provider ${entry.provider}">${entry.providerName || entry.provider}</span>
            <span style="color: var(--text-muted); font-size: 10px;">${time}</span>
          </div>
          <div style="font-size: 10px; color: var(--text-muted);">${entry.message?.role || entry.role || "?"}</div>
          <div style="color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(preview)}${preview.length >= 120 ? "..." : ""}</div>
        </div>`;
    }).join("");
  } catch (err) {
    console.error("Failed to load buffer:", err);
  }
}

// ─── Context Prompt ────────────────────────────────────────────
async function loadContextPrompt() {
  try {
    const { prompt } = await sendBg("GET_CONTEXT_PROMPT");
    setText("contextPreview", prompt);
    const tokenEstimate = Math.ceil((prompt || "").length / 4);
    const tokenEl = $("tokenCount");
    if (tokenEl) tokenEl.textContent = `~${tokenEstimate} tokens`;
  } catch {
    setText("contextPreview", "Failed to generate context prompt.");
  }
}

// ─── Settings ──────────────────────────────────────────────────
async function loadSettings() {
  try {
    const settings = await sendBg("GET_SETTINGS");
    const provider = settings.apiProvider || "session_claude";
    const s = (id, val) => { const el = $(id); if (el) el.value = val; };
    const c = (id, val) => { const el = $(id); if (el) el.checked = val; };
    s("settingProvider", provider);
    s("settingApiKey", settings.apiKey || "");
    s("settingModel", settings.model || "claude-sonnet-4-20250514");
    c("settingCapture", settings.captureEnabled !== false);
    c("settingAutoDistill", settings.autoDistill !== false);
    s("settingThreshold", settings.distillThreshold || 20);
    updateProviderUI(provider);
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

function updateProviderUI(provider) {
  const isSession = provider.startsWith("session_");
  const show = (id, v) => { const el = $(id); if (el) el.style.display = v ? "block" : "none"; };
  show("sessionInfo", isSession);
  show("apiKeyGroup", !isSession);
  show("modelGroup", !isSession);
}

// ─── Actions ──────────────────────────────────────────────────
function bindActions() {
  on("btnDistill", "click", async () => {
    const btn = $("btnDistill");
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Distilling...';
    try {
      const settings = await sendBg("GET_SETTINGS");
      if (settings.apiProvider?.startsWith("session_")) {
        const granted = await ensureSessionPermissions(settings.apiProvider);
        if (!granted) {
          showToast("Permission required — please approve when prompted");
          btn.disabled = false; btn.innerHTML = "Distill Now"; return;
        }
      }
      const result = await sendBg("TRIGGER_DISTILL");
      if (result.success) {
        showToast("Memory distilled successfully");
        loadMemoryProfile(); loadStats(); loadContextPrompt();
      } else {
        showToast(result.error || "Distillation failed");
      }
    } catch (err) { showToast("Error: " + err.message); }
    btn.disabled = false;
    btn.innerHTML = "Distill Now";
  });

  on("btnExport", "click", async () => {
    try {
      const data = await sendBg("EXPORT_PROFILE");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `memorybridge-profile-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      showToast("Profile exported");
    } catch { showToast("Export failed"); }
  });

  on("btnImport", "click", () => { const fi = $("fileImport"); if (fi) fi.click(); });

  on("fileImport", "change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await sendBg("IMPORT_PROFILE", data);
      if (result.success) { showToast("Profile imported"); loadMemoryProfile(); loadStats(); loadContextPrompt(); }
      else showToast(result.error || "Import failed");
    } catch { showToast("Invalid file format"); }
    e.target.value = "";
  });

  on("btnCopyContext", "click", async () => {
    const el = $("contextPreview");
    const text = el ? el.textContent : "";
    try { await navigator.clipboard.writeText(text); showToast("Copied to clipboard"); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); showToast("Copied to clipboard"); }
  });

  on("btnInjectContext", "click", async () => {
    try {
      const { prompt } = await sendBg("GET_CONTEXT_PROMPT");
      await sendTab("INJECT_MEMORY", { memoryText: prompt });
      showToast("Injected into page");
    } catch (err) {
      showToast("Not on a chatbot page");
    }
  });

  on("btnSaveSettings", "click", async () => {
    const v = (id) => $(id)?.value;
    const ch = (id) => $(id)?.checked;
    try {
      await sendBg("SAVE_SETTINGS", {
        apiProvider: v("settingProvider"), apiKey: v("settingApiKey"), model: v("settingModel"),
        captureEnabled: ch("settingCapture"), autoDistill: ch("settingAutoDistill"),
        distillThreshold: parseInt(v("settingThreshold")) || 20
      });
      showToast("Settings saved");
    } catch { showToast("Failed to save"); }
  });

  on("settingProvider", "change", async (e) => {
    updateProviderUI(e.target.value);
    if (e.target.value.startsWith("session_")) {
      const granted = await ensureSessionPermissions(e.target.value);
      if (!granted) showToast("Permission needed for session mode");
    }
  });

  on("btnClearBuffer", "click", async () => {
    if (confirm("Clear all buffered messages?")) { await sendBg("CLEAR_RAW_BUFFER"); loadBuffer(); showToast("Buffer cleared"); }
  });

  on("btnClearAll", "click", async () => {
    if (confirm("Delete entire memory profile and all data?")) {
      await sendBg("CLEAR_ALL_DATA"); loadMemoryProfile(); loadStats(); loadBuffer(); loadContextPrompt(); showToast("All data cleared");
    }
  });

  on("btnDismissUpdate", "click", async (e) => {
    e.stopPropagation(); await sendBg("DISMISS_UPDATE");
    const b = $("updateBanner"); if (b) b.classList.remove("visible");
  });

  on("btnCheckUpdate", "click", async () => {
    setText("updateStatus", "Checking...");
    try {
      const result = await sendBg("CHECK_FOR_UPDATE");
      const el = $("updateStatus"); if (!el) return;
      if (!result || result.error) { el.textContent = result?.error || "Check failed"; }
      else if (result.updateAvailable) { el.textContent = `Update available: v${result.latestVersion}`; el.style.color = "var(--warning)"; loadUpdateInfo(); }
      else { el.textContent = `You're on the latest (v${result.currentVersion})`; el.style.color = "var(--success)"; }
    } catch (err) { setText("updateStatus", "Error: " + err.message); }
    loadReleaseHistory();
  });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => { if (tab.dataset.tab === "settings") loadReleaseHistory(); });
  });
}

// ─── Toast ────────────────────────────────────────────────────
function showToast(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// ─── Update Info ──────────────────────────────────────────────
async function loadUpdateInfo() {
  try {
    const info = await sendBg("GET_UPDATE_INFO");
    const vLabel = $("versionLabel");
    if (vLabel && info.currentVersion) vLabel.textContent = `v${info.currentVersion}`;
    const banner = $("updateBanner");
    if (info.updateAvailable && !info.dismissed && banner) {
      setText("updateVersion", `v${info.latestVersion}`);
      setText("updateChangelog", info.changelog || "");
      const dl = $("updateDownloadLink"); if (dl && info.downloadUrl) dl.href = info.downloadUrl;
      banner.classList.add("visible");
    }
  } catch (_) {}
}

async function loadReleaseHistory() {
  const container = $("releaseHistory");
  if (!container) return;
  container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted);">Loading releases...</div>';
  try {
    const result = await sendBg("GET_RELEASE_HISTORY");
    if (result.error) { container.innerHTML = `<div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(result.error)}</div>`; return; }
    if (!result.releases?.length) { container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted);">No releases found.</div>'; return; }
    let html = "";
    for (const r of result.releases) {
      const date = r.date ? new Date(r.date).toLocaleDateString() : "";
      const cur = r.isCurrent;
      html += `<div style="padding:8px 10px;margin-bottom:4px;background:${cur?'var(--accent-glow)':'var(--bg-card)'};border:1px solid ${cur?'var(--border-accent)':'var(--border)'};border-radius:var(--radius-sm);">`;
      html += `<div style="display:flex;align-items:center;justify-content:space-between;"><div>`;
      html += `<span style="font-weight:600;font-size:12px;color:var(--text-primary);">${escapeHtml(r.name)}</span>`;
      if (cur) html += ` <span style="font-size:10px;color:var(--accent);font-weight:600;">\u2190 installed</span>`;
      html += `<div style="font-size:10px;color:var(--text-muted);">${date}</div></div>`;
      if (r.downloadUrl) html += `<a href="${escapeHtml(r.downloadUrl)}" target="_blank" style="text-decoration:none;"><button class="btn btn-sm" style="font-size:10px;padding:3px 8px;">\u2b07 Download</button></a>`;
      html += `</div>`;
      if (r.changelog) html += `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;line-height:1.4;">${escapeHtml(r.changelog)}</div>`;
      html += `</div>`;
    }
    container.innerHTML = html;
  } catch (err) { container.innerHTML = `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(err.message)}</div>`; }
}

// ─── Utility ──────────────────────────────────────────────────
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

async function ensureSessionPermissions(provider) {
  const origins = { session_claude: ["https://claude.ai/*"], session_chatgpt: ["https://chatgpt.com/*", "https://chat.openai.com/*"] };
  const needed = origins[provider] || [];
  if (!needed.length) return true;
  const already = await chrome.permissions.contains({ permissions: ["cookies"], origins: needed });
  if (already) return true;
  return await chrome.permissions.request({ permissions: ["cookies"], origins: needed });
}
