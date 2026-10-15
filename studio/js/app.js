const state = {
  currentView: "dashboard", // "dashboard" | "studio"
  projects: [],
  currentProject: null,
  voices: [],
  activeBlockIndex: 0,
  selectedBlockIndices: new Set([0]),
  lastClickedIndex: 0,
  targetBlockForVoice: null,
  activeFilter: "all",
  activeSort: "recommended",
  searchQuery: "",
  sampleAudioPlayer: new Audio(),
  storyAudioPlayer: new Audio(),
  playingVoiceSampleId: null,
  currentlyPlayingBlockIdx: null,
  isPlayingStory: false,
  isBatchRunning: false,
  nextSentenceTimer: null,
  config: { remote_worker_url: "", active: false },
  undoStack: [],
  redoStack: [],
  savedCharacters: [],
  selectedCharacterColor: "#6366f1",
  editingCharacterId: null,
  charModalFxFilter: "none",
  draggedBlockIndex: null
};

// ---------------- UTILITIES & HELPERS ---------------- //

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "Recently";
  const sec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (sec < 10) return "Just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function countHeadings() {
  if (!state.currentProject?.blocks) return 0;
  return state.currentProject.blocks.filter(b => b.type === "heading" || b.is_spoken === false).length;
}

// ---------------- UNDO / REDO & ACTION HISTORY ENGINE ---------------- //

function recordHistory(actionLabel) {
  if (!state.currentProject || !state.currentProject.blocks) return;

  const blocksClone = JSON.parse(JSON.stringify(state.currentProject.blocks));
  const activeIdx = state.activeBlockIndex;
  const selectedIndices = Array.from(state.selectedBlockIndices || [0]);

  state.undoStack.push({
    label: actionLabel,
    blocks: blocksClone,
    activeBlockIndex: activeIdx,
    selectedBlockIndices: selectedIndices,
    timestamp: Date.now()
  });

  if (state.undoStack.length > 50) {
    state.undoStack.shift();
  }

  // Any new action clears the redo stack
  state.redoStack = [];
  updateUndoRedoUI();
}

function handleUndo() {
  if (!state.currentProject || !state.undoStack || state.undoStack.length === 0) {
    showToast("ℹ️ Nothing to undo.");
    return;
  }

  // Take current state and push onto redo stack
  const currentSnapshot = {
    label: state.undoStack[state.undoStack.length - 1].label || "Action",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.redoStack.push(currentSnapshot);

  // Pop previous snapshot from undo stack
  const previousSnapshot = state.undoStack.pop();
  state.currentProject.blocks = previousSnapshot.blocks;
  state.activeBlockIndex = Math.min(previousSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((previousSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  updateUndoRedoUI();
  showToast(`↺ Undid: ${previousSnapshot.label}`);
}

function handleRedo() {
  if (!state.currentProject || !state.redoStack || state.redoStack.length === 0) {
    showToast("ℹ️ Nothing to redo.");
    return;
  }

  // Take current state and push onto undo stack
  const currentSnapshot = {
    label: state.redoStack[state.redoStack.length - 1].label || "Action",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.undoStack.push(currentSnapshot);

  // Pop next snapshot from redo stack
  const nextSnapshot = state.redoStack.pop();
  state.currentProject.blocks = nextSnapshot.blocks;
  state.activeBlockIndex = Math.min(nextSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((nextSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  updateUndoRedoUI();
  showToast(`↻ Redid: ${nextSnapshot.label}`);
}

function revertToHistoryStep(targetIndex) {
  if (!state.currentProject || !state.undoStack || targetIndex < 0 || targetIndex >= state.undoStack.length) return;

  // Take snapshot of current state for redo
  const currentSnapshot = {
    label: "Current State",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.redoStack.push(currentSnapshot);

  // Pop all items after targetIndex into redo stack
  while (state.undoStack.length > targetIndex + 1) {
    state.redoStack.push(state.undoStack.pop());
  }

  const targetSnapshot = state.undoStack.pop();
  state.currentProject.blocks = targetSnapshot.blocks;
  state.activeBlockIndex = Math.min(targetSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((targetSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  updateUndoRedoUI();
  closeHistoryDropdown();
  showToast(`↺ Restored state: "${targetSnapshot.label}"`);
}

function updateUndoRedoUI() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  const badgeCount = document.getElementById("history-badge-count");
  const totalLabel = document.getElementById("history-dropdown-total");

  const canUndo = Boolean(state.undoStack && state.undoStack.length > 0);
  const canRedo = Boolean(state.redoStack && state.redoStack.length > 0);

  if (undoBtn) {
    undoBtn.disabled = !canUndo;
    if (canUndo) {
      undoBtn.title = `Undo "${state.undoStack[state.undoStack.length - 1].label}" (Ctrl+Z)`;
    } else {
      undoBtn.title = "Nothing to undo (Ctrl+Z)";
    }
  }

  if (redoBtn) {
    redoBtn.disabled = !canRedo;
    if (canRedo) {
      redoBtn.title = `Redo "${state.redoStack[state.redoStack.length - 1].label}" (Ctrl+Y)`;
    } else {
      redoBtn.title = "Nothing to redo (Ctrl+Y)";
    }
  }

  const totalSteps = (state.undoStack?.length || 0);
  if (badgeCount) badgeCount.textContent = totalSteps;
  if (totalLabel) totalLabel.textContent = `${totalSteps} step${totalSteps === 1 ? '' : 's'}`;

  renderHistoryDropdownList();
}

function toggleHistoryDropdown(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("history-dropdown-menu");
  if (!menu) return;
  const isHidden = (menu.style.display === "none" || !menu.style.display);
  menu.style.display = isHidden ? "flex" : "none";
  if (isHidden) {
    renderHistoryDropdownList();
  }
}

function closeHistoryDropdown() {
  const menu = document.getElementById("history-dropdown-menu");
  if (menu) menu.style.display = "none";
}

function renderHistoryDropdownList() {
  const listEl = document.getElementById("history-dropdown-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const undoLen = state.undoStack ? state.undoStack.length : 0;
  const redoLen = state.redoStack ? state.redoStack.length : 0;

  if (undoLen === 0 && redoLen === 0) {
    listEl.innerHTML = `<div class="history-empty-item">No actions in history yet.<br><span style="font-size: 11px; opacity: 0.7;">Edits and changes will appear here.</span></div>`;
    return;
  }

  // 1. Redo steps (future)
  if (redoLen > 0) {
    state.redoStack.slice().reverse().forEach((item) => {
      const div = document.createElement("div");
      div.className = "history-dropdown-item redo-item";
      div.title = "Click to redo forward to this state";
      div.innerHTML = `
        <div class="history-item-label">
          <span>↻</span>
          <span>${escapeHtml(item.label || "Action")}</span>
        </div>
        <span class="history-item-time">Redo</span>
      `;
      div.addEventListener("click", () => {
        handleRedo();
      });
      listEl.appendChild(div);
    });
  }

  // 2. Current State Marker
  const currentMarker = document.createElement("div");
  currentMarker.className = "history-dropdown-item active";
  currentMarker.innerHTML = `
    <div class="history-item-label">
      <span>●</span>
      <span>Current Story State</span>
    </div>
    <span class="history-item-time">Now</span>
  `;
  listEl.appendChild(currentMarker);

  // 3. Undo steps (past, newest on top)
  for (let i = undoLen - 1; i >= 0; i--) {
    const item = state.undoStack[i];
    const div = document.createElement("div");
    div.className = "history-dropdown-item";
    div.title = `Click to roll back story to: ${item.label}`;
    const timeAgo = formatTimeAgo(item.timestamp);

    div.innerHTML = `
      <div class="history-item-label">
        <span>↺</span>
        <span>${escapeHtml(item.label || "Action")}</span>
      </div>
      <span class="history-item-time">${timeAgo}</span>
    `;
    div.addEventListener("click", () => {
      revertToHistoryStep(i);
    });
    listEl.appendChild(div);
  }
}

// ---------------- INITIALIZATION ---------------- //

async function initApp() {
  try {
    loadSavedCharacters();
    await loadVoices();
    await loadProjectsList();
    await loadConfig();
    setupEventListeners();

    // Check URL parameters for direct studio deep-linking
    const urlParams = new URLSearchParams(window.location.search);
    const projectId = urlParams.get("project") || urlParams.get("id");
    const isStudioPath = window.location.pathname.startsWith("/studio");

    if (projectId) {
      await openProject(projectId, false);
    } else if (isStudioPath && state.projects && state.projects.length > 0) {
      await openProject(state.projects[0].id, false);
    } else {
      switchToView("dashboard", false);
    }

    // Handle browser back/forward buttons
    window.addEventListener("popstate", (e) => {
      const params = new URLSearchParams(window.location.search);
      const pid = params.get("project") || params.get("id");
      const isStudio = window.location.pathname.startsWith("/studio");
      if (pid && (!state.currentProject || state.currentProject.id !== pid)) {
        openProject(pid, false);
      } else if (!pid && !isStudio) {
        switchToView("dashboard", false);
      }
    });
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

// ---------------- API CALLS ---------------- //

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    state.voices = await res.json();
    populateVoiceSelects();
  } catch (err) {
    console.error("Failed to load voices", err);
  }
}

function populateVoiceSelects() {
  const newProjSelect = document.getElementById("new-project-voice-select");
  const importSelect = document.getElementById("import-voice-select");
  if (!state.voices || state.voices.length === 0) return;

  const html = state.voices.map(v => {
    const isDefault = v.id === "blend_fenrir_onyx";
    return `<option value="${v.id}" ${isDefault ? 'selected' : ''}>${v.flag || '🎙️'} ${v.name} (${v.accent} • ${v.gender})</option>`;
  }).join("");

  if (newProjSelect) newProjSelect.innerHTML = html;
  if (importSelect) importSelect.innerHTML = html;
}

async function loadProjectsList() {
  try {
    const res = await fetch("/api/projects");
    state.projects = await res.json();
    renderDashboard();
  } catch (err) {
    console.error("Failed to load projects", err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    state.config = await res.json();
    updateEngineUI(state.config.remote_worker_url, state.config.active);
  } catch (err) {
    console.error("Failed to load config", err);
  }
}

function updateEngineUI(remoteUrl, active) {
  const isOnline = Boolean(active && remoteUrl);
  const badgeText = isOnline ? "🚀 Colab GPU (Active)" : "⚡ Local CPU Engine";

  // Update top bar buttons on both views
  const btns = [
    document.getElementById("btn-engine-status"),
    document.getElementById("btn-dashboard-engine-status")
  ];
  btns.forEach(btn => {
    if (!btn) return;
    const label = btn.querySelector(".engine-label");
    if (label) label.textContent = badgeText;
    if (isOnline) {
      btn.classList.add("gpu-active");
      btn.title = `Cloud GPU Active: ${remoteUrl}`;
    } else {
      btn.classList.remove("gpu-active");
      btn.title = "Configure Cloud GPU (Google Colab / Kaggle)";
    }
  });

  // Update dashboard stats strip engine card
  const statEngineName = document.getElementById("stat-engine-name");
  const statEngineSpeed = document.getElementById("stat-engine-speed");
  const statEngineIcon = document.getElementById("stat-engine-icon");
  if (statEngineName) statEngineName.textContent = isOnline ? "Colab GPU (Active)" : "Local CPU";
  if (statEngineSpeed) statEngineSpeed.textContent = isOnline ? "~0.8s per sentence (Fast)" : "~14s per sentence";
  if (statEngineIcon) statEngineIcon.textContent = isOnline ? "🚀" : "⚡";

  // Auto-configure parallel concurrency selector according to GPU vs CPU mode
  const concurrencySelect = document.getElementById("batch-concurrency-select");
  if (concurrencySelect) {
    if (isOnline) {
      if (concurrencySelect.value === "1") concurrencySelect.value = "3";
    } else {
      concurrencySelect.value = "1";
    }
  }

  // Update batch render button initial label if not actively running
  const batchBtn = document.getElementById("btn-batch-generate");
  if (batchBtn && !state.isBatchRunning) {
    batchBtn.textContent = isOnline ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
  }

  // Update modal controls
  const urlInput = document.getElementById("colab-url-input");
  if (urlInput && remoteUrl !== undefined) {
    urlInput.value = remoteUrl || "";
  }

  const banner = document.getElementById("colab-status-banner");
  const bannerTitle = document.getElementById("banner-title");
  const bannerDesc = document.getElementById("banner-desc");

  if (banner && bannerTitle && bannerDesc) {
    if (isOnline) {
      banner.className = "colab-status-banner online";
      bannerTitle.textContent = "Current Mode: Colab GPU Accelerated (100x Speed)";
      bannerDesc.textContent = `Active endpoint: ${remoteUrl} (~0.2s per sentence synthesis). Locally cached forever.`;
    } else {
      banner.className = "colab-status-banner offline";
      bannerTitle.textContent = "Current Mode: Local CPU Engine";
      bannerDesc.textContent = "Generating on laptop CPU (~14s per new sentence). Connect Colab GPU for ~0.2s generation!";
    }
  }
}

async function openProject(projectId, updateUrl = true) {
  try {
    const res = await fetch(`/api/project?id=${encodeURIComponent(projectId)}&t=${Date.now()}`);
    if (!res.ok) throw new Error("Project not found");
    state.currentProject = await res.json();
    state.activeBlockIndex = 0;
    state.selectedBlockIndices = new Set([0]);
    state.lastClickedIndex = 0;
    state.undoStack = [];
    state.redoStack = [];
    updateUndoRedoUI();
    if (state.currentProject && state.currentProject.blocks) {
      state.currentProject.blocks.forEach(block => {
        const sig = getBlockSignature(block);
        if (block.cachedAudioUrl) {
          if (!block.cachedSig) {
            block.cachedSig = sig;
          } else if (block.cachedSig !== sig) {
            delete block.cachedAudioUrl;
            delete block.cachedSig;
          }
        }
      });
    }
    switchToView("studio", updateUrl);
    renderStudio();
  } catch (err) {
    console.error("Failed to load project: " + err);
    showToast("⚠️ Could not load project. Returning to dashboard.");
    switchToView("dashboard", true);
  }
}

async function saveCurrentProject() {
  if (!state.currentProject) return;
  try {
    await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.currentProject)
    });
  } catch (err) {
    console.error("Save error:", err);
  }
}

let saveTimeout = null;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveCurrentProject, 600);
}

function getBlockSignature(block) {
  const text = (block.text || "").trim();
  const voice = block.voice_id || "";
  const speed = Number(block.speed || 0.90).toFixed(2);
  const gain = Number(block.gain || 1.0).toFixed(2);
  const pitch = Number(block.pitch_shift || 0.0).toFixed(1);
  const warmth = Number(block.warmth || 0.0).toFixed(1);
  const clarity = Number(block.clarity || 0.0).toFixed(1);
  const reverb = Number(block.reverb || 0.0).toFixed(2);
  const filter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();
  let blendStr = "";
  if (block.blend_weights) {
    blendStr = Object.entries(block.blend_weights).sort().map(([k, v]) => `${k}:${Number(v).toFixed(2)}`).join(",");
  }
  return `${text}__${voice}__${blendStr}__${speed}__${gain}__${pitch}__${warmth}__${clarity}__${reverb}__${filter}`;
}

function getVoiceById(voiceId) {
  const vid = voiceId || "blend_fenrir_onyx";
  return state.voices.find(v => v.id === vid) || {
    id: vid,
    name: vid,
    badge: (vid || "VO").slice(0, 2).toUpperCase(),
    color: "#ea580c",
    flag: "🎙️",
    timbre: "Custom Voice"
  };
}

// ---------------- VIEW ROUTING & DIRECT LINKING ---------------- //

function switchToView(viewName, updateUrl = true) {
  state.currentView = viewName;
  const dashEl = document.getElementById("view-dashboard");
  const studioEl = document.getElementById("view-studio");

  if (viewName === "dashboard") {
    dashEl.style.display = "flex";
    studioEl.style.display = "none";
    document.title = "Story Projects — Kashva Studio TTS";
    if (updateUrl) {
      history.pushState({ view: "dashboard" }, "", "/");
    }
    loadProjectsList();
  } else {
    dashEl.style.display = "none";
    studioEl.style.display = "flex";
    const projTitle = state.currentProject?.title || "Story Studio";
    document.title = `${projTitle} — Kashva Studio TTS`;
    if (updateUrl && state.currentProject?.id) {
      const studioUrl = `/studio?project=${encodeURIComponent(state.currentProject.id)}`;
      history.pushState({ view: "studio", projectId: state.currentProject.id }, "", studioUrl);
    }
  }
}

// ---------------- DASHBOARD STATE & CONTROLS ---------------- //

let dashboardFilter = "all";
let dashboardSort = "recent";
let dashboardSearchQuery = "";
let dashboardLayout = "grid";
let currentDashboardAudio = null;
let activePreviewProjectId = null;

function formatAudioDuration(totalSeconds) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return "0s";
  const sec = Math.round(totalSeconds);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function handleDashboardSearch(val) {
  dashboardSearchQuery = (val || "").trim();
  const clearBtn = document.getElementById("dashboard-search-clear");
  if (clearBtn) clearBtn.style.display = dashboardSearchQuery ? "inline-flex" : "none";
  renderDashboard();
}

function clearDashboardSearch() {
  dashboardSearchQuery = "";
  const input = document.getElementById("dashboard-search-input");
  if (input) input.value = "";
  const clearBtn = document.getElementById("dashboard-search-clear");
  if (clearBtn) clearBtn.style.display = "none";
  renderDashboard();
}

function setDashboardFilter(filter) {
  dashboardFilter = filter;
  const pillBtns = document.querySelectorAll("#dashboard-filter-pills .filter-pill");
  pillBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  renderDashboard();
}

function handleDashboardSort(sortVal) {
  dashboardSort = sortVal;
  renderDashboard();
}

function setDashboardLayout(layout) {
  dashboardLayout = layout;
  const gridBtn = document.getElementById("btn-layout-grid");
  const listBtn = document.getElementById("btn-layout-list");
  if (gridBtn) gridBtn.classList.toggle("active", layout === "grid");
  if (listBtn) listBtn.classList.toggle("active", layout === "list");
  renderDashboard();
}

async function loadSampleStoryIntoProject() {
  openNewProjectModal();
  await loadSampleIntoNewProject();
}

function toggleDashboardPreview(projectId, audioUrl, buttonEl) {
  if (!audioUrl) return;

  if (activePreviewProjectId === projectId && currentDashboardAudio && !currentDashboardAudio.paused) {
    currentDashboardAudio.pause();
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
    return;
  }

  if (currentDashboardAudio) {
    currentDashboardAudio.pause();
    currentDashboardAudio = null;
    document.querySelectorAll(".preview-audio-btn.playing").forEach(btn => {
      btn.innerHTML = "▶ Preview";
      btn.classList.remove("playing");
    });
  }

  activePreviewProjectId = projectId;
  if (buttonEl) {
    buttonEl.innerHTML = "⏸ Pause";
    buttonEl.classList.add("playing");
  }

  currentDashboardAudio = new Audio(audioUrl);
  currentDashboardAudio.onended = () => {
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
  };
  currentDashboardAudio.onerror = () => {
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
    showToast("⚠️ Could not play audio preview");
  };
  currentDashboardAudio.play().catch(e => {
    console.warn("Audio play prevented:", e);
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
  });
}

async function handleDuplicateProject(projectId) {
  try {
    showToast("📋 Duplicating project...");
    const res = await fetch("/api/projects/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId })
    });
    const data = await res.json();
    const proj = data.project || (data.id ? data : null);
    if (proj && data.success !== false) {
      showToast(`✓ Duplicated as "${proj.title || "Copy"}"`);
      await loadProjectsList();
    } else {
      showToast("❌ Failed to duplicate project: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    showToast("❌ Duplicate error: " + err.message);
  }
}

async function handleRenameProject(projectId, currentTitle) {
  const newTitle = prompt("Enter new project title:", currentTitle);
  if (!newTitle || newTitle.trim() === "" || newTitle.trim() === currentTitle) {
    return;
  }
  try {
    showToast("✏️ Renaming project...");
    const res = await fetch("/api/projects/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, title: newTitle.trim() })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Renamed to "${data.title || newTitle.trim()}"`);
      await loadProjectsList();
    } else {
      showToast("❌ Failed to rename: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    showToast("❌ Rename error: " + err.message);
  }
}

// ---------------- VIEW 1: DASHBOARD RENDERING ---------------- //

function renderDashboard() {
  const grid = document.getElementById("projects-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const projects = state.projects || [];

  // 1. Calculate top metrics strip stats
  const totalProjectsCount = projects.length;
  let totalSentencesCount = 0;
  let totalRenderedAudioSec = 0;
  let countReady = 0;
  let countProgress = 0;
  let countDraft = 0;

  projects.forEach(p => {
    const total = p.block_count || 0;
    const rendered = p.rendered_count || 0;
    totalSentencesCount += total;
    totalRenderedAudioSec += (p.total_duration || 0);

    if (total > 0 && rendered >= total) {
      countReady++;
    } else if (rendered > 0) {
      countProgress++;
    } else {
      countDraft++;
    }
  });

  const statProjects = document.getElementById("stat-total-projects");
  if (statProjects) statProjects.textContent = totalProjectsCount;

  const statSentences = document.getElementById("stat-total-sentences");
  if (statSentences) statSentences.textContent = totalSentencesCount;

  const statAudio = document.getElementById("stat-total-audio");
  if (statAudio) statAudio.textContent = formatAudioDuration(totalRenderedAudioSec);

  const dashCount = document.getElementById("dashboard-project-count");
  if (dashCount) {
    dashCount.textContent = `${totalProjectsCount} project${totalProjectsCount === 1 ? '' : 's'}`;
  }

  // 2. Update filter pill counts
  const cAll = document.getElementById("filter-count-all");
  const cReady = document.getElementById("filter-count-ready");
  const cProg = document.getElementById("filter-count-progress");
  const cDraft = document.getElementById("filter-count-draft");
  if (cAll) cAll.textContent = totalProjectsCount;
  if (cReady) cReady.textContent = countReady;
  if (cProg) cProg.textContent = countProgress;
  if (cDraft) cDraft.textContent = countDraft;

  // 3. Apply layout mode
  if (dashboardLayout === "list") {
    grid.classList.add("projects-list-view");
  } else {
    grid.classList.remove("projects-list-view");
  }

  // 4. Filter projects
  let filtered = [...projects];

  if (dashboardSearchQuery) {
    const q = dashboardSearchQuery.toLowerCase();
    filtered = filtered.filter(p => (p.title || "").toLowerCase().includes(q));
  }

  if (dashboardFilter === "ready") {
    filtered = filtered.filter(p => (p.block_count > 0 && (p.rendered_count || 0) >= p.block_count));
  } else if (dashboardFilter === "progress") {
    filtered = filtered.filter(p => ((p.rendered_count || 0) > 0 && (p.rendered_count || 0) < (p.block_count || 0)));
  } else if (dashboardFilter === "draft") {
    filtered = filtered.filter(p => ((p.rendered_count || 0) === 0));
  }

  // 5. Sort projects
  if (dashboardSort === "recent") {
    filtered.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  } else if (dashboardSort === "sentences") {
    filtered.sort((a, b) => (b.block_count || 0) - (a.block_count || 0));
  } else if (dashboardSort === "duration") {
    filtered.sort((a, b) => (b.total_duration || 0) - (a.total_duration || 0));
  } else if (dashboardSort === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  // 6. Empty state handling
  if (filtered.length === 0) {
    const isSearching = Boolean(dashboardSearchQuery);
    const hasFilter = dashboardFilter !== "all";
    grid.innerHTML = `
      <div class="dashboard-empty-state">
        <div class="empty-icon">${isSearching ? "🔍" : "📂"}</div>
        <div class="empty-title">${isSearching ? `No stories match "${escapeHtml(dashboardSearchQuery)}"` : (hasFilter ? `No projects in this category` : "No projects yet")}</div>
        <div class="empty-desc">${isSearching ? "Check spelling or search by a different story title." : (hasFilter ? "Try selecting 'All' or a different filter tab above." : "Create your first story project or load a sample manuscript to get started.")}</div>
        <div style="display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; justify-content: center;">
          ${isSearching ? `<button class="btn btn-secondary" onclick="clearDashboardSearch()">Clear Search</button>` : ''}
          ${hasFilter ? `<button class="btn btn-secondary" onclick="setDashboardFilter('all')">View All Projects</button>` : ''}
          ${!isSearching && !hasFilter ? `
            <button class="btn btn-primary" onclick="openNewProjectModal()">＋ Create Story Project</button>
            <button class="btn btn-secondary" onclick="loadSampleStoryIntoProject()">📖 Load Sample</button>
          ` : ''}
        </div>
      </div>
    `;
    return;
  }

  // 7. Render project cards
  filtered.forEach(p => {
    const card = document.createElement("div");
    card.className = "project-card";

    const total = p.block_count || 0;
    const rendered = p.rendered_count || 0;
    const percent = total > 0 ? Math.min(100, Math.round((rendered / total) * 100)) : 0;

    let statusBadgeClass = "draft";
    let statusText = "Draft";
    if (total > 0 && rendered >= total) {
      statusBadgeClass = "ready";
      statusText = "✓ Ready";
    } else if (rendered > 0) {
      statusBadgeClass = "progress";
      statusText = `⚡ ${percent}%`;
    }

    const durationStr = formatAudioDuration(p.total_duration);
    const dateStr = formatTimeAgo(p.updated_at ? p.updated_at * 1000 : null);
    const studioUrl = `/studio?project=${encodeURIComponent(p.id)}`;
    const isPlaying = activePreviewProjectId === p.id && currentDashboardAudio && !currentDashboardAudio.paused;

    // Build cast voice badges
    let voicePillsHtml = "";
    if (p.voices_used && p.voices_used.length > 0) {
      const displayVoices = p.voices_used.slice(0, 3);
      const extraCount = p.voices_used.length - 3;
      voicePillsHtml = displayVoices.map(vId => {
        const vObj = state.voices ? state.voices.find(v => v.id === vId) : null;
        let vName = vObj ? vObj.name : vId.replace(/^blend_/, "").replace(/^a[mf]_/, "").replace(/_/g, " ");
        if (vName.length > 14) vName = vName.substring(0, 13) + "…";
        return `<span class="voice-badge" title="Voice: ${vObj?.name || vId}">${vObj?.flag || '🎙️'} ${escapeHtml(vName)}</span>`;
      }).join("");
      if (extraCount > 0) {
        voicePillsHtml += `<span class="voice-badge extra" title="${extraCount} more cast voices">+${extraCount}</span>`;
      }
    } else {
      voicePillsHtml = `<span class="voice-badge" style="opacity: 0.6;">🎙️ Default</span>`;
    }

    card.innerHTML = `
      <div class="project-card-header">
        <div class="project-card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
        <span class="proj-status-badge ${statusBadgeClass}">${statusText}</span>
      </div>

      <div class="project-render-bar" title="${rendered} of ${total} sentences rendered (${percent}%)">
        <div class="project-render-fill" style="width: ${percent}%;"></div>
      </div>

      <div class="project-meta-grid">
        <div class="meta-item"><span class="meta-label">Sentences:</span> <strong>${total}</strong> <span style="font-size: 11px; opacity: 0.65;">(${rendered} rendered)</span></div>
        <div class="meta-item"><span class="meta-label">Audio:</span> <strong>${durationStr}</strong></div>
        <div class="meta-item"><span class="meta-label">Modified:</span> <span>${dateStr}</span></div>
      </div>

      <div class="project-voices-wrap">
        <span class="meta-label" style="font-size: 11px; color: var(--text-subtle); margin-right: 4px;">Cast:</span>
        <div class="project-voices-pills">${voicePillsHtml}</div>
      </div>

      <div class="project-card-footer">
        <div class="footer-left-actions">
          <a href="${studioUrl}" target="_blank" class="btn btn-primary open-proj-btn" style="padding: 6px 14px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">Open in Studio ↗</a>
          ${p.preview_audio ? `<button class="preview-audio-btn ${isPlaying ? 'playing' : ''}" title="Quick audition of rendered dialogue">${isPlaying ? '⏸ Pause' : '▶ Preview'}</button>` : `<button class="preview-audio-btn disabled" disabled title="Render sentences in studio to audition audio">🔇 No Audio</button>`}
        </div>
        <div class="footer-right-actions">
          <button class="card-icon-btn duplicate-proj-btn" title="Duplicate project">📋</button>
          <button class="card-icon-btn rename-proj-btn" title="Rename project">✏️</button>
          <button class="card-icon-btn delete-proj-btn" title="Delete project">🗑️</button>
        </div>
      </div>
    `;

    // Click card body to open in studio (unless clicked on a button or link)
    card.addEventListener("click", (e) => {
      if (e.target.closest(".open-proj-btn") ||
          e.target.closest(".preview-audio-btn") ||
          e.target.closest(".duplicate-proj-btn") ||
          e.target.closest(".rename-proj-btn") ||
          e.target.closest(".delete-proj-btn")) {
        return;
      }
      window.open(studioUrl, "_blank");
    });

    // Preview button
    const previewBtn = card.querySelector(".preview-audio-btn:not(.disabled)");
    if (previewBtn) {
      previewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDashboardPreview(p.id, p.preview_audio, previewBtn);
      });
    }

    // Duplicate button
    card.querySelector(".duplicate-proj-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDuplicateProject(p.id);
    });

    // Rename button
    card.querySelector(".rename-proj-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleRenameProject(p.id, p.title);
    });

    // Delete button
    card.querySelector(".delete-proj-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Delete story project "${p.title}"? This cannot be undone.`)) {
        try {
          await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
          showToast(`🗑️ Deleted "${p.title}"`);
          loadProjectsList();
        } catch (err) {
          showToast("❌ Failed to delete project: " + err.message);
        }
      }
    });

    grid.appendChild(card);
  });
}

// ---------------- VIEW 2: STUDIO RENDERING ---------------- //

function renderStudio() {
  if (!state.currentProject) return;

  document.getElementById("project-title").value = state.currentProject.title || "Untitled Project";
  
  if (!state.selectedBlockIndices || state.selectedBlockIndices.size === 0) {
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
  }

  renderBlocks();
  renderInspector();
  renderSavedCharactersList();
  renderTimeline();
  updateSelectionUI();
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("studio-toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function getCharacterById(charId) {
  if (!charId || !state.savedCharacters) return null;
  return state.savedCharacters.find(c => c.id === charId) || null;
}

function renderBlocks() {
  const container = document.getElementById("story-container");
  const canvas = document.querySelector(".editor-canvas");
  const savedScrollTop = canvas ? canvas.scrollTop : 0;
  container.innerHTML = "";

  state.currentProject.blocks.forEach((block, idx) => {
    // ---------------- SCENE / SECTION DIVIDER (NON-SPOKEN) ---------------- //
    if (block.type === "heading" || block.is_spoken === false) {
      const isPlaying = state.currentlyPlayingBlockIdx === idx;
      const isSelected = state.selectedBlockIndices.has(idx);
      const isActive = state.activeBlockIndex === idx;

      const sceneRow = document.createElement("div");
      sceneRow.className = `scene-divider-row ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${isPlaying ? "playing" : ""}`;
      sceneRow.dataset.index = idx;

      const pVal = Number(block.pause_after !== undefined ? block.pause_after : 1.0).toFixed(1);

      sceneRow.innerHTML = `
        <div class="scene-divider-left">
          <div class="block-drag-handle scene-drag-handle" title="Drag to change order (or press Alt+↑ / Alt+↓)">
            <svg class="drag-handle-icon" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2.5" cy="2.5" r="1.5"/>
              <circle cx="7.5" cy="2.5" r="1.5"/>
              <circle cx="2.5" cy="8" r="1.5"/>
              <circle cx="7.5" cy="8" r="1.5"/>
              <circle cx="2.5" cy="13.5" r="1.5"/>
              <circle cx="7.5" cy="13.5" r="1.5"/>
            </svg>
          </div>
          <span class="scene-badge-icon" title="Scene / Chapter Divider">🎬</span>
          <div class="scene-content-col">
            <div class="scene-meta-row">
              <span class="scene-category-pill">Scene / Section Divider</span>
              <span class="scene-nonspoken-tag">🔇 Non-Spoken • Excluded from Voice Generation</span>
            </div>
            <input type="text" class="scene-title-input" value="${escapeHtml(block.text || '')}" placeholder="e.g. Scene 2: Day Three (non-spoken)...">
          </div>
        </div>
        <div class="scene-divider-right">
          <div class="scene-pause-box" title="Transition silence pause before the next scene starts">
            <span>⏱ Pause:</span>
            <input type="number" class="scene-pause-input" value="${pVal}" min="0" max="10" step="0.5">s
          </div>
          <div class="block-btn-cluster reorder-cluster">
            <button type="button" class="order-btn" onclick="moveBlockUp(${idx})" title="Move up (Alt+↑)">▲</button>
            <button type="button" class="order-btn" onclick="moveBlockDown(${idx})" title="Move down (Alt+↓)">▼</button>
          </div>
          <div class="block-btn-cluster insert-cluster">
            <button type="button" class="insert-block-btn" onclick="insertBlockAfter(${idx})" title="Insert sentence below this divider">＋</button>
            <button type="button" class="insert-block-btn" onclick="insertHeadingAfter(${idx})" title="Insert another scene divider below" style="font-size: 13px;">🎬</button>
          </div>
          <button type="button" class="scene-btn convert-speech-btn" onclick="convertHeadingToSpeech(${idx})" title="Convert to regular spoken sentence block">🎙️ Speak</button>
          <button type="button" class="scene-delete-btn" onclick="deleteBlock(${idx})" title="Delete scene heading">✕</button>
        </div>
      `;

      container.appendChild(sceneRow);
      attachBlockDragAndDrop(sceneRow, idx);

      const titleInput = sceneRow.querySelector(".scene-title-input");
      titleInput.addEventListener("input", (e) => {
        block.text = e.target.value;
        renderTimeline();
        debouncedSave();
      });
      titleInput.addEventListener("focus", () => {
        titleInput.dataset.initialText = block.text;
        selectBlock(idx, "single");
      });
      titleInput.addEventListener("blur", () => {
        if (titleInput.dataset.initialText !== undefined && titleInput.dataset.initialText !== block.text) {
          recordHistory("Edit Scene Title");
          delete titleInput.dataset.initialText;
        }
      });

      const pauseInput = sceneRow.querySelector(".scene-pause-input");
      pauseInput.addEventListener("change", (e) => {
        recordHistory("Change Scene Pause");
        block.pause_after = Math.max(0, parseFloat(e.target.value) || 0);
        debouncedSave();
      });

      sceneRow.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("input") || e.target.closest(".block-drag-handle")) return;
        selectBlock(idx, "single");
      });

      return;
    }

    // ---------------- SPOKEN SENTENCE BLOCK ---------------- //
    const voice = getVoiceById(block.voice_id);
    const row = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isReady = !!(block.cachedAudioUrl && block.cachedSig === currentSig);
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const isSelected = state.selectedBlockIndices.has(idx);
    const isActive = state.activeBlockIndex === idx;

    row.className = `block-row ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${isReady ? "ready" : ""} ${isPlaying ? "playing" : ""}`;
    row.dataset.index = idx;

    const durText = isReady ? (block.duration ? `● ${block.duration.toFixed(1)}s` : "● Ready") : "Draft (click ▶ to render)";

    const char = getCharacterById(block.character_id);
    const blockColor = (char && char.color) ? char.color : voice.color;
    const blockBadge = (char && char.badge) ? char.badge : (voice.badge || voice.id.slice(0, 2).toUpperCase());
    const isCustom = Boolean(char && block.is_custom_edited);
    const blockTitle = char
      ? `Character: ${char.name} (${voice.name})${isCustom ? ' • Customized for this sentence' : ' • Synced'}`
      : `Voice: ${voice.name} (Click to change)`;

    // SENTENCE BLOCK WITH AUDIO SCRUBBER, DRAG HANDLE & SLEEK CUSTOM CHECKBOX
    row.innerHTML = `
      <div class="block-drag-handle" title="Drag to change order (or press Alt+↑ / Alt+↓)">
        <svg class="drag-handle-icon" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2.5" cy="2.5" r="1.5"/>
          <circle cx="7.5" cy="2.5" r="1.5"/>
          <circle cx="2.5" cy="8" r="1.5"/>
          <circle cx="7.5" cy="8" r="1.5"/>
          <circle cx="2.5" cy="13.5" r="1.5"/>
          <circle cx="7.5" cy="13.5" r="1.5"/>
        </svg>
      </div>
      <button class="block-select-btn" data-index="${idx}" title="${isSelected ? 'Deselect sentence' : 'Select sentence'}">
        <span class="custom-chk-box"></span>
      </button>
      <button class="block-voice-btn" title="${escapeHtml(blockTitle)}">
        <div class="block-avatar" style="background-color: ${blockColor}">
          ${escapeHtml(blockBadge)}
          ${isCustom ? '<span class="custom-tweak-dot" title="Custom tweaked sentence"></span>' : ''}
        </div>
      </button>
      <div class="block-content-col">
        <textarea class="block-textarea" placeholder="Type sentence here...">${block.text || ""}</textarea>
        <div class="block-audio-scrubber" title="Click anywhere to jump & listen from this point">
          <div class="scrubber-track">
            <div class="scrubber-fill"></div>
          </div>
          <span class="scrubber-time">${durText}</span>
        </div>
      </div>
      <div class="block-actions">
        <div class="block-btn-cluster reorder-cluster">
          <button type="button" class="order-btn" onclick="moveBlockUp(${idx})" title="Move sentence up (Alt+↑)">▲</button>
          <button type="button" class="order-btn" onclick="moveBlockDown(${idx})" title="Move sentence down (Alt+↓)">▼</button>
        </div>
        <div class="block-btn-cluster insert-cluster">
          <button type="button" class="insert-block-btn" onclick="insertBlockAfter(${idx})" title="Insert new sentence below (Ctrl+Enter)">＋</button>
          <button type="button" class="insert-block-btn" onclick="insertHeadingAfter(${idx})" title="Insert non-spoken Scene Heading below (🎬)" style="font-size: 13px;">🎬</button>
        </div>
        <button type="button" class="play-block-btn" title="Play sentence (or Space)">${isPlaying ? "🔊" : "▶"}</button>
        <button type="button" class="delete-block-btn" onclick="deleteBlock(${idx})" title="Delete sentence">✕</button>
      </div>
    `;

    container.appendChild(row);
    attachBlockDragAndDrop(row, idx);

    const selBtn = row.querySelector(".block-select-btn");
    selBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBlock(idx, "toggle");
    });

    const textarea = row.querySelector(".block-textarea");
    autoResizeTextarea(textarea);

    textarea.addEventListener("input", (e) => {
      block.text = e.target.value;
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      delete block.duration;
      row.classList.remove("ready", "playing");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      autoResizeTextarea(textarea);
      renderTimeline();
      debouncedSave();
    });

    textarea.addEventListener("focus", () => {
      textarea.dataset.initialText = block.text || "";
      if (textarea.value === "New sentence..." || textarea.value === "Type sentence here...") {
        textarea.select();
      }
      if (!state.selectedBlockIndices.has(idx)) {
        selectBlock(idx, "single");
      } else {
        state.activeBlockIndex = idx;
        renderInspector();
        highlightTimelineBlock(idx);
        updateActiveSentenceHint(idx);
      }
    });

    textarea.addEventListener("blur", () => {
      if (textarea.dataset.initialText !== undefined && textarea.dataset.initialText !== (block.text || "")) {
        recordHistory("Edit Sentence");
        delete textarea.dataset.initialText;
      }
    });

    textarea.addEventListener("keydown", (e) => {
      // Ctrl+Enter or Cmd+Enter to quickly insert the next sentence block right below
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        insertBlockAfter(idx);
      }
    });

    // Word-level click & seek within textarea
    textarea.addEventListener("click", () => {
      if (!state.selectedBlockIndices.has(idx)) {
        selectBlock(idx, "single");
      }
      const charPos = textarea.selectionStart;
      const totalChars = Math.max(textarea.value.length, 1);
      const ratio = Math.min(Math.max(charPos / totalChars, 0), 1);

      if (state.currentlyPlayingBlockIdx === idx && state.storyAudioPlayer.duration) {
        state.storyAudioPlayer.currentTime = ratio * state.storyAudioPlayer.duration;
      }
    });

    // Double-click word to jump & start playing from that word!
    textarea.addEventListener("dblclick", () => {
      selectBlock(idx, "single");
      const charPos = textarea.selectionStart;
      const totalChars = Math.max(textarea.value.length, 1);
      const ratio = Math.min(Math.max(charPos / totalChars, 0), 1);
      const targetSec = ratio * (block.duration || 4.0);
      state.isPlayingStory = true;
      playBlockAudio(idx, targetSec, false);
    });

    // Scrubber click seeks directly
    const scrubberTrack = row.querySelector(".scrubber-track");
    scrubberTrack.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBlock(idx, "single");
      const rect = scrubberTrack.getBoundingClientRect();
      const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      if (state.currentlyPlayingBlockIdx === idx && state.storyAudioPlayer.duration) {
        state.storyAudioPlayer.currentTime = ratio * state.storyAudioPlayer.duration;
      } else {
        const targetSec = ratio * (block.duration || 4.0);
        state.isPlayingStory = true;
        playBlockAudio(idx, targetSec, false);
      }
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("textarea") || e.target.closest(".scrubber-track")) {
        return;
      }
      if (e.shiftKey) {
        selectBlock(idx, "range");
      } else if (e.ctrlKey || e.metaKey) {
        selectBlock(idx, "toggle");
      } else {
        selectBlock(idx, "single");
      }
    });

    // Voice button opens drawer
    row.querySelector(".block-voice-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openVoiceDrawer(idx);
    });

    // Play block audio button
    const playBtn = row.querySelector(".play-block-btn");
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.currentlyPlayingBlockIdx === idx && state.isPlayingStory && !state.storyAudioPlayer.paused) {
        pauseStoryPlayback();
      } else {
        state.isPlayingStory = true;
        playBlockAudio(idx, 0, false);
      }
    });

    // Delete block
    row.querySelector(".delete-block-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteBlock(idx);
    });
  });

  if (canvas && savedScrollTop > 0) {
    canvas.scrollTop = savedScrollTop;
  }
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.max(el.scrollHeight, 48) + "px";
}

function selectBlock(idx, mode = "single") {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  if (idx < 0 || idx >= total) return;

  if (mode === "single") {
    state.selectedBlockIndices = new Set([idx]);
    state.activeBlockIndex = idx;
    state.lastClickedIndex = idx;
  } else if (mode === "toggle") {
    if (state.selectedBlockIndices.has(idx)) {
      if (state.selectedBlockIndices.size > 1) {
        state.selectedBlockIndices.delete(idx);
        if (state.activeBlockIndex === idx) {
          state.activeBlockIndex = Array.from(state.selectedBlockIndices)[0];
        }
      }
    } else {
      state.selectedBlockIndices.add(idx);
      state.activeBlockIndex = idx;
    }
    state.lastClickedIndex = idx;
  } else if (mode === "range") {
    const start = Math.min(state.lastClickedIndex ?? 0, idx);
    const end = Math.max(state.lastClickedIndex ?? 0, idx);
    for (let i = start; i <= end; i++) {
      state.selectedBlockIndices.add(i);
    }
    state.activeBlockIndex = idx;
  }

  updateSelectionDOM();
  renderInspector();
  highlightTimelineBlock(state.activeBlockIndex);
  updateActiveSentenceHint(state.activeBlockIndex);
  updateSelectionUI();
}

function updateSelectionDOM() {
  const rows = document.querySelectorAll(".block-row, .scene-divider-row");
  rows.forEach((row, i) => {
    const isSelected = state.selectedBlockIndices.has(i);
    const isActive = state.activeBlockIndex === i;
    row.classList.toggle("selected", isSelected);
    row.classList.toggle("active", isActive);
    const selBtn = row.querySelector(".block-select-btn");
    if (selBtn) {
      selBtn.title = isSelected ? "Deselect sentence" : "Select sentence";
    }
  });
}

function updateSelectionUI() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  const count = state.selectedBlockIndices.size;
  const allSelected = (count === total && total > 0);

  // Header badge
  const badge = document.getElementById("selection-count-badge");
  if (badge) {
    if (count > 1) {
      badge.style.display = "inline-flex";
      badge.textContent = `${count} Selected`;
    } else {
      badge.style.display = "none";
    }
  }

  // Inspector scope label
  const scopeLabel = document.getElementById("inspector-scope-label");
  if (scopeLabel) {
    scopeLabel.textContent = count > 1 ? `${count} Sentences (Bulk)` : "1 Sentence";
  }

  // Canvas Action Bar
  const bar = document.getElementById("canvas-action-bar");
  if (bar) {
    bar.classList.toggle("has-selection", count > 1);
  }

  const icon = document.getElementById("select-all-icon");
  const label = document.getElementById("select-all-label");
  const countPill = document.getElementById("bulk-selection-count-text");
  const btnVoice = document.getElementById("btn-bulk-change-voice");
  const btnMerge = document.getElementById("btn-bulk-merge");
  const btnRender = document.getElementById("btn-bulk-render");
  const btnDelete = document.getElementById("btn-bulk-delete");

  if (icon && label) {
    if (allSelected) {
      icon.textContent = "✓";
      label.textContent = "Deselect All";
    } else if (count > 1) {
      icon.textContent = "☐";
      label.textContent = `Select All (${total})`;
    } else {
      icon.textContent = "☐";
      label.textContent = "Select All";
    }
  }

  if (countPill) {
    if (count > 1) {
      countPill.style.display = "inline-flex";
      countPill.textContent = `${count} of ${total} Selected`;
    } else {
      countPill.style.display = "none";
    }
  }

  if (btnVoice) {
    btnVoice.style.display = count > 1 ? "inline-flex" : "none";
    btnVoice.textContent = `👥 Voice (${count})`;
  }
  if (btnMerge) {
    btnMerge.style.display = count > 1 ? "inline-flex" : "none";
    btnMerge.textContent = `🔗 Merge (${count})`;
  }
  if (btnRender) {
    btnRender.style.display = count > 1 ? "inline-flex" : "none";
    btnRender.textContent = `⚡ Render (${count})`;
  }
  if (btnDelete) {
    btnDelete.style.display = count > 1 ? "inline-flex" : "none";
    btnDelete.textContent = `🗑️ Delete (${count})`;
  }

  const btnExport = document.getElementById("btn-bulk-export");
  if (btnExport) {
    if (count === 1) {
      btnExport.style.display = "inline-flex";
      btnExport.innerHTML = `🎵 Export WAV`;
      btnExport.title = "Export selected sentence as WAV audio file";
    } else if (count > 1) {
      btnExport.style.display = "inline-flex";
      btnExport.innerHTML = `📦 Export ZIP (${count})`;
      btnExport.title = `Export ${count} selected sentences into a ZIP archive`;
    } else {
      btnExport.style.display = "none";
    }
  }

  // Update dynamic options inside unified export dropdown
  updateExportDropdownUI();

  const btnSelectAll = document.getElementById("btn-toggle-select-all");
  if (btnSelectAll) {
    btnSelectAll.title = allSelected ? "Deselect all sentences in this story" : (count > 1 ? `Select all (${total}) sentences` : "Select all sentences in this story");
  }

  // Update Apply to Selected inspector buttons
  const btnApplyVoice = document.getElementById("btn-apply-voice-to-selected");
  const btnApplySettings = document.getElementById("btn-apply-settings-to-selected");
  const applySelectedBadge = document.getElementById("apply-selected-count-badge");

  if (btnApplyVoice) {
    btnApplyVoice.textContent = count > 1 ? `🎭 Apply Voice to Selected (${count})` : "🎭 Apply Voice to Selected";
  }
  if (btnApplySettings) {
    btnApplySettings.textContent = count > 1 ? `⚡ Apply Audio FX & Pacing Only (${count})` : "⚡ Apply Audio FX & Pacing Only";
  }
  const btnApplyBothList = document.querySelectorAll(".btn-apply-both-to-selected");
  btnApplyBothList.forEach(btn => {
    btn.textContent = count > 1 ? `✨ Apply Voice & Settings to Selected (${count})` : "✨ Apply Voice & Settings to Selected";
  });
  if (applySelectedBadge) {
    applySelectedBadge.textContent = count > 1 ? `${count} Selected` : "1 Sentence";
  }

  updateDefaultVoiceButtonUI();
}

function updateDefaultVoiceButtonUI() {
  const btn = document.getElementById("btn-make-default-voice");
  const indicator = document.getElementById("default-voice-indicator");
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const defVoiceId = state.currentProject.default_voice || "blend_fenrir_onyx";
  const isDefault = (activeBlock.voice_id === defVoiceId);

  if (indicator) {
    indicator.textContent = isDefault ? "👑 Default Narrator" : "";
  }

  if (btn) {
    if (isDefault) {
      btn.textContent = "✓ Active Default Narrator";
      btn.classList.add("primary");
      btn.title = "This voice is currently the story's default narrator";
    } else {
      btn.textContent = "★ Make Default Story Narrator";
      btn.classList.remove("primary");
      btn.title = "Make this voice the default narrator and apply across all sentences";
    }
  }
}

function toggleSelectAll() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  const allSelected = (state.selectedBlockIndices.size === total && total > 0);

  if (allSelected) {
    const keepIdx = (state.activeBlockIndex >= 0 && state.activeBlockIndex < total) ? state.activeBlockIndex : 0;
    state.selectedBlockIndices = new Set([keepIdx]);
    state.activeBlockIndex = keepIdx;
  } else {
    state.selectedBlockIndices = new Set(Array.from({ length: total }, (_, i) => i));
  }

  updateSelectionDOM();
  updateSelectionUI();
}

function handleMakeDefaultVoice() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  recordHistory("Set Default Narrator");

  const newVoiceId = activeBlock.voice_id || "blend_fenrir_onyx";
  const newBlendWeights = activeBlock.blend_weights ? JSON.parse(JSON.stringify(activeBlock.blend_weights)) : null;
  const voiceObj = getVoiceById(newVoiceId);

  state.currentProject.default_voice = newVoiceId;
  if (state.currentProject.default_settings) {
    state.currentProject.default_settings.voice_id = newVoiceId;
    if (newBlendWeights) {
      state.currentProject.default_settings.blend_weights = JSON.parse(JSON.stringify(newBlendWeights));
    } else {
      delete state.currentProject.default_settings.blend_weights;
    }
  }

  let updatedCount = 0;
  state.currentProject.blocks.forEach(b => {
    b.voice_id = newVoiceId;
    if (newBlendWeights) {
      b.blend_weights = JSON.parse(JSON.stringify(newBlendWeights));
    } else {
      delete b.blend_weights;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    updatedCount++;
  });

  renderStudio();
  debouncedSave();
  showToast(`👑 Set "${voiceObj.name}" as Default Narrator across all ${updatedCount} sentences!`);
}

function handleBulkDelete() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const count = state.selectedBlockIndices.size;
  if (count === 0) return;

  recordHistory(`Bulk Delete ${count} Sentences`);

  const remaining = state.currentProject.blocks.filter((_, idx) => !state.selectedBlockIndices.has(idx));
  if (remaining.length === 0) {
    const defs = getProjectDefaultSettings();
    const newB = {
      id: "b_1",
      text: "Type sentence here...",
      voice_id: defs.voice_id,
      speed: defs.speed,
      gain: defs.gain,
      pause_after: defs.pause_after,
      pitch_shift: defs.pitch_shift,
      warmth: defs.warmth,
      clarity: defs.clarity,
      reverb: defs.reverb,
      radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
      fx_filter: defs.fx_filter
    };
    if (defs.blend_weights) newB.blend_weights = JSON.parse(JSON.stringify(defs.blend_weights));
    state.currentProject.blocks = [newB];
  } else {
    state.currentProject.blocks = remaining;
  }

  state.selectedBlockIndices = new Set([0]);
  state.activeBlockIndex = 0;
  state.lastClickedIndex = 0;
  renderStudio();
  debouncedSave();
  showToast(`✓ Deleted ${count} sentence(s).`);
}

function handleBulkMergeSelected() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const selectedList = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
  if (selectedList.length < 2) {
    showToast("⚠️ Select at least 2 sentences to merge.");
    return;
  }

  recordHistory(`Merge ${selectedList.length} Sentences`);

  const firstIdx = selectedList[0];
  const lastIdx = selectedList[selectedList.length - 1];
  const firstBlock = state.currentProject.blocks[firstIdx];
  const lastBlock = state.currentProject.blocks[lastIdx];

  const combinedText = selectedList
    .map(idx => (state.currentProject.blocks[idx]?.text || "").trim())
    .filter(t => t.length > 0)
    .join(" ");

  firstBlock.text = combinedText;
  firstBlock.pause_after = lastBlock.pause_after || firstBlock.pause_after || 0.6;
  delete firstBlock.cachedAudioUrl;
  delete firstBlock.cachedSig;
  delete firstBlock.duration;

  // Remove the other selected blocks
  const toRemove = new Set(selectedList.slice(1));
  state.currentProject.blocks = state.currentProject.blocks.filter((_, idx) => !toRemove.has(idx));

  state.selectedBlockIndices = new Set([firstIdx]);
  state.activeBlockIndex = firstIdx;
  state.lastClickedIndex = firstIdx;

  renderStudio();
  debouncedSave();
  showToast(`🔗 Merged ${selectedList.length} sentences into 1 block!`);
}

async function handleMergeShortBlocks() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length <= 1) {
    showToast("ℹ️ Not enough sentences to merge.");
    return;
  }

  const btn = document.getElementById("btn-merge-short");
  if (btn) {
    btn.textContent = "⏳ Merging...";
    btn.disabled = true;
  }

  const initialCount = state.currentProject.blocks.length;

  try {
    const res = await fetch("/api/merge_short", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        max_chars: 35,
        max_words: 5
      })
    });

    const mergedBlocks = await res.json();
    if (!Array.isArray(mergedBlocks) || mergedBlocks.length === 0) {
      showToast("ℹ️ No ultra-short blocks found to merge.");
      return;
    }

    if (mergedBlocks.length === initialCount) {
      showToast("ℹ️ All sentences are already optimal length (no ultra-short fragments found).");
      return;
    }

    recordHistory("Merge Short Sentences");

    state.currentProject.blocks = mergedBlocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;

    renderStudio();
    debouncedSave();
    const diff = initialCount - mergedBlocks.length;
    showToast(`🔗 Merged ${diff} ultra-short sentences of same narrator! Reduced story from ${initialCount} to ${mergedBlocks.length} blocks.`);
  } catch (err) {
    console.error("Merge error:", err);
    showToast("❌ Merge error: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = "🔗 Merge Short";
      btn.disabled = false;
    }
  }
}

// ---------------- APPLY TO SELECTED SENTENCES ---------------- //

function handleApplyVoiceToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply this voice to.");
    return;
  }

  const voice = getVoiceById(activeBlock.voice_id);
  recordHistory(`Apply Voice to Selected (${spokenTargets.length})`);

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.voice_id = activeBlock.voice_id;
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }
    if (activeBlock.character_id) {
      b.character_id = activeBlock.character_id;
      b.is_custom_edited = Boolean(activeBlock.is_custom_edited);
    } else if (b.character_id) {
      b.is_custom_edited = true;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      const avatar = row.querySelector(".block-avatar");
      if (avatar) {
        avatar.style.backgroundColor = voice.color;
        avatar.textContent = voice.badge || voice.id.slice(0, 2).toUpperCase();
      }
    }
  });

  renderStudio();
  debouncedSave();
  showToast(`🎭 Applied voice "${voice.name}" to ${spokenTargets.length} selected sentences!`);
}

function handleApplySettingsToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply these settings to.");
    return;
  }

  recordHistory(`Apply Audio FX & Pacing to Selected (${spokenTargets.length})`);

  const gainVal = activeBlock.gain !== undefined ? activeBlock.gain : 1.0;
  const speedVal = activeBlock.speed !== undefined ? activeBlock.speed : 0.90;
  const pauseVal = activeBlock.pause_after !== undefined ? activeBlock.pause_after : 0.6;
  const pitchVal = Number(activeBlock.pitch_shift || 0.0);
  const warmthVal = Number(activeBlock.warmth || 0.0);
  const clarityVal = Number(activeBlock.clarity || 0.0);
  const reverbVal = Number(activeBlock.reverb || 0.0);
  const radioVal = Boolean(activeBlock.radio_fx);
  const filterVal = (activeBlock.fx_filter || (radioVal ? "radio" : "none")).toLowerCase();

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.gain = gainVal;
    b.speed = speedVal;
    b.pause_after = pauseVal;
    b.pitch_shift = pitchVal;
    b.warmth = warmthVal;
    b.clarity = clarityVal;
    b.reverb = reverbVal;
    b.radio_fx = (filterVal === "radio");
    b.fx_filter = filterVal;
    if (b.character_id) {
      b.is_custom_edited = true;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
    }
  });

  renderStudio();
  debouncedSave();
  showToast(`⚡ Applied pacing, pitch, EQ & filter to ${spokenTargets.length} selected sentences!`);
}

function handleApplyVoiceAndSettingsToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a source spoken sentence first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply voice & settings to.");
    return;
  }

  recordHistory(`Apply Voice & Settings to Selected (${spokenTargets.length})`);

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    b.voice_id = activeBlock.voice_id;
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }

    b.speed = activeBlock.speed !== undefined ? activeBlock.speed : 0.90;
    b.gain = activeBlock.gain !== undefined ? activeBlock.gain : 1.0;
    b.pause_after = activeBlock.pause_after !== undefined ? activeBlock.pause_after : 0.6;
    b.pitch_shift = Number(activeBlock.pitch_shift || 0.0);
    b.warmth = Number(activeBlock.warmth || 0.0);
    b.clarity = Number(activeBlock.clarity || 0.0);
    b.reverb = Number(activeBlock.reverb || 0.0);
    b.fx_filter = activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none");
    b.radio_fx = Boolean(activeBlock.radio_fx || activeBlock.fx_filter === "radio");

    if (activeBlock.character_id) {
      b.character_id = activeBlock.character_id;
      b.is_custom_edited = Boolean(activeBlock.is_custom_edited);
    } else {
      delete b.character_id;
      delete b.is_custom_edited;
    }

    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;
  });

  renderStudio();
  debouncedSave();
  showToast(`✨ Applied Voice & All Settings to ${spokenTargets.length} selected sentences!`);
}

function handleApplyVoiceToAll() {
  handleApplyVoiceToSelected();
}

function handleApplyPacingToAll() {
  handleApplySettingsToSelected();
}

// ---------------- SAVED CHARACTER VOICES LIBRARY ---------------- //

const CHARACTER_COLOR_PALETTE = [
  "#6366f1", // Indigo
  "#3b82f6", // Blue
  "#06b6d4", // Cyan
  "#10b981", // Emerald
  "#eab308", // Amber
  "#f97316", // Orange
  "#ef4444", // Red
  "#ec4899", // Pink
  "#a855f7"  // Purple
];

function loadSavedCharacters() {
  try {
    const raw = localStorage.getItem("kss_saved_characters");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        state.savedCharacters = parsed;
        return;
      }
    }
  } catch (e) {
    console.warn("Could not load saved characters from localStorage:", e);
  }

  state.savedCharacters = [
    {
      id: "char_narrator",
      name: "Narrator (Studio)",
      voice_id: "blend_fenrir_onyx",
      speed: 0.90,
      gain: 1.0,
      pause_after: 0.6,
      pitch_shift: 0.0,
      warmth: 0.0,
      clarity: 0.0,
      reverb: 0.0,
      fx_filter: "none",
      radio_fx: false,
      color: "#6366f1",
      badge: "NA"
    },
    {
      id: "char_hero",
      name: "Protagonist / Hero",
      voice_id: "am_adam",
      speed: 0.94,
      gain: 1.0,
      pause_after: 0.7,
      pitch_shift: 0.5,
      warmth: 1.0,
      clarity: 1.5,
      reverb: 0.0,
      fx_filter: "none",
      radio_fx: false,
      color: "#3b82f6",
      badge: "HE"
    },
    {
      id: "char_sarah",
      name: "Sarah (Heroine)",
      voice_id: "af_sarah",
      speed: 0.92,
      gain: 1.0,
      pause_after: 0.8,
      pitch_shift: 1.0,
      warmth: 0.5,
      clarity: 2.0,
      reverb: 0.05,
      fx_filter: "none",
      radio_fx: false,
      color: "#ec4899",
      badge: "SA"
    },
    {
      id: "char_radio",
      name: "Radio Dispatcher",
      voice_id: "am_michael",
      speed: 0.92,
      gain: 1.0,
      pause_after: 0.7,
      pitch_shift: 0.0,
      warmth: 0.0,
      clarity: 1.5,
      reverb: 0.0,
      fx_filter: "radio",
      radio_fx: true,
      color: "#eab308",
      badge: "RD"
    }
  ];
  saveSavedCharactersToStorage();
}

function saveSavedCharactersToStorage() {
  try {
    localStorage.setItem("kss_saved_characters", JSON.stringify(state.savedCharacters));
  } catch (e) {
    console.warn("Could not save characters to localStorage:", e);
  }
}

function renderSavedCharactersList() {
  const container = document.getElementById("saved-characters-list");
  const countBadge = document.getElementById("characters-count-badge");
  const drawerBadge = document.getElementById("drawer-characters-badge");

  const total = state.savedCharacters ? state.savedCharacters.length : 0;
  if (countBadge) countBadge.textContent = total;
  if (drawerBadge) {
    drawerBadge.textContent = total;
    drawerBadge.style.display = total > 0 ? "inline-flex" : "none";
  }

  if (!container) return;
  container.innerHTML = "";

  if (total === 0) {
    container.innerHTML = `
      <div class="saved-char-empty">
        No character voices saved yet.<br>
        <span style="font-size: 11px; opacity: 0.75;">Click "＋ Save Current" to save active voice & settings as a character.</span>
      </div>
    `;
    return;
  }

  const activeBlock = (state.currentProject?.blocks && typeof state.activeBlockIndex === "number")
    ? state.currentProject.blocks[state.activeBlockIndex]
    : null;

  state.savedCharacters.forEach(char => {
    const card = document.createElement("div");
    const voiceObj = getVoiceById(char.voice_id);
    const isMatching = Boolean(
      activeBlock &&
      activeBlock.voice_id === char.voice_id &&
      (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")) === char.fx_filter
    );

    card.className = `saved-char-card ${isMatching ? "active-char" : ""}`;
    card.dataset.charId = char.id;
    card.title = `Click to apply ${char.name} to selected sentence(s)`;

    const badgeText = char.badge || char.name.slice(0, 2).toUpperCase();
    const filterTag = (char.fx_filter && char.fx_filter !== "none")
      ? `<span class="saved-char-filter-pill">${char.fx_filter.toUpperCase()}</span>`
      : "";

    const speedStr = `${Number(char.speed || 0.90).toFixed(2)}x`;
    const pitchStr = char.pitch_shift ? ` • ${(char.pitch_shift > 0 ? '+' : '') + Number(char.pitch_shift).toFixed(1)}st` : "";
    const filterStr = (char.fx_filter && char.fx_filter !== "none") ? ` • ${char.fx_filter}` : "";

    card.innerHTML = `
      <div class="saved-char-left">
        <div class="saved-char-avatar" style="background-color: ${char.color || '#6366f1'}">
          ${escapeHtml(badgeText)}
        </div>
        <div class="saved-char-info">
          <div class="saved-char-name-row">
            <span class="saved-char-name">${escapeHtml(char.name)}</span>
            ${filterTag}
          </div>
          <span class="saved-char-details">${escapeHtml(voiceObj.name)} • ${speedStr}${pitchStr}${filterStr}</span>
        </div>
      </div>
      <div class="saved-char-actions">
        <button type="button" class="saved-char-btn" title="Apply character to selected sentence(s)">Apply</button>
        <button type="button" class="saved-char-icon-btn" title="Update character with current panel settings" data-action="update">🔄</button>
        <button type="button" class="saved-char-icon-btn" title="Edit character voice & settings" data-action="edit">✏️</button>
        <button type="button" class="saved-char-icon-btn danger" title="Delete character" data-action="delete">✕</button>
      </div>
    `;

    // Click on name allows quick rename via double-click
    const nameEl = card.querySelector(".saved-char-name");
    if (nameEl) {
      nameEl.title = "Double-click to quick rename";
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        renameCharacter(char.id);
      });
    }

    card.addEventListener("click", () => {
      applyCharacterToSelected(char.id);
    });

    const updateBtn = card.querySelector('[data-action="update"]');
    if (updateBtn) {
      updateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        updateCharacterWithCurrent(char.id);
      });
    }

    const editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditCharacterModal(char.id);
      });
    }

    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCharacter(char.id);
      });
    }

    container.appendChild(card);
  });
}

// ---------------- CHARACTER MODAL & AUTO-SYNC ENGINE ---------------- //

function populateCharModalVoiceSelect() {
  const select = document.getElementById("char-modal-voice-select");
  if (!select || !state.voices || state.voices.length === 0) return;

  const html = state.voices.map(v => {
    return `<option value="${v.id}">${v.flag || "🎙️"} ${v.name} (${v.accent} ${v.gender}) - ${v.timbre || 'Voice'}</option>`;
  }).join("");
  select.innerHTML = html;
}

function setCharModalSlider(sliderId, valId, value, formatter) {
  const slider = document.getElementById(sliderId);
  const valEl = document.getElementById(valId);
  if (slider) slider.value = value;
  if (valEl) valEl.textContent = formatter(value);
}

function selectCharModalFilter(filterName) {
  state.charModalFxFilter = (filterName || "none").toLowerCase();
  const grid = document.getElementById("char-fx-grid");
  if (grid) {
    grid.querySelectorAll(".fx-filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === state.charModalFxFilter);
    });
  }
  const labelEl = document.getElementById("char-val-filter");
  if (labelEl) {
    const labels = {
      none: "Clean Studio",
      radio: "Radio",
      whisper: "Soft Whisper",
      scream: "Intense Scream",
      demon: "Deep Demon",
      youth: "Child / Youth"
    };
    labelEl.textContent = labels[state.charModalFxFilter] || state.charModalFxFilter;
  }
}

function renderCharModalPalette(selectedColor) {
  state.selectedCharacterColor = selectedColor || "#6366f1";
  const paletteEl = document.getElementById("char-modal-color-palette");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  if (avatarPreview) {
    avatarPreview.style.backgroundColor = state.selectedCharacterColor;
  }
  if (!paletteEl) return;
  paletteEl.innerHTML = "";
  CHARACTER_COLOR_PALETTE.forEach(color => {
    const sw = document.createElement("div");
    sw.className = `char-color-swatch ${color === state.selectedCharacterColor ? 'active' : ''}`;
    sw.style.backgroundColor = color;
    sw.addEventListener("click", () => {
      state.selectedCharacterColor = color;
      paletteEl.querySelectorAll(".char-color-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
      if (avatarPreview) avatarPreview.style.backgroundColor = color;
    });
    paletteEl.appendChild(sw);
  });
}

function updateCharModalVoiceDetails(voiceId) {
  const voice = getVoiceById(voiceId);
  const nameEl = document.getElementById("char-modal-voice-name");
  const subEl = document.getElementById("char-modal-voice-sub");
  if (nameEl) nameEl.textContent = voice.name;
  if (subEl) subEl.textContent = voice.timbre ? `${voice.gender.toUpperCase()} • ${voice.timbre}` : voice.gender.toUpperCase();
}

function pullActiveSentenceToCharModal() {
  if (!state.currentProject?.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const block = state.currentProject.blocks[activeIdx];
  if (!block || block.type === "heading" || block.is_spoken === false) {
    showToast("⚠️ Active block is not a spoken sentence.");
    return;
  }

  // Voice Actor
  const voiceSelect = document.getElementById("char-modal-voice-select");
  if (voiceSelect && block.voice_id) {
    voiceSelect.value = block.voice_id;
    updateCharModalVoiceDetails(block.voice_id);
  }

  // Sliders
  const speed = block.speed !== undefined ? Number(block.speed) : 0.90;
  const pause = block.pause_after !== undefined ? Number(block.pause_after) : 0.6;
  const pitch = Number(block.pitch_shift || 0.0);
  const warmth = Number(block.warmth || 0.0);
  const clarity = Number(block.clarity || 0.0);
  const reverb = Number(block.reverb || 0.0);
  const filter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();

  setCharModalSlider("char-slider-speed", "char-val-speed", speed, v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", pause, v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", pitch, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", warmth, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", clarity, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(reverb * 100), v => `${v}%`);
  selectCharModalFilter(filter);

  showToast("📥 Pulled voice actor & tone settings from active sentence!");
}

function openEditCharacterModal(charId) {
  const char = getCharacterById(charId);
  if (!char) return;

  state.editingCharacterId = charId;
  populateCharModalVoiceSelect();

  const modal = document.getElementById("save-character-modal");
  const titleEl = document.getElementById("save-character-modal-title");
  const confirmBtn = document.getElementById("btn-save-character-confirm");
  const nameInput = document.getElementById("char-modal-name-input");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  const voiceSelect = document.getElementById("char-modal-voice-select");
  const linkedInfo = document.getElementById("char-modal-linked-info");

  if (titleEl) titleEl.textContent = `Edit Character: ${char.name}`;
  if (confirmBtn) confirmBtn.innerHTML = `💾 Save & Sync Character`;
  if (nameInput) {
    nameInput.value = char.name;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  if (voiceSelect) {
    voiceSelect.value = char.voice_id;
  }
  updateCharModalVoiceDetails(char.voice_id);

  // Sliders
  setCharModalSlider("char-slider-speed", "char-val-speed", Number(char.speed !== undefined ? char.speed : 0.90), v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", Number(char.pause_after !== undefined ? char.pause_after : 0.6), v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", Number(char.pitch_shift || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", Number(char.warmth || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", Number(char.clarity || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(Number(char.reverb || 0.0) * 100), v => `${v}%`);
  selectCharModalFilter(char.fx_filter || (char.radio_fx ? "radio" : "none"));

  renderCharModalPalette(char.color || "#6366f1");

  if (avatarPreview) {
    avatarPreview.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
  }

  // Linked Sentences Count calculation
  if (linkedInfo && state.currentProject?.blocks) {
    const linkedBlocks = state.currentProject.blocks.filter(b => b.character_id === char.id);
    const customCount = linkedBlocks.filter(b => b.is_custom_edited === true).length;
    const syncableCount = linkedBlocks.length - customCount;

    if (linkedBlocks.length === 0) {
      linkedInfo.innerHTML = `ℹ️ No sentences currently assigned to this character in this story.`;
    } else if (customCount === 0) {
      linkedInfo.innerHTML = `🔗 <strong>${linkedBlocks.length} sentence${linkedBlocks.length > 1 ? 's' : ''}</strong> in this story will update immediately upon saving.`;
    } else {
      linkedInfo.innerHTML = `🔗 <strong>${syncableCount} sentence${syncableCount !== 1 ? 's' : ''}</strong> will update immediately. <br><span style="color: #fbbf24;">🛡️ ${customCount} custom-edited sentence${customCount > 1 ? 's' : ''} will be strictly preserved.</span>`;
    }
    linkedInfo.style.display = "block";
  }

  if (modal) modal.classList.add("active");
}

function handleOpenSaveCharacterModal() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first to capture its voice & settings.");
    return;
  }

  state.editingCharacterId = null; // Create mode
  populateCharModalVoiceSelect();

  const modal = document.getElementById("save-character-modal");
  const titleEl = document.getElementById("save-character-modal-title");
  const confirmBtn = document.getElementById("btn-save-character-confirm");
  const nameInput = document.getElementById("char-modal-name-input");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  const voiceSelect = document.getElementById("char-modal-voice-select");
  const linkedInfo = document.getElementById("char-modal-linked-info");

  if (titleEl) titleEl.textContent = "Save Character Voice";
  if (confirmBtn) confirmBtn.innerHTML = `💾 Save Character`;

  const existingCount = (state.savedCharacters?.length || 0) + 1;
  if (nameInput) {
    nameInput.value = `Character ${existingCount}`;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  if (voiceSelect && activeBlock.voice_id) {
    voiceSelect.value = activeBlock.voice_id;
  }
  updateCharModalVoiceDetails(activeBlock.voice_id);

  // Sliders
  const speed = activeBlock.speed !== undefined ? Number(activeBlock.speed) : 0.90;
  const pause = activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : 0.6;
  const pitch = Number(activeBlock.pitch_shift || 0.0);
  const warmth = Number(activeBlock.warmth || 0.0);
  const clarity = Number(activeBlock.clarity || 0.0);
  const reverb = Number(activeBlock.reverb || 0.0);
  const filter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();

  setCharModalSlider("char-slider-speed", "char-val-speed", speed, v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", pause, v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", pitch, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", warmth, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", clarity, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(reverb * 100), v => `${v}%`);
  selectCharModalFilter(filter);

  const voiceObj = getVoiceById(activeBlock.voice_id);
  renderCharModalPalette(voiceObj.color || "#6366f1");

  if (avatarPreview) {
    avatarPreview.textContent = `C${existingCount}`;
  }

  if (linkedInfo) {
    linkedInfo.style.display = "none";
  }

  if (modal) modal.classList.add("active");
}

function closeSaveCharacterModal() {
  const modal = document.getElementById("save-character-modal");
  if (modal) modal.classList.remove("active");
}

function confirmSaveCharacter() {
  const nameInput = document.getElementById("char-modal-name-input");
  const charName = (nameInput?.value || "").trim();
  if (!charName) {
    alert("Please enter a character name (e.g. 'Sarah', 'Detective Cole').");
    return;
  }

  const voiceSelect = document.getElementById("char-modal-voice-select");
  const voiceId = voiceSelect?.value || "blend_fenrir_onyx";
  const speed = parseFloat(document.getElementById("char-slider-speed")?.value || 0.90);
  const pause = parseFloat(document.getElementById("char-slider-pause")?.value || 0.6);
  const pitch = parseFloat(document.getElementById("char-slider-pitch")?.value || 0.0);
  const warmth = parseFloat(document.getElementById("char-slider-warmth")?.value || 0.0);
  const clarity = parseFloat(document.getElementById("char-slider-clarity")?.value || 0.0);
  const reverb = parseInt(document.getElementById("char-slider-reverb")?.value || 0, 10) / 100.0;
  const filter = state.charModalFxFilter || "none";
  const color = state.selectedCharacterColor || "#6366f1";
  const badge = charName.slice(0, 2).toUpperCase();

  if (state.editingCharacterId) {
    // Edit existing character
    const char = getCharacterById(state.editingCharacterId);
    if (!char) return;

    recordHistory(`Edit Character: ${charName}`);

    char.name = charName;
    char.voice_id = voiceId;
    char.speed = speed;
    char.pause_after = pause;
    char.pitch_shift = pitch;
    char.warmth = warmth;
    char.clarity = clarity;
    char.reverb = reverb;
    char.fx_filter = filter;
    char.radio_fx = (filter === "radio");
    char.color = color;
    char.badge = badge;

    const voiceObj = getVoiceById(voiceId);
    if (voiceObj.blend_weights) {
      char.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    } else {
      delete char.blend_weights;
    }

    saveSavedCharactersToStorage();
    const syncRes = syncCharacterToBlocks(char.id);
    closeSaveCharacterModal();
    renderSavedCharactersList();
    renderStudio();

    let msg = `✓ Updated character "${char.name}"`;
    if (syncRes.updatedCount > 0) {
      msg += ` & synced ${syncRes.updatedCount} sentence${syncRes.updatedCount > 1 ? 's' : ''}`;
    }
    if (syncRes.skippedCustomCount > 0) {
      msg += ` (${syncRes.skippedCustomCount} custom-edited preserved)`;
    }
    showToast(msg + "!");
  } else {
    // Create new character
    const newChar = {
      id: "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
      name: charName,
      voice_id: voiceId,
      speed: speed,
      gain: 1.0,
      pause_after: pause,
      pitch_shift: pitch,
      warmth: warmth,
      clarity: clarity,
      reverb: reverb,
      fx_filter: filter,
      radio_fx: (filter === "radio"),
      color: color,
      badge: badge
    };

    const voiceObj = getVoiceById(voiceId);
    if (voiceObj.blend_weights) {
      newChar.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    }

    if (!state.savedCharacters) state.savedCharacters = [];
    state.savedCharacters.push(newChar);
    saveSavedCharactersToStorage();

    // Assign this character to active sentence if unassigned
    const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
      ? state.activeBlockIndex
      : 0;
    const activeBlock = state.currentProject.blocks[activeIdx];
    if (activeBlock && !activeBlock.character_id && activeBlock.type !== "heading") {
      activeBlock.character_id = newChar.id;
      activeBlock.is_custom_edited = false;
      renderStudio();
    }

    closeSaveCharacterModal();
    renderSavedCharactersList();
    showToast(`🎭 Saved Character "${newChar.name}"!`);
  }
}

function syncCharacterToBlocks(charId) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return { updatedCount: 0, skippedCustomCount: 0 };

  let updatedCount = 0;
  let skippedCustomCount = 0;

  state.currentProject.blocks.forEach((b, idx) => {
    if (b.character_id === charId) {
      if (b.is_custom_edited === true) {
        skippedCustomCount++;
        return; // PRESERVE CUSTOM EDITED SENTENCES!
      }

      b.voice_id = char.voice_id;
      if (char.blend_weights) {
        b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
      } else {
        delete b.blend_weights;
      }
      b.speed = char.speed;
      b.pause_after = char.pause_after;
      b.pitch_shift = char.pitch_shift;
      b.warmth = char.warmth;
      b.clarity = char.clarity;
      b.reverb = char.reverb;
      b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
      b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

      delete b.cachedAudioUrl;
      delete b.cachedSig;
      delete b.duration;

      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready", "playing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        const avatar = row.querySelector(".block-avatar");
        if (avatar) {
          avatar.style.backgroundColor = char.color || getVoiceById(char.voice_id).color;
          avatar.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
        }
      }
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    renderStudio();
    debouncedSave();
  }
  return { updatedCount, skippedCustomCount };
}

function applyCharacterToSelected(charId) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return;

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [state.activeBlockIndex || 0];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length === 0) {
    showToast("ℹ️ Selected items contain no spoken sentences.");
    return;
  }

  recordHistory(`Apply Character: ${char.name}`);

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    b.character_id = char.id;
    b.is_custom_edited = false;
    b.voice_id = char.voice_id;
    if (char.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
    } else {
      delete b.blend_weights;
    }

    b.speed = char.speed;
    b.gain = char.gain !== undefined ? char.gain : 1.0;
    b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
    b.pitch_shift = char.pitch_shift;
    b.warmth = char.warmth;
    b.clarity = char.clarity;
    b.reverb = char.reverb;
    b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
    b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready", "playing");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      const avatar = row.querySelector(".block-avatar");
      if (avatar) {
        avatar.style.backgroundColor = char.color || getVoiceById(char.voice_id).color;
        avatar.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
      }
    }
  });

  renderStudio();
  debouncedSave();
  showToast(`🎭 Assigned Character "${char.name}" to ${spokenTargets.length} sentence${spokenTargets.length > 1 ? 's' : ''}!`);
}

function updateCharacterWithCurrent(charId) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  char.voice_id = activeBlock.voice_id || char.voice_id;
  if (activeBlock.blend_weights) {
    char.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
  } else {
    delete char.blend_weights;
  }
  char.speed = activeBlock.speed !== undefined ? Number(activeBlock.speed) : char.speed;
  char.gain = activeBlock.gain !== undefined ? Number(activeBlock.gain) : char.gain;
  char.pause_after = activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : char.pause_after;
  char.pitch_shift = Number(activeBlock.pitch_shift || 0.0);
  char.warmth = Number(activeBlock.warmth || 0.0);
  char.clarity = Number(activeBlock.clarity || 0.0);
  char.reverb = Number(activeBlock.reverb || 0.0);
  char.fx_filter = activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none");
  char.radio_fx = Boolean(activeBlock.radio_fx || activeBlock.fx_filter === "radio");

  saveSavedCharactersToStorage();
  const syncRes = syncCharacterToBlocks(char.id);
  renderSavedCharactersList();
  renderStudio();

  let msg = `✓ Updated character "${char.name}"`;
  if (syncRes.updatedCount > 0) {
    msg += ` & synced to ${syncRes.updatedCount} sentence${syncRes.updatedCount > 1 ? 's' : ''}`;
  }
  if (syncRes.skippedCustomCount > 0) {
    msg += ` (${syncRes.skippedCustomCount} custom-edited preserved)`;
  }
  showToast(msg + "!");
}

function revertActiveBlockToCharacter() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const b = state.currentProject.blocks[activeIdx];
  if (!b || !b.character_id) return;

  const char = getCharacterById(b.character_id);
  if (!char) return;

  recordHistory(`Revert to Character: ${char.name}`);

  b.voice_id = char.voice_id;
  if (char.blend_weights) {
    b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
  } else {
    delete b.blend_weights;
  }
  b.speed = char.speed;
  b.gain = char.gain !== undefined ? char.gain : 1.0;
  b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
  b.pitch_shift = Number(char.pitch_shift || 0.0);
  b.warmth = Number(char.warmth || 0.0);
  b.clarity = Number(char.clarity || 0.0);
  b.reverb = Number(char.reverb || 0.0);
  b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
  b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");
  b.is_custom_edited = false;

  delete b.cachedAudioUrl;
  delete b.cachedSig;
  delete b.duration;

  renderStudio();
  debouncedSave();
  showToast(`↺ Reverted sentence to "${char.name}" character settings!`);
}

function updateActiveCharacterStatusBanner() {
  const banner = document.getElementById("inspector-character-link-banner");
  if (!banner) return;

  if (!state.currentProject || !state.currentProject.blocks) {
    banner.style.display = "none";
    return;
  }

  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const block = state.currentProject.blocks[activeIdx];
  if (!block || block.type === "heading" || block.is_spoken === false || !block.character_id) {
    banner.style.display = "none";
    return;
  }

  const char = getCharacterById(block.character_id);
  if (!char) {
    banner.style.display = "none";
    return;
  }

  banner.className = "character-status-banner";
  banner.style.display = "flex";

  if (block.is_custom_edited) {
    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-main);">
        <span style="font-size: 14px;">🎭</span>
        <span>Character: <strong>${escapeHtml(char.name)}</strong></span>
        <span style="color: #f59e0b; font-weight: 600; font-size: 11px; background: rgba(245, 158, 11, 0.15); border-radius: 4px; padding: 1px 5px;">Customized</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn btn-secondary" onclick="revertActiveBlockToCharacter()" style="padding: 3px 8px; font-size: 11px; white-space: nowrap;" title="Revert sentence to original character settings">↺ Revert</button>
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-main);">
        <span style="font-size: 14px;">🎭</span>
        <span>Character: <strong>${escapeHtml(char.name)}</strong></span>
        <span style="color: #10b981; font-weight: 600; font-size: 11px; background: rgba(16, 185, 129, 0.15); border-radius: 4px; padding: 1px 5px;">Synced</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn btn-secondary" onclick="openEditCharacterModal('${char.id}')" style="padding: 3px 8px; font-size: 11px;" title="Edit this character's voice & settings">✏️ Edit</button>
      </div>
    `;
  }
}

function renameCharacter(charId) {
  const char = getCharacterById(charId);
  if (!char) return;
  const newName = prompt(`Enter new name for character "${char.name}":`, char.name);
  if (newName && newName.trim() && newName.trim() !== char.name) {
    char.name = newName.trim();
    char.badge = char.name.slice(0, 2).toUpperCase();
    saveSavedCharactersToStorage();
    renderSavedCharactersList();
    renderStudio();
    showToast(`✓ Renamed to "${char.name}"`);
  }
}

function deleteCharacter(charId) {
  const char = getCharacterById(charId);
  if (!char) return;
  if (confirm(`Delete character "${char.name}"?`)) {
    state.savedCharacters = state.savedCharacters.filter(c => c.id !== charId);
    saveSavedCharactersToStorage();
    renderSavedCharactersList();
    renderStudio();
    showToast(`🗑️ Deleted character "${char.name}".`);
  }
}

function getProjectDefaultSettings() {
  let savedLocal = null;
  try {
    const raw = localStorage.getItem("kss_default_sentence_settings");
    if (raw) savedLocal = JSON.parse(raw);
  } catch (e) {}

  const p = state.currentProject || {};
  const projDefs = p.default_settings || {};

  return {
    voice_id: projDefs.voice_id || p.default_voice || savedLocal?.voice_id || "blend_fenrir_onyx",
    speed: projDefs.speed !== undefined ? Number(projDefs.speed) : (p.default_speed !== undefined ? Number(p.default_speed) : (savedLocal?.speed !== undefined ? Number(savedLocal.speed) : 0.90)),
    gain: projDefs.gain !== undefined ? Number(projDefs.gain) : (p.default_gain !== undefined ? Number(p.default_gain) : (savedLocal?.gain !== undefined ? Number(savedLocal.gain) : 1.0)),
    pause_after: projDefs.pause_after !== undefined ? Number(projDefs.pause_after) : (p.default_pause !== undefined ? Number(p.default_pause) : (savedLocal?.pause_after !== undefined ? Number(savedLocal.pause_after) : 0.6)),
    pitch_shift: projDefs.pitch_shift !== undefined ? Number(projDefs.pitch_shift) : (p.default_pitch !== undefined ? Number(p.default_pitch) : (savedLocal?.pitch_shift !== undefined ? Number(savedLocal.pitch_shift) : 0.0)),
    warmth: projDefs.warmth !== undefined ? Number(projDefs.warmth) : (p.default_warmth !== undefined ? Number(p.default_warmth) : (savedLocal?.warmth !== undefined ? Number(savedLocal.warmth) : 0.0)),
    clarity: projDefs.clarity !== undefined ? Number(projDefs.clarity) : (p.default_clarity !== undefined ? Number(p.default_clarity) : (savedLocal?.clarity !== undefined ? Number(savedLocal.clarity) : 0.0)),
    reverb: projDefs.reverb !== undefined ? Number(projDefs.reverb) : (p.default_reverb !== undefined ? Number(p.default_reverb) : (savedLocal?.reverb !== undefined ? Number(savedLocal.reverb) : 0.0)),
    fx_filter: (projDefs.fx_filter || p.default_filter || savedLocal?.fx_filter || "none").toLowerCase(),
    radio_fx: projDefs.radio_fx !== undefined ? Boolean(projDefs.radio_fx) : (savedLocal?.radio_fx !== undefined ? Boolean(savedLocal.radio_fx) : false),
    blend_weights: projDefs.blend_weights || savedLocal?.blend_weights || undefined
  };
}

function handleSetCurrentAsDefault() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const currentFilter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();
  const currentDefaults = {
    speed: activeBlock.speed !== undefined ? Number(activeBlock.speed) : 0.90,
    gain: activeBlock.gain !== undefined ? Number(activeBlock.gain) : 1.0,
    pause_after: activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : 0.6,
    pitch_shift: Number(activeBlock.pitch_shift || 0.0),
    warmth: Number(activeBlock.warmth || 0.0),
    clarity: Number(activeBlock.clarity || 0.0),
    reverb: Number(activeBlock.reverb || 0.0),
    radio_fx: (currentFilter === "radio"),
    fx_filter: currentFilter,
    voice_id: activeBlock.voice_id || state.currentProject.default_voice || "blend_fenrir_onyx",
    blend_weights: activeBlock.blend_weights ? JSON.parse(JSON.stringify(activeBlock.blend_weights)) : undefined
  };

  // 1. Store on state.currentProject
  state.currentProject.default_settings = currentDefaults;
  state.currentProject.default_voice = currentDefaults.voice_id;
  state.currentProject.default_speed = currentDefaults.speed;
  state.currentProject.default_gain = currentDefaults.gain;
  state.currentProject.default_pause = currentDefaults.pause_after;
  state.currentProject.default_pitch = currentDefaults.pitch_shift;
  state.currentProject.default_warmth = currentDefaults.warmth;
  state.currentProject.default_clarity = currentDefaults.clarity;
  state.currentProject.default_reverb = currentDefaults.reverb;
  state.currentProject.default_filter = currentDefaults.fx_filter;

  // 2. Persist in localStorage across projects
  try {
    localStorage.setItem("kss_default_sentence_settings", JSON.stringify(currentDefaults));
  } catch (e) {
    console.warn("Could not save defaults to localStorage:", e);
  }

  // 3. Save to server
  debouncedSave();

  // 4. Temporary button feedback
  const btn1 = document.getElementById("btn-set-default-settings");
  const btn2 = document.getElementById("btn-set-default-settings-bulk");
  [btn1, btn2].forEach(btn => {
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = `✓ Defaults Saved!`;
      btn.style.borderColor = "var(--primary)";
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.style.borderColor = "";
      }, 1800);
    }
  });

  // 5. Toast notification
  const voiceObj = getVoiceById(currentDefaults.voice_id);
  const filterLabel = currentDefaults.fx_filter === "none" ? "Clean Studio" : currentDefaults.fx_filter.toUpperCase();
  showToast(`⭐ Defaults saved! New sentences will use: ${currentDefaults.speed.toFixed(2)}x speed, ${Math.round(currentDefaults.gain * 100)}% vol, ${currentDefaults.pause_after.toFixed(1)}s pause, voice: "${voiceObj.name}", filter: ${filterLabel}.`);
}

function handleSelectAudioFilter(filterName) {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const curFilter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();
  // Toggle off if clicking the already active filter (unless selecting 'none')
  const targetFilter = (curFilter === filterName && filterName !== "none") ? "none" : filterName;

  recordHistory(`Acoustic Filter: ${targetFilter === "none" ? "Clean Studio" : targetFilter.toUpperCase()}`);

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([activeIdx]);

  targets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.fx_filter = targetFilter;
    b.radio_fx = (targetFilter === "radio");
    if (b.character_id) {
      b.is_custom_edited = true;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
    }
  });

  renderInspector();
  renderTimeline();
  debouncedSave();
  updateActiveCharacterStatusBanner();

  const labels = {
    "none": "Clean Studio",
    "radio": "Radio Transceiver Filter",
    "whisper": "Soft Whisper Filter",
    "scream": "Intense Scream Filter",
    "demon": "Deep Demon Filter",
    "youth": "Child / Youth Filter"
  };
  showToast(`✨ Acoustic Filter: ${labels[targetFilter] || targetFilter} (${targets.size} sentence${targets.size > 1 ? "s" : ""})`);
}

function handleToggleRadioFx() {
  handleSelectAudioFilter("radio");
}

async function handleAutoDirectStory() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ No sentences to direct.");
    return;
  }

  const btn = document.getElementById("btn-auto-direct");
  if (btn) {
    btn.textContent = "⏳ Directing...";
    btn.disabled = true;
  }

  showToast("🎭 Auto-analyzing story dialogues, character attribution, whispers, and tension...");

  try {
    const res = await fetch("/api/auto_direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        default_voice: state.currentProject.default_voice || "blend_fenrir_onyx",
        expand_dialogue: true,
        defaults: getProjectDefaultSettings()
      })
    });

    const directedBlocks = await res.json();
    if (!Array.isArray(directedBlocks) || directedBlocks.length === 0) {
      showToast("⚠️ No changes made to story blocks.");
      return;
    }

    recordHistory("Auto-Direct Story");

    let modifiedCount = 0;
    const oldBlocks = state.currentProject.blocks;

    // Check how many blocks changed in voice, speed, gain, or pause
    directedBlocks.forEach((b, idx) => {
      const oldB = oldBlocks[idx];
      if (!oldB || oldB.voice_id !== b.voice_id || oldB.speed !== b.speed || oldB.gain !== b.gain || oldB.pause_after !== b.pause_after) {
        modifiedCount++;
        delete b.cachedAudioUrl;
        delete b.cachedSig;
      }
    });

    state.currentProject.blocks = directedBlocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;

    renderStudio();
    debouncedSave();
    showToast(`🎭 Auto-directed! Cast character roles, whispers & tension across ${directedBlocks.length} sentences (${modifiedCount} updated).`);
  } catch (err) {
    console.error("Auto-direct error:", err);
    showToast("❌ Auto-direct error: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = "🎭 Auto-Direct Story";
      btn.disabled = false;
    }
  }
}

function applyDeliveryPreset(presetKey) {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex >= 0 ? state.activeBlockIndex : 0]);

  const defVoice = state.currentProject.default_voice || "blend_fenrir_onyx";

  let presetConfig = {
    name: "Narrator",
    voice_id: null,
    speed: 0.90,
    gain: 1.0,
    pause_after: 0.6,
    pitch_shift: 0.0,
    warmth: 0.0,
    clarity: 0.0,
    reverb: 0.0,
    radio_fx: false,
    clearBlend: false
  };

  switch (presetKey) {
    case "narrator": {
      const defs = getProjectDefaultSettings();
      presetConfig = {
        name: "Narrator",
        voice_id: defs.voice_id,
        speed: defs.speed,
        gain: defs.gain,
        pause_after: defs.pause_after,
        pitch_shift: defs.pitch_shift,
        warmth: defs.warmth,
        clarity: defs.clarity,
        reverb: defs.reverb,
        radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
        fx_filter: defs.fx_filter,
        clearBlend: false
      };
      break;
    }
    case "whisper":
      presetConfig = {
        name: "Soft Whisper",
        voice_id: null,
        speed: 0.82,
        gain: 0.75,
        pause_after: 0.9,
        pitch_shift: -0.5,
        warmth: 0.0,
        clarity: 3.0,
        reverb: 0.15,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "intense":
      presetConfig = {
        name: "Intense Scream",
        voice_id: null,
        speed: 1.06,
        gain: 1.20,
        pause_after: 0.8,
        pitch_shift: 2.0,
        warmth: 1.5,
        clarity: 1.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "demon":
      presetConfig = {
        name: "Deep Demon",
        voice_id: null,
        speed: 0.84,
        gain: 1.10,
        pause_after: 0.9,
        pitch_shift: -3.5,
        warmth: 4.5,
        clarity: -1.0,
        reverb: 0.22,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "youth":
      presetConfig = {
        name: "High Pitch / Youth",
        voice_id: null,
        speed: 0.98,
        gain: 0.95,
        pause_after: 0.6,
        pitch_shift: 3.5,
        warmth: -1.5,
        clarity: 2.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "radio":
      presetConfig = {
        name: "Radio Transceiver",
        voice_id: null,
        speed: 0.92,
        gain: 1.0,
        pause_after: 0.7,
        pitch_shift: 0.0,
        warmth: 0.0,
        clarity: 1.5,
        reverb: 0.0,
        radio_fx: true,
        clearBlend: false
      };
      break;
    case "female":
      presetConfig = {
        name: "Female Dialogue",
        voice_id: "af_heart",
        speed: 0.86,
        gain: 1.0,
        pause_after: 0.8,
        pitch_shift: 0.0,
        warmth: 0.0,
        clarity: 0.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: true
      };
      break;
    case "male":
      presetConfig = {
        name: "Male Dialogue",
        voice_id: "am_michael",
        speed: 0.88,
        gain: 1.0,
        pause_after: 0.8,
        pitch_shift: 0.0,
        warmth: 0.5,
        clarity: 0.0,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: true
      };
      break;
  }

  recordHistory(`Delivery Preset: ${presetConfig.name}`);

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.voice_id = presetConfig.voice_id;
    block.speed = presetConfig.speed;
    block.gain = presetConfig.gain;
    block.pause_after = presetConfig.pause_after;
    block.pitch_shift = presetConfig.pitch_shift;
    block.warmth = presetConfig.warmth;
    block.clarity = presetConfig.clarity;
    block.reverb = presetConfig.reverb;
    block.radio_fx = presetConfig.radio_fx;
    if (presetConfig.clearBlend) {
      delete block.blend_weights;
    }
    delete block.cachedAudioUrl;
    delete block.cachedSig;
  });

  renderStudio();
  debouncedSave();
  showToast(`⚡ Set "${presetConfig.name}" on ${targets.size} sentence(s)!`);
}

async function handleBulkRender() {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) return;
  const selectedList = Array.from(state.selectedBlockIndices)
    .filter(idx => {
      const b = state.currentProject.blocks[idx];
      return b && b.type !== "heading" && b.is_spoken !== false;
    })
    .sort((a, b) => a - b);
  if (selectedList.length === 0) {
    showToast("ℹ️ Selected items contain no spoken sentences to render.");
    return;
  }

  const btnBulkRender = document.getElementById("btn-bulk-render");
  const isGPU = Boolean(state.config.active && state.config.remote_worker_url);
  const concurrencySelect = document.getElementById("batch-concurrency-select");
  let concurrency = concurrencySelect ? parseInt(concurrencySelect.value, 10) : 1;
  if (!concurrency || concurrency < 1) concurrency = isGPU ? 3 : 1;
  if (!isGPU && concurrency > 2) concurrency = 1;

  if (btnBulkRender) {
    btnBulkRender.disabled = true;
    btnBulkRender.textContent = `⏳ Rendering (0/${selectedList.length})...`;
  }

  const startTime = Date.now();
  let completed = 0;
  let taskIndex = 0;

  function updateBulkBtn() {
    if (!btnBulkRender) return;
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
    if (completed > 0) {
      const rate = completed / elapsedSec;
      const remaining = selectedList.length - completed;
      const etaSec = Math.round(remaining / rate);
      btnBulkRender.textContent = `⏳ (${completed}/${selectedList.length}) • ETA ${formatBatchDuration(etaSec)}`;
    } else {
      btnBulkRender.textContent = `⏳ Rendering (0/${selectedList.length})...`;
    }
  }

  async function renderSingleSelected(idx) {
    const block = state.currentProject.blocks[idx];
    if (!block || block.type === "heading" || block.is_spoken === false) return;
    const row = document.querySelector(`[data-index="${idx}"]`);
    const currentSig = getBlockSignature(block);

    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
      if (row) row.classList.add("ready");
      return;
    }

    if (row) {
      row.classList.add("processing");
      row.classList.remove("ready");
    }

    try {
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: block.text,
          voice_id: block.voice_id,
          blend_weights: block.blend_weights,
          speed: block.speed || 0.90,
          gain: block.gain || 1.0,
          pitch_shift: block.pitch_shift || 0.0,
          warmth: block.warmth || 0.0,
          clarity: block.clarity || 0.0,
          reverb: block.reverb || 0.0,
          radio_fx: Boolean(block.radio_fx),
          fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
        })
      });

      const data = await res.json();
      if (data.audio_url) {
        block.cachedAudioUrl = data.audio_url;
        block.cachedSig = currentSig;
        if (data.duration) block.duration = data.duration;
        debouncedSave();
        if (row) {
          row.classList.remove("processing");
          row.classList.add("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText && data.duration) timeText.textContent = `● ${data.duration.toFixed(1)}s`;
        }
      }
    } catch (err) {
      console.error("Bulk render error on block", idx, err);
      if (row) row.classList.remove("processing");
    }
  }

  async function worker() {
    while (taskIndex < selectedList.length) {
      const current = taskIndex++;
      const blockIdx = selectedList[current];
      if (blockIdx === undefined) break;
      await renderSingleSelected(blockIdx);
      completed++;
      updateBulkBtn();
    }
  }

  const workers = [];
  const actualConcurrency = Math.min(concurrency, selectedList.length);
  for (let c = 0; c < actualConcurrency; c++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (btnBulkRender) {
    btnBulkRender.disabled = false;
    btnBulkRender.textContent = `✓ Selected Rendered!`;
    setTimeout(() => {
      updateSelectionUI();
    }, 2500);
  }
  renderTimeline();
  updateStoryTimeDisplay();
  const totalElapsed = formatBatchDuration((Date.now() - startTime) / 1000);
  showToast(`✓ Rendered ${selectedList.length} sentence(s) in ${totalElapsed}!`);
}

function updateActiveSentenceHint(idx) {
  const hintEl = document.getElementById("player-active-sentence-hint");
  if (!hintEl || !state.currentProject || !state.currentProject.blocks) return;
  const block = state.currentProject.blocks[idx];
  if (!block) return;
  const total = state.currentProject.blocks.length;
  if (block.type === "heading" || block.is_spoken === false) {
    hintEl.textContent = `🎬 Item ${idx + 1}/${total}: "${block.text || 'Scene Heading'}" (Non-spoken divider • ${(block.pause_after || 1.0).toFixed(1)}s pause)`;
  } else {
    hintEl.textContent = `Sentence ${idx + 1}/${total}: "${block.text.slice(0, 55)}${block.text.length > 55 ? '...' : ''}"`;
  }
}

function renderInspector() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  
  if (typeof state.activeBlockIndex !== "number" || state.activeBlockIndex < 0 || state.activeBlockIndex >= state.currentProject.blocks.length) {
    state.activeBlockIndex = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
      ? Array.from(state.selectedBlockIndices)[0]
      : 0;
  }
  const block = state.currentProject.blocks[state.activeBlockIndex];
  if (!block) return;
  const voice = getVoiceById(block.voice_id);

  // Update Character Status Banner
  updateActiveCharacterStatusBanner();

  const char = getCharacterById(block.character_id);
  const cardColor = (char && char.color) ? char.color : (voice.color || "#6366f1");
  const cardBadge = (char && char.badge) ? char.badge : (voice.badge || (voice.id ? voice.id.slice(0, 2).toUpperCase() : "VO"));

  // Inspector voice card
  const avatar = document.getElementById("inspector-voice-avatar");
  if (avatar) {
    avatar.style.backgroundColor = cardColor;
    avatar.textContent = cardBadge;
  }

  const nameEl = document.getElementById("inspector-voice-name");
  if (nameEl) nameEl.textContent = voice.name || "Voice";

  const subEl = document.getElementById("inspector-voice-sub");
  if (subEl) subEl.textContent = `${voice.gender || ''} • ${voice.accent || ''} • ${voice.timbre || ''}`;

  // Sliders
  const volSlider = document.getElementById("slider-volume");
  if (volSlider) {
    volSlider.value = Math.round((block.gain || 1.0) * 100);
    const valVol = document.getElementById("val-volume");
    if (valVol) valVol.textContent = volSlider.value + "%";
  }

  const speedSlider = document.getElementById("slider-speed");
  if (speedSlider) {
    speedSlider.value = (block.speed || 0.90).toFixed(2);
    const valSpeed = document.getElementById("val-speed");
    if (valSpeed) valSpeed.textContent = speedSlider.value + "x";
  }

  const pauseSlider = document.getElementById("slider-pause");
  if (pauseSlider) {
    pauseSlider.value = (block.pause_after || 0.6).toFixed(1);
    const valPause = document.getElementById("val-pause");
    if (valPause) valPause.textContent = pauseSlider.value + "s";
  }

  // DSP Controls
  const pitchSlider = document.getElementById("slider-pitch");
  if (pitchSlider) {
    const pVal = Number(block.pitch_shift || 0.0);
    pitchSlider.value = pVal.toFixed(1);
    const valPitch = document.getElementById("val-pitch");
    if (valPitch) valPitch.textContent = (pVal > 0 ? `+${pVal.toFixed(1)}` : pVal.toFixed(1)) + " st";
  }

  const warmthSlider = document.getElementById("slider-warmth");
  if (warmthSlider) {
    const wVal = Number(block.warmth || 0.0);
    warmthSlider.value = wVal.toFixed(1);
    const valWarmth = document.getElementById("val-warmth");
    if (valWarmth) valWarmth.textContent = (wVal > 0 ? `+${wVal.toFixed(1)}` : wVal.toFixed(1)) + " dB";
  }

  const claritySlider = document.getElementById("slider-clarity");
  if (claritySlider) {
    const cVal = Number(block.clarity || 0.0);
    claritySlider.value = cVal.toFixed(1);
    const valClarity = document.getElementById("val-clarity");
    if (valClarity) valClarity.textContent = (cVal > 0 ? `+${cVal.toFixed(1)}` : cVal.toFixed(1)) + " dB";
  }

  const reverbSlider = document.getElementById("slider-reverb");
  if (reverbSlider) {
    const rVal = Math.round(Number(block.reverb || 0.0) * 100);
    reverbSlider.value = rVal;
    const valReverb = document.getElementById("val-reverb");
    if (valReverb) valReverb.textContent = rVal + "%";
  }

  // Acoustic FX Filter State
  const curFilter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();
  const filterNames = {
    "none": "Clean Studio",
    "radio": "Radio Transceiver",
    "whisper": "Soft Whisper",
    "scream": "Intense Scream",
    "demon": "Deep Demon",
    "youth": "Child / Youth"
  };
  const activeLabel = document.getElementById("val-active-filter");
  if (activeLabel) activeLabel.textContent = filterNames[curFilter] || "Clean Studio";

  ["none", "radio", "whisper", "scream", "demon", "youth"].forEach(f => {
    const btn = document.getElementById(`btn-fx-${f}`);
    if (btn) btn.classList.toggle("active", curFilter === f);
  });
}

function renderTimeline() {
  const container = document.getElementById("timeline-blocks");
  if (!container) return;
  container.innerHTML = "";

  if (!state.currentProject || !state.currentProject.blocks) return;

  state.currentProject.blocks.forEach((block, idx) => {
    if (block.type === "heading" || block.is_spoken === false) {
      const item = document.createElement("div");
      const isActive = state.activeBlockIndex === idx;
      const isPlaying = state.currentlyPlayingBlockIdx === idx;
      item.className = `timeline-block-item heading-item ${isActive ? "active" : ""} ${isPlaying ? "playing" : ""}`;
      item.textContent = `🎬 ${block.text || "Scene"}`;
      item.title = `Scene Divider: ${block.text} (Non-spoken • ${block.pause_after || 1.0}s pause)`;
      item.addEventListener("click", () => {
        selectBlock(idx);
        const r = document.querySelectorAll(".scene-divider-row, .block-row")[idx];
        if (r) r.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      container.appendChild(item);
      return;
    }

    const voice = getVoiceById(block.voice_id);
    const char = getCharacterById(block.character_id);
    const itemColor = (char && char.color) ? char.color : voice.color;
    const charLabel = char ? `${char.name}${block.is_custom_edited ? ' (Custom)' : ''}` : voice.name;
    const item = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isReady = !!(block.cachedAudioUrl && block.cachedSig === currentSig);
    const isActive = state.activeBlockIndex === idx;
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const row = document.querySelectorAll(".block-row")[idx];
    const isProcessing = row ? row.classList.contains("processing") : false;

    item.className = `timeline-block-item ${isReady ? "ready" : "pending"} ${isProcessing ? "processing" : ""} ${isActive ? "active" : ""} ${isPlaying ? "playing" : ""}`;
    item.style.backgroundColor = itemColor;
    item.textContent = block.text.slice(0, 25) + (block.text.length > 25 ? "..." : "");
    item.title = `Sentence ${idx + 1} [${isReady ? 'Ready' : 'Draft'} • ${charLabel}]: ${block.text}`;

    item.addEventListener("click", () => {
      selectBlock(idx);
      const r = document.querySelectorAll(".block-row")[idx];
      if (r) r.scrollIntoView({ behavior: "smooth", block: "center" });
      state.isPlayingStory = true;
      playBlockAudio(idx, 0, false);
    });

    container.appendChild(item);
  });

  updateStoryTimeDisplay();
}

function updateStoryTimeDisplay() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;

  let totalSec = 0;
  blocks.forEach(b => {
    if (b.type === "heading" || b.is_spoken === false) {
      totalSec += (b.pause_after || 1.0);
      return;
    }
    if (b.duration) {
      totalSec += b.duration;
    } else {
      const wc = (b.text || "").trim().split(/\s+/).filter(Boolean).length || 5;
      const speed = b.speed || 0.90;
      totalSec += (wc / 2.8) / speed + (b.pause_after || 0.6);
    }
  });

  let elapsedSec = 0;
  if (state.currentlyPlayingBlockIdx !== null) {
    for (let i = 0; i < state.currentlyPlayingBlockIdx; i++) {
      const b = blocks[i];
      if (b.type === "heading" || b.is_spoken === false) {
        elapsedSec += (b.pause_after || 1.0);
      } else {
        elapsedSec += b.duration || ((b.text || "").trim().split(/\s+/).length / 2.8 / (b.speed || 0.9));
      }
    }
    elapsedSec += state.storyAudioPlayer.currentTime || 0;
  }

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const displayEl = document.getElementById("master-time-display");
  if (displayEl) {
    displayEl.textContent = `${fmt(elapsedSec)} / ${fmt(totalSec)}`;
  }
}

function highlightTimelineBlock(idx) {
  document.querySelectorAll(".timeline-block-item").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    el.classList.toggle("playing", i === idx && state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused);
  });
}

// ---------------- AUDIO GENERATION & FULL STORY PLAYBACK ---------------- //

function prefetchNextBlock(idx) {
  const nextIdx = idx + 1;
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks[nextIdx]) return;
  const nextBlock = state.currentProject.blocks[nextIdx];
  if (nextBlock.type === "heading" || nextBlock.is_spoken === false) return;
  if (!nextBlock.text || !nextBlock.text.trim()) return;
  const sig = getBlockSignature(nextBlock);
  if (nextBlock.cachedAudioUrl && nextBlock.cachedSig === sig) {
    // Preload audio into memory cache so it plays instantly with zero delay on transition!
    const preloader = new Audio();
    preloader.preload = "auto";
    preloader.src = nextBlock.cachedAudioUrl;
    return;
  }

  const nextRow = document.querySelector(`[data-index="${nextIdx}"]`);

  fetch("/api/synthesize_block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: nextBlock.text,
      voice_id: nextBlock.voice_id,
      blend_weights: nextBlock.blend_weights,
      speed: nextBlock.speed || 0.90,
      gain: nextBlock.gain || 1.0,
      pitch_shift: nextBlock.pitch_shift || 0.0,
      warmth: nextBlock.warmth || 0.0,
      clarity: nextBlock.clarity || 0.0,
      reverb: nextBlock.reverb || 0.0,
      radio_fx: Boolean(nextBlock.radio_fx),
      fx_filter: nextBlock.fx_filter || (nextBlock.radio_fx ? "radio" : "none")
    })
  })
    .then(r => r.json())
    .then(data => {
      if (data.audio_url) {
        nextBlock.cachedAudioUrl = data.audio_url;
        nextBlock.cachedSig = sig;
        nextBlock.duration = data.duration;
        debouncedSave();
        if (nextRow) nextRow.classList.add("ready");
      }
    })
    .catch(() => {});
}

function updatePlaybackUI(idx, isPlaying) {
  const masterBtn = document.getElementById("master-play-btn");
  if (masterBtn) {
    masterBtn.textContent = isPlaying ? "⏸" : "▶";
    masterBtn.classList.toggle("playing", isPlaying);
  }
  const allRows = document.querySelectorAll(".block-row, .scene-divider-row");
  allRows.forEach((r, i) => {
    const pb = r.querySelector(".play-block-btn");
    if (i === idx) {
      r.classList.toggle("playing", isPlaying);
      if (pb) pb.textContent = isPlaying ? "🔊" : "▶";
    } else {
      r.classList.remove("playing");
      if (pb && pb.textContent !== "⏳") pb.textContent = "▶";
    }
  });
  if (idx !== null && idx !== undefined) {
    highlightTimelineBlock(idx);
    updateActiveSentenceHint(idx);
  }
}

async function playBlockAudio(idx, targetOffset = 0, isAutoContinuation = false) {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }

  const block = state.currentProject?.blocks?.[idx];
  if (!block) {
    stopStoryPlayback();
    return;
  }

  // Non-spoken Scene Heading / Section Divider
  if (block.type === "heading" || block.is_spoken === false) {
    selectBlock(idx, "single");
    state.currentlyPlayingBlockIdx = idx;
    updatePlaybackUI(idx, true);

    if (state.isPlayingStory) {
      const pauseGap = Math.max((block.pause_after !== undefined ? block.pause_after : 1.0) * 1000, 300);
      state.nextSentenceTimer = setTimeout(() => {
        if (state.isPlayingStory) {
          if (idx + 1 < (state.currentProject?.blocks?.length || 0)) {
            playBlockAudio(idx + 1, 0, true);
          } else {
            stopStoryPlayback();
          }
        }
      }, pauseGap);
    } else {
      showToast(`🎬 Scene Divider: "${block.text || 'Section'}" (Non-spoken • ${(block.pause_after || 1.0).toFixed(1)}s pause)`);
      setTimeout(() => updatePlaybackUI(idx, false), 800);
    }
    return;
  }

  if (!block.text || !block.text.trim()) {
    if (state.isPlayingStory && idx + 1 < (state.currentProject?.blocks?.length || 0)) {
      playBlockAudio(idx + 1, 0, true);
    } else {
      stopStoryPlayback();
    }
    return;
  }

  // Stop any voice preview sample from the library
  if (!state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    document.querySelectorAll(".preview-voice-btn").forEach(b => b.textContent = "▶ Sample");
  }

  // If already playing this exact block and targetOffset provided, seek smoothly
  if (state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused && targetOffset > 0) {
    if (state.storyAudioPlayer.duration) {
      state.storyAudioPlayer.currentTime = targetOffset;
      return;
    }
  }

  selectBlock(idx, "single");
  state.currentlyPlayingBlockIdx = idx;

  const row = document.querySelector(`[data-index="${idx}"]`);
  const btnEl = row ? row.querySelector(".play-block-btn") : null;
  const currentSig = getBlockSignature(block);

  const startPlayback = (audioUrl, duration) => {
    if (duration) block.duration = duration;

    // Check if the audio player is ALREADY loaded on this exact URL
    const currentSrcClean = (state.storyAudioPlayer.src || "").split("?")[0];
    const targetSrcClean = new URL(audioUrl, window.location.origin).href.split("?")[0];
    const isSameTrack = (currentSrcClean === targetSrcClean && Boolean(state.storyAudioPlayer.src));

    if (row) {
      row.classList.remove("processing");
    }

    if (!isSameTrack) {
      state.storyAudioPlayer.src = audioUrl;
    }

    if (targetOffset > 0) {
      state.storyAudioPlayer.currentTime = targetOffset;
    } else if (!isSameTrack || state.storyAudioPlayer.ended) {
      state.storyAudioPlayer.currentTime = 0;
    }

    state.isPlayingStory = true;
    state.storyAudioPlayer.play().then(() => {
      updatePlaybackUI(idx, true);
    }).catch(err => {
      console.warn("Audio play prevented:", err);
      updatePlaybackUI(idx, false);
    });

    prefetchNextBlock(idx);

    state.storyAudioPlayer.ontimeupdate = () => {
      if (state.currentlyPlayingBlockIdx !== idx) return;
      const cur = state.storyAudioPlayer.currentTime || 0;
      const dur = state.storyAudioPlayer.duration || block.duration || 1;
      const pct = Math.min((cur / dur) * 100, 100);

      const curRow = document.querySelector(`[data-index="${idx}"]`);
      if (curRow) {
        const fill = curRow.querySelector(".scrubber-fill");
        const timeText = curRow.querySelector(".scrubber-time");
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
        if (timeText) timeText.textContent = `${cur.toFixed(1)}s / ${dur.toFixed(1)}s`;
      }
      updateStoryTimeDisplay();
    };

    state.storyAudioPlayer.onended = () => {
      const curRow = document.querySelector(`[data-index="${idx}"]`);
      if (curRow) {
        curRow.classList.remove("playing");
        const fill = curRow.querySelector(".scrubber-fill");
        if (fill) fill.style.width = "0%";
        const timeText = curRow.querySelector(".scrubber-time");
        if (timeText && block.duration) timeText.textContent = `● ${block.duration.toFixed(1)}s`;
        const pb = curRow.querySelector(".play-block-btn");
        if (pb) pb.textContent = "▶";
      }

      if (state.isPlayingStory) {
        if (idx + 1 < state.currentProject.blocks.length) {
          const pauseGap = Math.max((block.pause_after || 0.6) * 1000, 120);
          state.nextSentenceTimer = setTimeout(() => {
            if (state.isPlayingStory) {
              playBlockAudio(idx + 1, 0, true);
            }
          }, pauseGap);
        } else {
          stopStoryPlayback();
        }
      } else {
        stopStoryPlayback();
      }
    };
  };

  // Cached playback
  if (block.cachedAudioUrl && block.cachedSig === currentSig) {
    startPlayback(block.cachedAudioUrl, block.duration);
    return;
  }

  // Synthesize on demand
  if (btnEl) btnEl.textContent = "⏳";
  if (row) {
    row.classList.add("processing");
    row.classList.remove("ready", "playing");
  }

  try {
    const res = await fetch("/api/synthesize_block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: block.text,
        voice_id: block.voice_id,
        blend_weights: block.blend_weights,
        speed: block.speed || 0.90,
        gain: block.gain || 1.0,
        pitch_shift: block.pitch_shift || 0.0,
        warmth: block.warmth || 0.0,
        clarity: block.clarity || 0.0,
        reverb: block.reverb || 0.0,
        radio_fx: Boolean(block.radio_fx),
        fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
      })
    });

    const data = await res.json();
    if (data.audio_url) {
      block.cachedAudioUrl = data.audio_url;
      block.cachedSig = currentSig;
      block.duration = data.duration;
      debouncedSave();
      renderTimeline();
      startPlayback(data.audio_url, data.duration);
    }
  } catch (err) {
    if (row) row.classList.remove("processing");
    updatePlaybackUI(idx, false);
    alert("Audio generation error: " + err);
  }
}

function pauseStoryPlayback() {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }
  state.isPlayingStory = false;
  state.storyAudioPlayer.pause();
  updatePlaybackUI(state.currentlyPlayingBlockIdx, false);
}

function stopStoryPlayback() {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }
  state.isPlayingStory = false;
  state.storyAudioPlayer.pause();
  state.storyAudioPlayer.currentTime = 0;
  const curIdx = state.currentlyPlayingBlockIdx;
  state.currentlyPlayingBlockIdx = null;

  updatePlaybackUI(curIdx, false);
  document.querySelectorAll(".block-row.playing").forEach(r => r.classList.remove("playing"));
  document.querySelectorAll(".play-block-btn").forEach(b => b.textContent = "▶");
  document.querySelectorAll(".timeline-block-item.playing").forEach(t => t.classList.remove("playing"));
  document.querySelectorAll(".scrubber-fill").forEach(f => f.style.width = "0%");
  updateStoryTimeDisplay();
}

function handleMasterStop() {
  stopStoryPlayback();
}

function handleMasterPlayToggle() {
  // If actively playing audio -> Pause
  if (!state.storyAudioPlayer.paused && state.storyAudioPlayer.currentTime > 0) {
    pauseStoryPlayback();
    return;
  }

  const total = state.currentProject?.blocks?.length || 0;
  if (total === 0) return;

  // Determine target block index
  const targetIdx = (typeof state.currentlyPlayingBlockIdx === "number" && state.currentlyPlayingBlockIdx >= 0 && state.currentlyPlayingBlockIdx < total)
    ? state.currentlyPlayingBlockIdx
    : ((typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < total)
      ? state.activeBlockIndex
      : 0);

  // If paused mid-track on this target, resume from current position
  if (state.currentlyPlayingBlockIdx === targetIdx && state.storyAudioPlayer.src && !state.storyAudioPlayer.ended && state.storyAudioPlayer.currentTime > 0) {
    state.isPlayingStory = true;
    state.storyAudioPlayer.play().then(() => {
      updatePlaybackUI(targetIdx, true);
    }).catch(() => {
      playBlockAudio(targetIdx, 0, false);
    });
    return;
  }

  // Otherwise start block playback from beginning
  state.isPlayingStory = true;
  playBlockAudio(targetIdx, 0, false);
}

function handleMasterPrev() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  if (state.storyAudioPlayer.currentTime > 1.5) {
    state.storyAudioPlayer.currentTime = 0;
    return;
  }
  const cur = (typeof state.currentlyPlayingBlockIdx === "number")
    ? state.currentlyPlayingBlockIdx
    : (typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0);
  const prevIdx = Math.max(0, cur - 1);
  selectBlock(prevIdx, "single");
  state.isPlayingStory = true;
  playBlockAudio(prevIdx, 0, false);
}

function handleMasterNext() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const total = state.currentProject.blocks.length;
  const cur = (typeof state.currentlyPlayingBlockIdx === "number")
    ? state.currentlyPlayingBlockIdx
    : (typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0);
  const nextIdx = Math.min(total - 1, cur + 1);
  selectBlock(nextIdx, "single");
  state.isPlayingStory = true;
  playBlockAudio(nextIdx, 0, false);
}

// ---------------- PARALLEL GPU BATCH GENERATOR & LIVE ETA ---------------- //

function formatBatchDuration(totalSec) {
  if (isNaN(totalSec) || totalSec <= 0) return "00:00";
  const sec = Math.floor(totalSec % 60);
  const min = Math.floor((totalSec / 60) % 60);
  const hrs = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}h ${pad(min)}m ${pad(sec)}s`;
  }
  return `${pad(min)}:${pad(sec)}`;
}

let batchTimerInterval = null;

async function toggleBatchRender() {
  const batchBtn = document.getElementById("btn-batch-generate");
  const banner = document.getElementById("batch-progress-banner");
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) return;

  // STOPPING IF ALREADY RUNNING
  if (state.isBatchRunning) {
    state.isBatchRunning = false;
    clearInterval(batchTimerInterval);
    if (batchBtn) {
      batchBtn.classList.remove("stopping");
      const isOnline = Boolean(state.config.active && state.config.remote_worker_url);
      batchBtn.textContent = isOnline ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }
    if (banner) banner.style.display = "none";
    showToast("⏹ Batch rendering stopped.");
    return;
  }

  // STARTING BATCH RENDER
  state.isBatchRunning = true;
  const blocks = state.currentProject.blocks;
  const total = blocks.length;

  // Determine concurrency from dropdown or mode
  const concurrencySelect = document.getElementById("batch-concurrency-select");
  let concurrency = concurrencySelect ? parseInt(concurrencySelect.value, 10) : 1;
  const isGPU = Boolean(state.config.active && state.config.remote_worker_url);
  if (!concurrency || concurrency < 1) concurrency = isGPU ? 3 : 1;
  // If running local CPU, safety clamp concurrency to 2 max to prevent system freeze
  if (!isGPU && concurrency > 2) {
    concurrency = 1;
    if (concurrencySelect) concurrencySelect.value = "1";
  }

  // Filter tasks that actually need rendering (skip already cached)
  const tasksToRender = [];
  let alreadyCachedCount = 0;

  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    if (block.type === "heading" || block.is_spoken === false) {
      alreadyCachedCount++;
      continue;
    }
    const currentSig = getBlockSignature(block);
    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
      alreadyCachedCount++;
      const row = document.querySelector(`[data-index="${i}"]`);
      if (row) {
        row.classList.add("ready");
        row.classList.remove("processing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText && block.duration) timeText.textContent = `● ${block.duration.toFixed(1)}s`;
      }
    } else {
      tasksToRender.push(i);
    }
  }

  if (tasksToRender.length === 0) {
    state.isBatchRunning = false;
    showToast("✓ All sentences are already rendered!");
    if (batchBtn) batchBtn.textContent = "✓ All Rendered";
    setTimeout(() => {
      batchBtn.textContent = isGPU ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }, 2000);
    return;
  }

  // Setup UI HUD
  if (batchBtn) batchBtn.classList.add("stopping");
  if (banner) banner.style.display = "flex";

  const bannerTitle = document.getElementById("batch-banner-title");
  const concurrencyTag = document.getElementById("batch-banner-concurrency-tag");
  const countsEl = document.getElementById("batch-banner-counts");
  const elapsedEl = document.getElementById("batch-stat-elapsed");
  const etaEl = document.getElementById("batch-stat-eta");
  const speedEl = document.getElementById("batch-stat-speed");
  const progressFill = document.getElementById("batch-progress-bar-fill");

  if (bannerTitle) bannerTitle.textContent = `Batch Synthesizing ${total} Sentences`;
  if (concurrencyTag) {
    concurrencyTag.textContent = isGPU
      ? `🚀 ${concurrency}x Parallel GPU`
      : `⚡ ${concurrency}x Parallel CPU`;
  }

  // State trackers
  const startTime = Date.now();
  let newlyRenderedCount = 0;
  let taskIndex = 0;

  function updateHUD() {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
    const completedTotal = alreadyCachedCount + newlyRenderedCount;
    const pct = Math.min(100, (completedTotal / total) * 100).toFixed(1);

    if (elapsedEl) elapsedEl.textContent = formatBatchDuration(elapsedSec);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (countsEl) {
      countsEl.textContent = `${completedTotal} / ${total} completed (${pct}%) • ${tasksToRender.length - newlyRenderedCount} remaining`;
    }

    if (newlyRenderedCount >= 1) {
      const rate = newlyRenderedCount / elapsedSec; // sentences per second
      const remainingTasks = Math.max(0, tasksToRender.length - newlyRenderedCount);
      const etaSec = Math.round(remainingTasks / rate);
      const etaFormatted = formatBatchDuration(etaSec);

      if (etaEl) etaEl.textContent = `~${etaFormatted} left`;
      if (speedEl) speedEl.textContent = `${rate.toFixed(1)} sent/s (${(1 / rate).toFixed(2)}s/sent)`;
      if (batchBtn) batchBtn.textContent = `⏹ Stop (${completedTotal}/${total}) • ETA ${etaFormatted}`;
    } else {
      if (etaEl) etaEl.textContent = "Calculating...";
      if (speedEl) speedEl.textContent = "Warming up...";
      if (batchBtn) batchBtn.textContent = `⏹ Stop (${completedTotal}/${total})`;
    }
  }

  updateHUD();
  clearInterval(batchTimerInterval);
  batchTimerInterval = setInterval(() => {
    if (state.isBatchRunning) updateHUD();
  }, 1000);

  // Single sentence render function
  async function renderBlockByIndex(idx) {
    const block = blocks[idx];
    const row = document.querySelector(`[data-index="${idx}"]`);
    const playBtn = row ? row.querySelector(".play-block-btn") : null;
    const currentSig = getBlockSignature(block);

    if (row) {
      row.classList.add("processing");
      row.classList.remove("ready");
      if (playBtn) playBtn.textContent = "⏳";
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "⏳ Synthesizing...";
    }

    try {
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: block.text,
          voice_id: block.voice_id,
          blend_weights: block.blend_weights,
          speed: block.speed || 0.90,
          gain: block.gain || 1.0,
          pitch_shift: block.pitch_shift || 0.0,
          warmth: block.warmth || 0.0,
          clarity: block.clarity || 0.0,
          reverb: block.reverb || 0.0,
          radio_fx: Boolean(block.radio_fx),
          fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
        })
      });

      const data = await res.json();
      if (data.audio_url) {
        block.cachedAudioUrl = data.audio_url;
        block.cachedSig = currentSig;
        if (data.duration) block.duration = data.duration;
        debouncedSave();
        if (row) {
          row.classList.remove("processing");
          row.classList.add("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText && data.duration) timeText.textContent = `● ${data.duration.toFixed(1)}s`;
        }
        if (playBtn) playBtn.textContent = "▶";
      }
    } catch (err) {
      console.error(`Error rendering sentence ${idx}:`, err);
      if (row) {
        row.classList.remove("processing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to retry)";
      }
      if (playBtn) playBtn.textContent = "▶";
    }
  }

  // Concurrent worker loop
  async function runWorker(workerId) {
    while (taskIndex < tasksToRender.length && state.isBatchRunning) {
      const currentTaskIndex = taskIndex++;
      const blockIdx = tasksToRender[currentTaskIndex];
      if (blockIdx === undefined) break;

      await renderBlockByIndex(blockIdx);
      newlyRenderedCount++;
      updateHUD();
      renderTimeline();
      updateStoryTimeDisplay();
    }
  }

  // Launch parallel worker pool
  const activeWorkers = [];
  const actualConcurrency = Math.min(concurrency, tasksToRender.length);
  for (let c = 0; c < actualConcurrency; c++) {
    activeWorkers.push(runWorker(c + 1));
  }

  await Promise.all(activeWorkers);

  // Completion
  clearInterval(batchTimerInterval);
  const wasStopped = !state.isBatchRunning;
  state.isBatchRunning = false;

  if (batchBtn) {
    batchBtn.classList.remove("stopping");
    batchBtn.textContent = wasStopped ? "⏹ Stopped" : "✓ All Rendered!";
    setTimeout(() => {
      const isOnline = Boolean(state.config.active && state.config.remote_worker_url);
      batchBtn.textContent = isOnline ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }, 3000);
  }

  if (banner) {
    if (!wasStopped) {
      if (progressFill) progressFill.style.width = "100%";
      if (countsEl) countsEl.textContent = `✓ All ${total} sentences successfully synthesized and cached!`;
      if (etaEl) etaEl.textContent = "Done! (0s)";
      setTimeout(() => {
        banner.style.display = "none";
      }, 4000);
    } else {
      banner.style.display = "none";
    }
  }

  renderTimeline();
  updateStoryTimeDisplay();
  if (!wasStopped) {
    const totalDurationStr = formatBatchDuration((Date.now() - startTime) / 1000);
    showToast(`✓ All ${tasksToRender.length} sentences rendered in ${totalDurationStr}!`);
  }
}

// ---------------- VOICE DRAWER: SEARCH, FILTER & SORT ---------------- //

function openVoiceDrawer(targetBlockIdx = null) {
  state.targetBlockForVoice = targetBlockIdx !== null ? targetBlockIdx : state.activeBlockIndex;
  document.getElementById("voice-drawer").classList.add("active");
  renderVoiceList();
}

function closeVoiceDrawer() {
  document.getElementById("voice-drawer").classList.remove("active");
}

function renderVoiceList() {
  const container = document.getElementById("voice-list-body");
  container.innerHTML = "";

  const query = state.searchQuery.toLowerCase().trim();
  const filter = state.activeFilter;
  const sort = state.activeSort;

  // Characters tab in Voice Drawer
  if (filter === "characters") {
    const charList = (state.savedCharacters || []).filter(c => {
      if (!query) return true;
      const v = getVoiceById(c.voice_id);
      return c.name.toLowerCase().includes(query) || v.name.toLowerCase().includes(query);
    });

    if (charList.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-subtle); padding: 40px;">
          No saved characters match your search.<br>
          <span style="font-size: 12px; opacity: 0.8; margin-top: 8px; display: inline-block;">
            Click "＋ Save Current" in the inspector to save your custom character voices!
          </span>
        </div>
      `;
      return;
    }

    charList.forEach(char => {
      const v = getVoiceById(char.voice_id);
      const card = document.createElement("div");
      card.className = "voice-card";
      const speedStr = `${Number(char.speed || 0.90).toFixed(2)}x`;
      const pitchStr = char.pitch_shift ? ` • ${(char.pitch_shift > 0 ? '+' : '') + Number(char.pitch_shift).toFixed(1)}st` : "";
      const filterStr = (char.fx_filter && char.fx_filter !== "none") ? ` • ${char.fx_filter.toUpperCase()}` : "";

      card.innerHTML = `
        <div class="voice-card-left">
          <div class="voice-avatar-badge" style="background-color: ${char.color || v.color}">
            ${escapeHtml(char.badge || char.name.slice(0, 2).toUpperCase())}
          </div>
          <div class="voice-info">
            <div class="voice-name">🎭 ${escapeHtml(char.name)}</div>
            <div class="voice-sub">${escapeHtml(v.name)} • ${speedStr}${pitchStr}${filterStr}</div>
            <div class="voice-tags-row">
              <span class="voice-tag" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc;">Character Preset</span>
              ${char.fx_filter && char.fx_filter !== 'none' ? `<span class="voice-tag" style="background: rgba(234, 88, 12, 0.2); color: #fb923c;">${char.fx_filter.toUpperCase()}</span>` : ''}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-primary assign-voice-btn">Apply Character</button>
        </div>
      `;

      card.querySelector(".assign-voice-btn").addEventListener("click", () => {
        applyCharacterToSelected(char.id);
        closeVoiceDrawer();
      });

      container.appendChild(card);
    });
    return;
  }

  // 1. Filter
  let list = state.voices.filter(v => {
    const matchQuery = !query || 
      v.name.toLowerCase().includes(query) ||
      (v.timbre && v.timbre.toLowerCase().includes(query)) ||
      (v.accent && v.accent.toLowerCase().includes(query)) ||
      (v.genre && v.genre.some(g => g.toLowerCase().includes(query)));

    if (!matchQuery) return false;

    if (filter === "mystery") {
      return (v.genre && (v.genre.includes("Mystery") || v.genre.includes("Horror") || v.genre.includes("Thriller")));
    }
    if (filter === "blends") return v.is_blend === true;
    if (filter === "female") return v.gender === "Female";
    if (filter === "male") return v.gender === "Male";
    if (filter === "american") return v.accent === "American";
    if (filter === "british") return v.accent === "British";
    if (filter === "hindi") return v.accent === "Hindi";
    if (filter === "international") return !["American", "British"].includes(v.accent);

    return true;
  });

  // 2. Sort
  list.sort((a, b) => {
    if (sort === "name_asc") {
      return a.name.localeCompare(b.name);
    }
    if (sort === "deep_first") {
      const aDeep = a.timbre && (a.timbre.includes("Bass") || a.timbre.includes("Deep") || a.timbre.includes("Baritone"));
      const bDeep = b.timbre && (b.timbre.includes("Bass") || b.timbre.includes("Deep") || b.timbre.includes("Baritone"));
      return (bDeep ? 1 : 0) - (aDeep ? 1 : 0);
    }
    if (sort === "female_first") {
      return (b.gender === "Female" ? 1 : 0) - (a.gender === "Female" ? 1 : 0);
    }
    if (sort === "male_first") {
      return (b.gender === "Male" ? 1 : 0) - (a.gender === "Male" ? 1 : 0);
    }
    // Recommended mystery defaults
    const aRec = a.is_blend || (a.genre && a.genre.includes("Mystery"));
    const bRec = b.is_blend || (b.genre && b.genre.includes("Mystery"));
    return (bRec ? 1 : 0) - (aRec ? 1 : 0);
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-subtle); padding: 40px;">No voices match your search or filter.</div>`;
    return;
  }

  list.forEach(v => {
    const card = document.createElement("div");
    card.className = "voice-card";
    const sampleUrl = v.sample_url || `/api/audio/sample_${v.id}.wav`;

    card.innerHTML = `
      <div class="voice-card-left">
        <div class="voice-avatar-badge" style="background-color: ${v.color}">
          ${v.badge || v.id.slice(0, 2).toUpperCase()}
        </div>
        <div class="voice-info">
          <div class="voice-name">${v.flag || ""} ${v.name}</div>
          <div class="voice-sub">${v.timbre || `${v.gender} • ${v.accent}`}</div>
          <div class="voice-tags-row">
            ${(v.genre || []).map(g => `<span class="voice-tag">${g}</span>`).join("")}
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary preview-voice-btn" title="Instant sample playback">▶ Sample</button>
        <button class="btn btn-primary assign-voice-btn">Use</button>
      </div>
    `;

    // INSTANT SAMPLE PLAYBACK (0ms latency from pre-rendered sample files)
    const previewBtn = card.querySelector(".preview-voice-btn");
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreRenderedSample(sampleUrl, previewBtn);
    });

    // Use Voice
    card.querySelector(".assign-voice-btn").addEventListener("click", () => {
      assignVoiceToTarget(v);
    });

    container.appendChild(card);
  });
}

function playPreRenderedSample(sampleUrl, btnEl) {
  // If story is currently playing, pause it so samples don't conflict
  if (state.isPlayingStory || !state.storyAudioPlayer.paused) {
    pauseStoryPlayback();
  }

  if (state.playingVoiceSampleId === sampleUrl && !state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
    return;
  }

  // Stop any other voice sample that might be playing
  state.sampleAudioPlayer.pause();
  document.querySelectorAll(".preview-voice-btn").forEach(b => b.textContent = "▶ Sample");

  state.playingVoiceSampleId = sampleUrl;
  btnEl.textContent = "🔊 Playing";
  state.sampleAudioPlayer.src = sampleUrl;
  state.sampleAudioPlayer.play().catch(err => {
    console.warn("Audio play issue, attempting fallback", err);
  });

  state.sampleAudioPlayer.onended = () => {
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
  };
}

function assignVoiceToTarget(voice) {
  if (!state.currentProject || !state.currentProject.blocks) return;

  recordHistory(`Change Voice: ${voice.name}`);

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 1)
    ? Array.from(state.selectedBlockIndices)
    : [(state.targetBlockForVoice !== null ? state.targetBlockForVoice : state.activeBlockIndex)];

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.voice_id = voice.id;
    delete block.cachedAudioUrl;
    delete block.cachedSig;
    if (voice.blend_weights) {
      block.blend_weights = JSON.parse(JSON.stringify(voice.blend_weights));
    } else {
      delete block.blend_weights;
    }
    if (block.character_id) {
      block.is_custom_edited = true;
    }
  });

  renderStudio();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  closeVoiceDrawer();
  showToast(`✓ Applied voice "${voice.name}" to ${targets.length} sentence(s)!`);
}

// ---------------- PROJECT CREATION & FILE IMPORT MODAL ---------------- //

function cleanTitleFromFilename(filename) {
  if (!filename) return "New Story Project";
  let base = filename.replace(/\.[^/.]+$/, "");
  base = base.replace(/[_]/g, " ").trim();
  if (base.length > 0 && (base === base.toUpperCase() || base === base.toLowerCase())) {
    base = base.replace(/\b\w/g, l => l.toUpperCase());
  }
  return base || "New Story Project";
}

function openNewProjectModal() {
  const modal = document.getElementById("new-project-modal");
  if (!modal) return;
  modal.classList.add("active");
  populateVoiceSelects();
  const input = document.getElementById("new-project-title-input");
  if (input && !input.value.trim()) {
    input.value = "New Story Project";
    input.focus();
  }
}

function closeNewProjectModal() {
  const modal = document.getElementById("new-project-modal");
  if (modal) modal.classList.remove("active");
  clearNewProjectFile();
}

function clearNewProjectFile() {
  const fileInput = document.getElementById("new-project-file-input");
  if (fileInput) fileInput.value = "";
  const badge = document.getElementById("new-project-file-badge");
  if (badge) badge.style.display = "none";
}

function handleDashboardFileImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  processImportedFile(file, "dashboard");
  e.target.value = "";
}

function handleNewProjectFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  processImportedFile(file, "new_project_modal");
  e.target.value = "";
}

function handleImportModalFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    const textarea = document.getElementById("import-textarea");
    if (textarea) textarea.value = text;
    showToast(`✓ Loaded "${file.name}" (${(text.length / 1024).toFixed(1)} KB)`);
  };
  reader.readAsText(file, "UTF-8");
  e.target.value = "";
}

async function loadSampleIntoNewProject() {
  try {
    showToast("📚 Loading sample story...");
    const res = await fetch("/api/sample_story");
    if (!res.ok) throw new Error("Could not fetch sample story");
    const data = await res.json();

    const titleInput = document.getElementById("new-project-title-input");
    const textInput = document.getElementById("new-project-text-input");
    const badge = document.getElementById("new-project-file-badge");
    const nameSpan = document.getElementById("new-project-file-name");

    if (titleInput) titleInput.value = data.title || "The Endless Eclipse - Sample";
    if (textInput) textInput.value = data.text || "";
    if (badge && nameSpan) {
      nameSpan.textContent = "📚 THE ENDLESS ECLIPSE - Sample.txt";
      badge.style.display = "flex";
    }
    showToast("✓ Loaded sample story: The Endless Eclipse");
  } catch (err) {
    showToast("❌ Failed to load sample story: " + err.message);
  }
}

function processImportedFile(file, targetContext) {
  const reader = new FileReader();
  reader.onload = async (event) => {
    const content = event.target.result;
    const isJson = file.name.toLowerCase().endsWith(".json");

    if (isJson) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.blocks && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          showToast(`📥 Importing project JSON "${parsed.title || file.name}"...`);
          const title = parsed.title || cleanTitleFromFilename(file.name);
          const defaultVoice = parsed.default_voice || "blend_fenrir_onyx";
          const res = await fetch("/api/projects/new", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title,
              default_voice: defaultVoice,
              blocks: parsed.blocks
            })
          });
          const newProj = await res.json();
          if (newProj && newProj.id) {
            closeNewProjectModal();
            window.open(`/studio?project=${encodeURIComponent(newProj.id)}`, "_blank");
            loadProjectsList();
            showToast(`✓ Project "${title}" imported with ${parsed.blocks.length} sentences!`);
            return;
          }
        } else if (parsed.text) {
          applyTextToFileModal(parsed.title || cleanTitleFromFilename(file.name), parsed.text, file.name);
          return;
        }
      } catch (jsonErr) {
        console.warn("JSON parse error, falling back to raw text:", jsonErr);
      }
    }

    const inferredTitle = cleanTitleFromFilename(file.name);
    applyTextToFileModal(inferredTitle, content, file.name);
  };
  reader.readAsText(file, "UTF-8");
}

function applyTextToFileModal(title, text, fileName) {
  const titleInput = document.getElementById("new-project-title-input");
  const textInput = document.getElementById("new-project-text-input");
  const badge = document.getElementById("new-project-file-badge");
  const nameSpan = document.getElementById("new-project-file-name");

  if (titleInput) titleInput.value = title;
  if (textInput) textInput.value = text;
  if (badge && nameSpan) {
    nameSpan.textContent = `📄 ${fileName}`;
    badge.style.display = "flex";
  }

  const modal = document.getElementById("new-project-modal");
  if (modal && !modal.classList.contains("active")) {
    modal.classList.add("active");
    populateVoiceSelects();
  }
  showToast(`✓ Loaded "${fileName}" (${(text.length / 1024).toFixed(1)} KB)`);
}

async function handleCreateProjectSubmit() {
  const title = (document.getElementById("new-project-title-input")?.value || "").trim() || "Untitled Project";
  const text = (document.getElementById("new-project-text-input")?.value || "").trim();
  const defaultVoice = document.getElementById("new-project-voice-select")?.value || "blend_fenrir_onyx";

  const defs = getProjectDefaultSettings();
  try {
    const res = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, text, default_voice: defaultVoice, defaults: defs })
    });

    const newProj = await res.json();
    closeNewProjectModal();
    window.open(`/studio?project=${encodeURIComponent(newProj.id)}`, "_blank");
    loadProjectsList();
  } catch (err) {
    alert("Could not create project: " + err);
  }
}

// ---------------- IMPORT TEXT MODAL ---------------- //

function openImportModal() {
  const modal = document.getElementById("import-modal");
  if (!modal) return;
  modal.classList.add("active");
  populateVoiceSelects();
  const select = document.getElementById("import-voice-select");
  if (select && state.currentProject?.default_voice) {
    select.value = state.currentProject.default_voice;
  }
  const textarea = document.getElementById("import-textarea");
  if (textarea) {
    textarea.value = "";
    textarea.focus();
  }
}

function closeImportModal() {
  const modal = document.getElementById("import-modal");
  if (modal) modal.classList.remove("active");
}

async function handleDoImport() {
  const text = (document.getElementById("import-textarea")?.value || "").trim();
  if (!text) {
    showToast("⚠️ Paste some text to import first.");
    return;
  }
  const defaultVoice = document.getElementById("import-voice-select")?.value || state.currentProject?.default_voice || "blend_fenrir_onyx";
  const defs = getProjectDefaultSettings();
  try {
    const res = await fetch("/api/split_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, default_voice: defaultVoice, defaults: defs })
    });
    const blocks = await res.json();
    if (!state.currentProject) {
      state.currentProject = { id: "proj_default", title: "Story Project", blocks: [] };
    }
    state.currentProject.blocks = blocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;
    renderStudio();
    closeImportModal();
    debouncedSave();
    showToast(`✓ Imported and split into ${blocks.length} sentence blocks!`);
  } catch (err) {
    alert("Import error: " + err);
  }
}

// ---------------- CLOUD GPU / COLAB MODAL ---------------- //

function openColabModal() {
  const modal = document.getElementById("colab-modal");
  if (!modal) return;
  modal.classList.add("active");
  const testRes = document.getElementById("colab-test-result");
  if (testRes) testRes.innerHTML = "";
  if (state.config && state.config.remote_worker_url) {
    const urlInput = document.getElementById("colab-url-input");
    if (urlInput) urlInput.value = state.config.remote_worker_url;
  }
}

function closeColabModal() {
  const modal = document.getElementById("colab-modal");
  if (modal) modal.classList.remove("active");
}

async function handleTestColab() {
  const urlInput = document.getElementById("colab-url-input");
  const testRes = document.getElementById("colab-test-result");
  const btn = document.getElementById("btn-test-colab");
  const url = (urlInput?.value || "").trim();

  if (!url) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">⚠️ Please paste your Colab tunnel URL first.</span>`;
    return;
  }

  if (btn) {
    btn.textContent = "⏳ Testing...";
    btn.disabled = true;
  }
  if (testRes) testRes.innerHTML = `<span style="color: var(--text-muted);">Pinging ${url}/health...</span>`;

  try {
    const res = await fetch("/api/test_remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.ok) {
      const hw = data.details?.hardware || "Cloud GPU";
      if (testRes) testRes.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ Connected! Hardware: ${hw} — Ready for instant synthesis!</span>`;
    } else {
      if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${data.error || "Could not reach remote worker"}</span>`;
    }
  } catch (err) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${err.message}</span>`;
  } finally {
    if (btn) {
      btn.textContent = "⚡ Test Connection";
      btn.disabled = false;
    }
  }
}

async function handleSaveColab() {
  const urlInput = document.getElementById("colab-url-input");
  const url = (urlInput?.value || "").trim();

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remote_worker_url: url })
    });
    const data = await res.json();
    state.config = data;
    updateEngineUI(data.remote_worker_url, data.active);
    closeColabModal();
    if (data.active) {
      showToast(`🚀 Connected to Cloud GPU: ${data.remote_worker_url}`);
    } else {
      showToast("⚡ Switched to Local CPU Engine");
    }
  } catch (err) {
    alert("Failed to save configuration: " + err);
  }
}

async function handleClearColab() {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remote_worker_url: "" })
    });
    const data = await res.json();
    state.config = data;
    updateEngineUI("", false);
    const urlInput = document.getElementById("colab-url-input");
    if (urlInput) urlInput.value = "";
    const testRes = document.getElementById("colab-test-result");
    if (testRes) testRes.innerHTML = "";
    closeColabModal();
    showToast("⚡ Colab disconnected. Running on Local CPU.");
  } catch (err) {
    alert("Failed to disconnect: " + err);
  }
}

async function handleCopyColabScript() {
  const btn = document.getElementById("btn-copy-colab-code");
  try {
    const res = await fetch("/api/colab_script");
    const scriptText = await res.text();
    await navigator.clipboard.writeText(scriptText);
    if (btn) btn.textContent = "✓ Copied Script!";
    showToast("📋 Colab Python script copied to clipboard!");
    setTimeout(() => {
      if (btn) btn.textContent = "📋 Copy Colab Script";
    }, 2500);
  } catch (err) {
    console.error("Clipboard copy error:", err);
    alert("Could not copy script automatically. You can copy colab_worker.py directly from the project directory.");
  }
}

// ---------------- UNIFIED EXPORT SYSTEM ---------------- //

function toggleExportDropdown(e) {
  if (e) e.stopPropagation();
  const wrapper = document.getElementById("export-dropdown-wrapper");
  const menu = document.getElementById("export-dropdown-menu");
  if (!menu) return;

  const isHidden = (menu.style.display === "none" || !menu.style.display);
  menu.style.display = isHidden ? "flex" : "none";
  if (wrapper) wrapper.classList.toggle("open", isHidden);

  if (isHidden) {
    updateExportDropdownUI();
    if (typeof closeHistoryDropdown === "function") {
      closeHistoryDropdown();
    }
  }
}

function closeExportDropdown() {
  const wrapper = document.getElementById("export-dropdown-wrapper");
  const menu = document.getElementById("export-dropdown-menu");
  if (menu) menu.style.display = "none";
  if (wrapper) wrapper.classList.remove("open");
}

function updateExportDropdownUI() {
  const scopeTag = document.getElementById("export-menu-scope-tag");
  const itemSelected = document.getElementById("export-item-selected");
  const itemIcon = document.getElementById("export-item-selected-icon");
  const itemTitle = document.getElementById("export-item-selected-title");
  const itemBadge = document.getElementById("export-item-selected-badge");
  const itemDesc = document.getElementById("export-item-selected-desc");

  if (!itemSelected) return;

  const count = state.selectedBlockIndices ? state.selectedBlockIndices.size : 0;

  if (count === 1) {
    const idx = Array.from(state.selectedBlockIndices)[0];
    const block = state.currentProject?.blocks ? state.currentProject.blocks[idx] : null;
    let snippet = "";
    if (block && block.text) {
      snippet = block.text.trim();
      if (snippet.length > 24) snippet = snippet.slice(0, 23) + "…";
      snippet = ` ("${snippet}")`;
    }

    if (scopeTag) scopeTag.textContent = `Sentence #${idx + 1}`;
    if (itemIcon) itemIcon.textContent = "🎵";
    if (itemTitle) itemTitle.textContent = `Export Selected Sentence (.wav)`;
    if (itemBadge) {
      itemBadge.textContent = "WAV";
      itemBadge.className = "export-item-badge purple";
    }
    if (itemDesc) itemDesc.textContent = `Download direct audio file for Sentence #${idx + 1}${snippet}`;
    itemSelected.classList.remove("disabled");
    itemSelected.title = `Export audio file for Sentence #${idx + 1}`;
  } else if (count > 1) {
    if (scopeTag) scopeTag.textContent = `${count} Selected`;
    if (itemIcon) itemIcon.textContent = "📦";
    if (itemTitle) itemTitle.textContent = `Export Selected Sentences (.zip)`;
    if (itemBadge) {
      itemBadge.textContent = `ZIP (${count})`;
      itemBadge.className = "export-item-badge blue";
    }
    if (itemDesc) itemDesc.textContent = `Package ${count} selected sentences as separate audio files in a ZIP`;
    itemSelected.classList.remove("disabled");
    itemSelected.title = `Export ${count} selected sentences into a ZIP archive`;
  } else {
    if (scopeTag) scopeTag.textContent = `0 Selected`;
    if (itemIcon) itemIcon.textContent = "🎯";
    if (itemTitle) itemTitle.textContent = `Export Selected Audio`;
    if (itemBadge) {
      itemBadge.textContent = "SELECT";
      itemBadge.className = "export-item-badge";
    }
    if (itemDesc) itemDesc.textContent = `Check sentence checkboxes in canvas to export selection`;
    itemSelected.classList.add("disabled");
    itemSelected.title = `Select one or more sentence checkboxes to export selection`;
  }
}

async function exportSelectedAudio() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Project has no sentences to export.");
    return;
  }

  const selectedIndices = Array.from(state.selectedBlockIndices || []).sort((a, b) => a - b);
  if (selectedIndices.length === 0) {
    showToast("⚠️ Please select one or more sentences to export.");
    return;
  }

  const titleSlug = (state.currentProject.title || "story")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "story";

  const exportTriggerBtn = document.getElementById("btn-export-dropdown");

  // CASE 1: Single sentence selected -> Export directly as .wav file
  if (selectedIndices.length === 1) {
    const idx = selectedIndices[0];
    const block = state.currentProject.blocks[idx];
    if (!block) return;

    if (block.type === "heading" || block.is_spoken === false) {
      showToast("⚠️ Scene headings have no audio to export.");
      return;
    }

    if (exportTriggerBtn) {
      exportTriggerBtn.innerHTML = `<span>⏳ Synthesizing...</span> <span class="dropdown-caret">▾</span>`;
      exportTriggerBtn.disabled = true;
    }

    // Check if rendered, if not synthesize on demand
    let audioUrl = block.cachedAudioUrl;
    if (!audioUrl) {
      showToast(`⚡ Rendering audio for sentence #${idx + 1}...`);
      try {
        const res = await fetch("/api/synthesize_block", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: block.text,
            voice_id: block.voice_id,
            blend_weights: block.blend_weights,
            speed: block.speed || 0.90,
            gain: block.gain || 1.0,
            pitch_shift: block.pitch_shift || 0.0,
            warmth: block.warmth || 0.0,
            clarity: block.clarity || 0.0,
            reverb: block.reverb || 0.0,
            radio_fx: Boolean(block.radio_fx),
            fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
          })
        });
        const data = await res.json();
        if (data.audio_url) {
          block.cachedAudioUrl = data.audio_url;
          block.duration = data.duration;
          audioUrl = data.audio_url;
          debouncedSave();
          renderTimeline();
          const row = document.querySelector(`[data-index="${idx}"]`);
          if (row) {
            row.classList.add("ready");
            const timeText = row.querySelector(".scrubber-time");
            if (timeText) timeText.textContent = `${data.duration.toFixed(1)}s`;
          }
        } else {
          throw new Error(data.error || "Synthesis returned no audio URL");
        }
      } catch (err) {
        showToast("❌ Synthesis failed: " + err.message);
        if (exportTriggerBtn) {
          exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
          exportTriggerBtn.disabled = false;
        }
        return;
      }
    }

    const cleanSnippet = (block.text || "")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("_")
      .toLowerCase();
    const downloadFilename = `${titleSlug}_sentence_${String(idx + 1).padStart(2, "0")}${cleanSnippet ? "_" + cleanSnippet : ""}.wav`;

    showToast(`⏳ Downloading Sentence #${idx + 1}...`);
    try {
      const res = await fetch(`${audioUrl}?download=1&filename=${encodeURIComponent(downloadFilename)}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      showToast(`✓ Exported: ${downloadFilename}`);
    } catch (err) {
      const a = document.createElement("a");
      a.href = `${audioUrl}?download=1&filename=${encodeURIComponent(downloadFilename)}`;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`✓ Downloading ${downloadFilename}`);
    } finally {
      if (exportTriggerBtn) {
        exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportTriggerBtn.disabled = false;
      }
    }
    return;
  }

  // CASE 2: Multiple sentences selected -> Export as .zip archive
  const selectedBlocks = selectedIndices
    .map(i => state.currentProject.blocks[i])
    .filter(b => b && b.text && b.text.trim() && b.type !== "heading" && b.is_spoken !== false);

  if (selectedBlocks.length === 0) {
    showToast("⚠️ None of the selected items are spoken sentences.");
    return;
  }

  const zipFilename = `${titleSlug}_selected_${selectedBlocks.length}_sentences.zip`;
  showToast(`📦 Packaging ${selectedBlocks.length} selected sentences into ZIP...`);

  if (exportTriggerBtn) {
    exportTriggerBtn.innerHTML = `<span>⏳ Packaging (${selectedBlocks.length})...</span> <span class="dropdown-caret">▾</span>`;
    exportTriggerBtn.disabled = true;
  }

  try {
    const res = await fetch("/api/export_zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: selectedBlocks,
        filename: zipFilename
      })
    });
    const data = await res.json();
    if (data.error) {
      showToast("❌ ZIP export failed: " + data.error);
    } else if (data.zip_url) {
      const a = document.createElement("a");
      a.href = `${data.zip_url}?download=1&filename=${encodeURIComponent(zipFilename)}`;
      a.download = data.filename || zipFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`📦 Exported ZIP with ${data.file_count || selectedBlocks.length} selected sentences!`);
    }
  } catch (err) {
    showToast("❌ Export failed: " + err.message);
  } finally {
    if (exportTriggerBtn) {
      exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
      exportTriggerBtn.disabled = false;
    }
  }
}

async function exportMasterAudio() {
  const exportBtn = document.getElementById("btn-export-dropdown");
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Project has no sentences to export.");
    return;
  }
  if (exportBtn) {
    exportBtn.innerHTML = `<span>⏳ Stitching Master...</span> <span class="dropdown-caret">▾</span>`;
    exportBtn.disabled = true;
  }

  try {
    const filename = `${state.currentProject.id || 'story'}_master.wav`;
    const res = await fetch("/api/export_master", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        filename: filename
      })
    });

    const data = await res.json();
    if (data.error) {
      showToast("❌ Export failed: " + data.error);
      return;
    }
    if (data.master_url) {
      state.storyAudioPlayer.src = `${data.master_url}?t=${Date.now()}`;
      state.storyAudioPlayer.play().catch(() => {});

      const a = document.createElement("a");
      a.href = `${data.master_url}?download=1&filename=${encodeURIComponent(data.filename || filename)}`;
      a.download = data.filename || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast("🎬 Master WAV compiled and download started!");
    }
  } catch (err) {
    showToast("Export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportBtn.disabled = false;
      }
    }, 2000);
  }
}

async function exportZipAudio() {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) {
    showToast("⚠️ No sentences to export.");
    return;
  }

  const exportBtn = document.getElementById("btn-export-dropdown");
  if (exportBtn) {
    exportBtn.innerHTML = `<span>⏳ Packaging All ZIP...</span> <span class="dropdown-caret">▾</span>`;
    exportBtn.disabled = true;
  }

  try {
    const titleSlug = (state.currentProject.title || "story")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "story";
    const filename = `${titleSlug}_sentences.zip`;

    showToast("📦 Packaging all sentence audio files into ZIP...");

    const res = await fetch("/api/export_zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        filename: filename
      })
    });

    const data = await res.json();
    if (data.error) {
      showToast("❌ ZIP export failed: " + data.error);
    } else if (data.zip_url) {
      const a = document.createElement("a");
      a.href = `${data.zip_url}?download=1&filename=${encodeURIComponent(filename)}`;
      a.download = data.filename || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`📦 Downloaded ZIP with ${data.file_count} individual sentence audio files!`);
    }
  } catch (err) {
    showToast("ZIP export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportBtn.disabled = false;
      }
    }, 2000);
  }
}

function handleExportSelectedFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportSelectedAudio();
}

function handleExportMasterFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportMasterAudio();
}

function handleExportZipFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportZipAudio();
}

function handleExportProjectJson(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  if (!state.currentProject) {
    showToast("⚠️ No project open to export.");
    return;
  }
  try {
    const titleSlug = (state.currentProject.title || "story")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "story";
    const filename = `${titleSlug}_backup.json`;
    const jsonStr = JSON.stringify(state.currentProject, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(`✓ Exported project JSON: ${filename}`);
  } catch (err) {
    showToast("❌ Failed to export project JSON: " + err.message);
  }
}

// ---------------- EVENT LISTENERS ---------------- //

function setupEventListeners() {
  // Navigation: Back to Dashboard
  document.getElementById("btn-back-to-dashboard")?.addEventListener("click", () => {
    switchToView("dashboard");
  });

  // Top Nav Create Project Button
  document.getElementById("btn-create-project-top")?.addEventListener("click", openNewProjectModal);

  // New Project Submit & Close
  document.getElementById("btn-create-project-submit")?.addEventListener("click", handleCreateProjectSubmit);
  document.getElementById("new-project-close-btn")?.addEventListener("click", closeNewProjectModal);

  // Dashboard Hero Dropzone drag & drop
  const dashDropzone = document.getElementById("dashboard-dropzone");
  if (dashDropzone) {
    dashDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dashDropzone.classList.add("drag-over");
    });
    dashDropzone.addEventListener("dragleave", () => {
      dashDropzone.classList.remove("drag-over");
    });
    dashDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dashDropzone.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        processImportedFile(e.dataTransfer.files[0], "dashboard");
      }
    });
  }

  // Project title rename in Studio
  document.getElementById("project-title")?.addEventListener("input", (e) => {
    if (state.currentProject) {
      state.currentProject.title = e.target.value;
      document.title = `${e.target.value || "Story Studio"} — Kashva Studio TTS`;
      debouncedSave();
    }
  });

  // Add Block button
  document.getElementById("btn-add-block")?.addEventListener("click", () => {
    if (!state.currentProject) return;
    recordHistory("Add Sentence Block");
    const defs = getProjectDefaultSettings();
    const newIdx = state.currentProject.blocks.length;
    const newBlock = {
      id: "b_" + (newIdx + 1) + "_" + Date.now().toString().slice(-4),
      text: "",
      voice_id: defs.voice_id,
      speed: defs.speed,
      gain: defs.gain,
      pause_after: defs.pause_after,
      pitch_shift: defs.pitch_shift,
      warmth: defs.warmth,
      clarity: defs.clarity,
      reverb: defs.reverb,
      radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
      fx_filter: defs.fx_filter
    };
    if (defs.blend_weights) {
      newBlock.blend_weights = JSON.parse(JSON.stringify(defs.blend_weights));
    }
    state.currentProject.blocks.push(newBlock);
    renderStudio();
    selectBlock(newIdx, "single");
    debouncedSave();

    // Auto-scroll directly to the new block and immediately focus its textarea for typing
    setTimeout(() => {
      const rows = document.querySelectorAll(".block-row");
      const targetRow = rows[newIdx] || rows[rows.length - 1];
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
        const ta = targetRow.querySelector(".block-textarea");
        if (ta) {
          ta.focus();
        }
      }
    }, 40);
  });

  // Inspector voice trigger
  document.getElementById("inspector-voice-card")?.addEventListener("click", () => {
    openVoiceDrawer(state.activeBlockIndex);
  });

  // Slider events - Bulk Aware (Updates all selected blocks)
  document.getElementById("slider-volume")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    document.getElementById("val-volume").textContent = val + "%";
    if (!state.currentProject || !state.currentProject.blocks) return;
    const gainVal = val / 100;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.gain = gainVal;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-volume")?.addEventListener("change", () => recordHistory("Adjust Volume"));

  document.getElementById("slider-speed")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-speed").textContent = val.toFixed(2) + "x";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.speed = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-speed")?.addEventListener("change", () => recordHistory("Adjust Speed"));

  document.getElementById("slider-pause")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-pause").textContent = val.toFixed(1) + "s";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.pause_after = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-pause")?.addEventListener("change", () => recordHistory("Adjust Pause"));

  document.getElementById("slider-pitch")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-pitch").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " st";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.pitch_shift = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-pitch")?.addEventListener("change", () => recordHistory("Adjust Pitch"));

  document.getElementById("slider-warmth")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-warmth").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.warmth = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-warmth")?.addEventListener("change", () => recordHistory("Adjust Warmth"));

  document.getElementById("slider-clarity")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-clarity").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.clarity = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-clarity")?.addEventListener("change", () => recordHistory("Adjust Clarity"));

  document.getElementById("slider-reverb")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById("val-reverb").textContent = val + "%";
    if (!state.currentProject || !state.currentProject.blocks) return;
    const revRatio = val / 100.0;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.reverb = revRatio;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-reverb")?.addEventListener("change", () => recordHistory("Adjust Reverb"));

  // Character Modal Voice Select
  document.getElementById("char-modal-voice-select")?.addEventListener("change", (e) => {
    updateCharModalVoiceDetails(e.target.value);
  });

  // Character Modal Name Input live preview
  document.getElementById("char-modal-name-input")?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const avatar = document.getElementById("char-modal-avatar-preview");
    if (avatar) {
      avatar.textContent = val ? val.slice(0, 2).toUpperCase() : "CH";
    }
  });

  // Character Modal Sliders live label updates
  document.getElementById("char-slider-speed")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-speed");
    if (label) label.textContent = val.toFixed(2) + "x";
  });

  document.getElementById("char-slider-pause")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-pause");
    if (label) label.textContent = val.toFixed(1) + "s";
  });

  document.getElementById("char-slider-pitch")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-pitch");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " st";
  });

  document.getElementById("char-slider-warmth")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-warmth");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
  });

  document.getElementById("char-slider-clarity")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-clarity");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
  });

  document.getElementById("char-slider-reverb")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    const label = document.getElementById("char-val-reverb");
    if (label) label.textContent = val + "%";
  });

  // Drawer Search, Sort & Filters
  document.getElementById("drawer-search")?.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderVoiceList();
  });

  document.getElementById("drawer-sort")?.addEventListener("change", (e) => {
    state.activeSort = e.target.value;
    renderVoiceList();
  });

  document.querySelectorAll(".filter-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      state.activeFilter = pill.dataset.filter;
      renderVoiceList();
    });
  });

  document.getElementById("drawer-close-btn")?.addEventListener("click", closeVoiceDrawer);
  document.getElementById("voice-drawer")?.addEventListener("click", (e) => {
    if (e.target.id === "voice-drawer") closeVoiceDrawer();
  });

  document.getElementById("rail-voices-btn")?.addEventListener("click", () => openVoiceDrawer());

  // Keyboard shortcuts: Space toggles playback, Ctrl+Z undos, Ctrl+Y redos
  window.addEventListener("keydown", (e) => {
    // Undo: Ctrl+Z or Cmd+Z (when not typing inside an active input/textarea)
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      if (e.shiftKey) {
        // Redo: Ctrl+Shift+Z
        e.preventDefault();
        handleRedo();
        return;
      } else {
        if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          handleUndo();
          return;
        }
      }
    }

    // Redo: Ctrl+Y or Cmd+Y
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
      if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        handleRedo();
        return;
      }
    }

    // Reorder shortcuts: Alt+ArrowUp to move up, Alt+ArrowDown to move down
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const currentIdx = typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0;
      if (e.key === "ArrowUp") {
        moveBlockUp(currentIdx);
      } else {
        moveBlockDown(currentIdx);
      }
      return;
    }

    if (["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space" && state.currentView === "studio") {
      e.preventDefault();
      handleMasterPlayToggle();
    }
  });

  // Close dropdowns on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#history-dropdown-wrapper")) {
      closeHistoryDropdown();
    }
    if (!e.target.closest("#export-dropdown-wrapper")) {
      closeExportDropdown();
    }
  });

  // Blocks container drop handler (for dropping below all blocks)
  const blocksContainer = document.getElementById("blocks-container");
  if (blocksContainer) {
    blocksContainer.addEventListener("dragover", (e) => {
      if (state.draggedBlockIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    blocksContainer.addEventListener("drop", (e) => {
      if (e.target === blocksContainer && state.draggedBlockIndex !== null) {
        e.preventDefault();
        const fromIdx = state.draggedBlockIndex;
        const toIdx = state.currentProject?.blocks?.length || 0;
        reorderBlock(fromIdx, toIdx);
      }
    });
  }

  // Modal Backdrop Clicks
  const colabModal = document.getElementById("colab-modal");
  if (colabModal) {
    colabModal.addEventListener("click", (e) => {
      if (e.target.id === "colab-modal") closeColabModal();
    });
  }

  const newProjModal = document.getElementById("new-project-modal");
  if (newProjModal) {
    newProjModal.addEventListener("click", (e) => {
      if (e.target.id === "new-project-modal") closeNewProjectModal();
    });
  }

  const importModal = document.getElementById("import-modal");
  if (importModal) {
    importModal.addEventListener("click", (e) => {
      if (e.target.id === "import-modal") closeImportModal();
    });
  }

  const saveCharModal = document.getElementById("save-character-modal");
  if (saveCharModal) {
    saveCharModal.addEventListener("click", (e) => {
      if (e.target.id === "save-character-modal") closeSaveCharacterModal();
    });
  }

  document.getElementById("char-modal-name-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmSaveCharacter();
    }
  });

  // Drag and drop for new project textarea
  const newProjTextarea = document.getElementById("new-project-text-input");
  if (newProjTextarea) {
    newProjTextarea.addEventListener("dragover", (e) => {
      e.preventDefault();
      newProjTextarea.classList.add("drag-over");
    });
    newProjTextarea.addEventListener("dragleave", () => {
      newProjTextarea.classList.remove("drag-over");
    });
    newProjTextarea.addEventListener("drop", (e) => {
      e.preventDefault();
      newProjTextarea.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        processImportedFile(e.dataTransfer.files[0], "new_project_modal");
      }
    });
  }

  // Drag and drop for studio import textarea
  const importTextarea = document.getElementById("import-textarea");
  if (importTextarea) {
    importTextarea.addEventListener("dragover", (e) => {
      e.preventDefault();
      importTextarea.classList.add("drag-over");
    });
    importTextarea.addEventListener("dragleave", () => {
      importTextarea.classList.remove("drag-over");
    });
    importTextarea.addEventListener("drop", (e) => {
      e.preventDefault();
      importTextarea.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (evt) => {
          importTextarea.value = evt.target.result;
          showToast(`✓ Loaded "${file.name}"`);
        };
        reader.readAsText(file, "UTF-8");
      }
    });
  }
}

function splitTextIntoSentences(text) {
  if (!text) return [];
  const raw = text.replace(/\r\n/g, "\n").trim();
  const sentences = raw
    .split(/(?<=[.!?]["'”’]?)\s+(?=[A-Z0-9"“'‘])|\n{2,}|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return sentences.length > 0 ? sentences : [raw];
}

function splitBlock(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const block = state.currentProject.blocks[idx];
  if (!block || !block.text) return;

  const sentences = splitTextIntoSentences(block.text);
  if (sentences.length <= 1) {
    showToast("ℹ️ This block is already a single sentence.");
    return;
  }

  recordHistory(`Split Block ${idx + 1}`);

  const defs = getProjectDefaultSettings();
  const baseVoice = block.voice_id || defs.voice_id;
  const baseSpeed = block.speed !== undefined ? block.speed : defs.speed;
  const baseGain = block.gain !== undefined ? block.gain : defs.gain;
  const basePause = block.pause_after !== undefined ? block.pause_after : defs.pause_after;
  const basePitch = block.pitch_shift !== undefined ? block.pitch_shift : defs.pitch_shift;
  const baseWarmth = block.warmth !== undefined ? block.warmth : defs.warmth;
  const baseClarity = block.clarity !== undefined ? block.clarity : defs.clarity;
  const baseReverb = block.reverb !== undefined ? block.reverb : defs.reverb;
  const baseFilter = block.fx_filter || (block.radio_fx ? "radio" : defs.fx_filter);
  const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

  const newBlocks = sentences.map((sent, sIdx) => {
    const newB = {
      id: `${block.id || 'b'}_s${sIdx + 1}_${Date.now()}`,
      text: sent,
      voice_id: baseVoice,
      speed: baseSpeed,
      gain: baseGain,
      pause_after: basePause,
      pitch_shift: basePitch,
      warmth: baseWarmth,
      clarity: baseClarity,
      reverb: baseReverb,
      radio_fx: (baseFilter === "radio"),
      fx_filter: baseFilter
    };
    if (baseBlend) newB.blend_weights = JSON.parse(JSON.stringify(baseBlend));
    return newB;
  });

  state.currentProject.blocks.splice(idx, 1, ...newBlocks);

  state.selectedBlockIndices = new Set([idx]);
  state.activeBlockIndex = idx;
  renderStudio();
  debouncedSave();
  showToast(`✂️ Split paragraph into ${sentences.length} sentences for faster inference!`);
}

function handleAutoSplitAll() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;

  const defs = getProjectDefaultSettings();
  let totalSplits = 0;
  const newBlocksList = [];

  state.currentProject.blocks.forEach((block) => {
    if (block.type === "heading" || block.is_spoken === false) {
      newBlocksList.push(block);
      return;
    }
    const sentences = splitTextIntoSentences(block.text || "");
    if (sentences.length > 1) {
      totalSplits += (sentences.length - 1);
      const baseVoice = block.voice_id || defs.voice_id;
      const baseSpeed = block.speed !== undefined ? block.speed : defs.speed;
      const baseGain = block.gain !== undefined ? block.gain : defs.gain;
      const basePause = block.pause_after !== undefined ? block.pause_after : defs.pause_after;
      const basePitch = block.pitch_shift !== undefined ? block.pitch_shift : defs.pitch_shift;
      const baseWarmth = block.warmth !== undefined ? block.warmth : defs.warmth;
      const baseClarity = block.clarity !== undefined ? block.clarity : defs.clarity;
      const baseReverb = block.reverb !== undefined ? block.reverb : defs.reverb;
      const baseFilter = block.fx_filter || (block.radio_fx ? "radio" : defs.fx_filter);
      const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

      sentences.forEach((sent, sIdx) => {
        const nb = {
          id: `${block.id || 'b'}_s${sIdx + 1}_${Date.now()}`,
          text: sent,
          voice_id: baseVoice,
          speed: baseSpeed,
          gain: baseGain,
          pause_after: basePause,
          pitch_shift: basePitch,
          warmth: baseWarmth,
          clarity: baseClarity,
          reverb: baseReverb,
          radio_fx: (baseFilter === "radio"),
          fx_filter: baseFilter
        };
        if (baseBlend) nb.blend_weights = JSON.parse(JSON.stringify(baseBlend));
        newBlocksList.push(nb);
      });
    } else {
      newBlocksList.push(block);
    }
  });

  if (totalSplits === 0) {
    showToast("ℹ️ All blocks are already individual sentences!");
    return;
  }

  recordHistory("Auto-Split Sentences");

  state.currentProject.blocks = newBlocksList;
  state.selectedBlockIndices = new Set([0]);
  state.activeBlockIndex = 0;
  renderStudio();
  debouncedSave();
  showToast(`✂️ Auto-split complete! Created ${state.currentProject.blocks.length} single-sentence blocks for ultra-fast rendering.`);
}

function deleteBlock(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  if (state.currentProject.blocks.length <= 1) {
    showToast("⚠️ Project must have at least one block.");
    return;
  }
  const deletedItem = state.currentProject.blocks[idx];
  const itemType = (deletedItem?.type === "heading" || deletedItem?.is_spoken === false) ? "Scene Heading" : "Sentence";

  recordHistory(`Delete ${itemType} (Row ${idx + 1})`);

  state.currentProject.blocks.splice(idx, 1);
  const nextSelected = new Set();
  state.selectedBlockIndices.forEach(i => {
    if (i < idx) nextSelected.add(i);
    else if (i > idx) nextSelected.add(i - 1);
  });
  if (nextSelected.size === 0) {
    nextSelected.add(Math.min(idx, state.currentProject.blocks.length - 1));
  }
  state.selectedBlockIndices = nextSelected;
  state.activeBlockIndex = Math.min(state.activeBlockIndex, state.currentProject.blocks.length - 1);
  renderStudio();
  debouncedSave();
  showToast(`✓ ${itemType} deleted.`);
}

// ---------------- DRAG & DROP REORDERING ENGINE ---------------- //

function attachBlockDragAndDrop(row, idx) {
  const handle = row.querySelector(".block-drag-handle");
  if (!handle) return;

  // Make row draggable only when user interacts with the grip handle
  handle.addEventListener("mouseenter", () => {
    row.setAttribute("draggable", "true");
  });
  handle.addEventListener("mouseleave", () => {
    if (!row.classList.contains("is-dragging")) {
      row.removeAttribute("draggable");
    }
  });

  row.addEventListener("dragstart", (e) => {
    state.draggedBlockIndex = idx;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
    row.classList.add("is-dragging");

    if (!state.selectedBlockIndices.has(idx)) {
      selectBlock(idx, "single");
    }
  });

  row.addEventListener("dragend", () => {
    row.removeAttribute("draggable");
    row.classList.remove("is-dragging");
    state.draggedBlockIndex = null;
    document.querySelectorAll(".drop-indicator-above, .drop-indicator-below").forEach(el => {
      el.classList.remove("drop-indicator-above", "drop-indicator-below");
    });
  });

  row.addEventListener("dragover", (e) => {
    if (state.draggedBlockIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = row.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isUpper = relY < rect.height / 2;

    if (isUpper) {
      row.classList.add("drop-indicator-above");
      row.classList.remove("drop-indicator-below");
    } else {
      row.classList.add("drop-indicator-below");
      row.classList.remove("drop-indicator-above");
    }
  });

  row.addEventListener("dragleave", (e) => {
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove("drop-indicator-above", "drop-indicator-below");
    }
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-indicator-above", "drop-indicator-below");
    if (state.draggedBlockIndex === null) return;

    const fromIdx = state.draggedBlockIndex;
    const rect = row.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isUpper = relY < rect.height / 2;
    const toIdx = isUpper ? idx : idx + 1;

    reorderBlock(fromIdx, toIdx);
  });
}

function reorderBlock(fromIdx, toIdx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  if (fromIdx < 0 || fromIdx >= blocks.length) return;

  const isMultiDrag = Boolean(
    state.selectedBlockIndices &&
    state.selectedBlockIndices.size > 1 &&
    state.selectedBlockIndices.has(fromIdx)
  );

  let finalTargetIndex = 0;

  if (!isMultiDrag) {
    let target = toIdx;
    if (target > fromIdx) target -= 1;
    if (target === fromIdx) return; // Same position, no-op

    target = Math.max(0, Math.min(target, blocks.length - 1));

    const item = blocks[fromIdx];
    const itemLabel = (item.type === "heading" || item.is_spoken === false) ? "Scene Heading" : "Sentence";
    recordHistory(`Move ${itemLabel} to Row ${target + 1}`);

    const [moved] = blocks.splice(fromIdx, 1);
    blocks.splice(target, 0, moved);

    state.activeBlockIndex = target;
    state.selectedBlockIndices = new Set([target]);
    finalTargetIndex = target;
  } else {
    const sortedIndices = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    const targetBlockRef = (toIdx >= 0 && toIdx < blocks.length) ? blocks[toIdx] : null;

    recordHistory(`Reorder ${sortedIndices.length} Blocks`);

    const selectedBlocks = sortedIndices.map(i => blocks[i]);

    // Remove in reverse order
    for (let i = sortedIndices.length - 1; i >= 0; i--) {
      blocks.splice(sortedIndices[i], 1);
    }

    let insertPos = targetBlockRef ? blocks.indexOf(targetBlockRef) : blocks.length;
    if (insertPos === -1) insertPos = blocks.length;

    blocks.splice(insertPos, 0, ...selectedBlocks);

    const newSelection = new Set();
    for (let i = 0; i < selectedBlocks.length; i++) {
      newSelection.add(insertPos + i);
    }
    state.selectedBlockIndices = newSelection;
    state.activeBlockIndex = insertPos;
    finalTargetIndex = insertPos;
  }

  renderStudio();
  debouncedSave();

  setTimeout(() => {
    const rows = document.querySelectorAll(".block-row, .scene-divider-row");
    const targetRow = rows[finalTargetIndex];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, 30);

  showToast(`↕️ Reordered: position ${finalTargetIndex + 1} of ${state.currentProject.blocks.length}`);
}

function moveBlockUp(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  const targetIdx = (typeof idx === "number" && idx >= 0 && idx < blocks.length) ? idx : state.activeBlockIndex;
  if (targetIdx <= 0) {
    showToast("ℹ️ Already at the top of the story.");
    return;
  }

  if (state.selectedBlockIndices && state.selectedBlockIndices.size > 1 && state.selectedBlockIndices.has(targetIdx)) {
    const sorted = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    if (sorted[0] <= 0) {
      showToast("ℹ️ Selected sentences are already at the very top.");
      return;
    }
    reorderBlock(targetIdx, sorted[0] - 1);
    return;
  }

  reorderBlock(targetIdx, targetIdx - 1);
}

function moveBlockDown(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  const targetIdx = (typeof idx === "number" && idx >= 0 && idx < blocks.length) ? idx : state.activeBlockIndex;
  if (targetIdx >= blocks.length - 1) {
    showToast("ℹ️ Already at the bottom of the story.");
    return;
  }

  if (state.selectedBlockIndices && state.selectedBlockIndices.size > 1 && state.selectedBlockIndices.has(targetIdx)) {
    const sorted = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    if (sorted[sorted.length - 1] >= blocks.length - 1) {
      showToast("ℹ️ Selected sentences are already at the very bottom.");
      return;
    }
    reorderBlock(targetIdx, sorted[sorted.length - 1] + 2);
    return;
  }

  reorderBlock(targetIdx, targetIdx + 2);
}

function insertBlockAfter(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const defs = getProjectDefaultSettings();
  const insertIdx = idx + 1;
  const currentBlock = state.currentProject.blocks[idx] || {};

  recordHistory(`Insert Sentence Block`);

  // Inherit voice actor and settings from the adjacent block if available
  const targetVoice = currentBlock.voice_id || defs.voice_id;
  const targetBlend = currentBlock.blend_weights ? JSON.parse(JSON.stringify(currentBlock.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

  const newBlock = {
    id: "b_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    text: "",
    voice_id: targetVoice,
    speed: currentBlock.speed !== undefined ? currentBlock.speed : defs.speed,
    gain: currentBlock.gain !== undefined ? currentBlock.gain : defs.gain,
    pause_after: currentBlock.pause_after !== undefined ? currentBlock.pause_after : defs.pause_after,
    pitch_shift: currentBlock.pitch_shift !== undefined ? currentBlock.pitch_shift : defs.pitch_shift,
    warmth: currentBlock.warmth !== undefined ? currentBlock.warmth : defs.warmth,
    clarity: currentBlock.clarity !== undefined ? currentBlock.clarity : defs.clarity,
    reverb: currentBlock.reverb !== undefined ? currentBlock.reverb : defs.reverb,
    radio_fx: currentBlock.radio_fx !== undefined ? Boolean(currentBlock.radio_fx) : Boolean(defs.radio_fx),
    fx_filter: currentBlock.fx_filter || defs.fx_filter || "none"
  };
  if (targetBlend) {
    newBlock.blend_weights = targetBlend;
  }

  state.currentProject.blocks.splice(insertIdx, 0, newBlock);
  renderStudio();
  selectBlock(insertIdx, "single");
  debouncedSave();

  // Scroll smoothly to the newly inserted block and focus its textarea
  setTimeout(() => {
    const rows = document.querySelectorAll(".block-row, .scene-divider-row");
    const targetRow = rows[insertIdx];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const ta = targetRow.querySelector(".block-textarea");
      if (ta) {
        ta.focus();
      }
    }
  }, 40);

  showToast(`＋ Inserted new sentence block at position ${insertIdx + 1}!`);
}

function addNewSceneHeading() {
  if (!state.currentProject) return;
  recordHistory("Add Scene Heading");
  const newIdx = state.currentProject.blocks.length;
  const headingBlock = {
    id: "h_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    type: "heading",
    text: "Scene " + (countHeadings() + 1),
    is_spoken: false,
    pause_after: 1.0
  };
  state.currentProject.blocks.push(headingBlock);
  renderStudio();
  selectBlock(newIdx, "single");
  debouncedSave();

  setTimeout(() => {
    const rows = document.querySelectorAll(".scene-divider-row, .block-row");
    const targetRow = rows[newIdx] || rows[rows.length - 1];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const inp = targetRow.querySelector(".scene-title-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }, 40);
  showToast("🎬 Added Scene Heading (non-spoken divider)!");
}

function insertHeadingAfter(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  recordHistory(`Insert Scene Heading (Row ${idx + 1})`);
  const insertIdx = idx + 1;
  const headingBlock = {
    id: "h_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    type: "heading",
    text: "Scene " + (countHeadings() + 1),
    is_spoken: false,
    pause_after: 1.0
  };
  state.currentProject.blocks.splice(insertIdx, 0, headingBlock);
  renderStudio();
  selectBlock(insertIdx, "single");
  debouncedSave();

  setTimeout(() => {
    const rows = document.querySelectorAll(".scene-divider-row, .block-row");
    const targetRow = rows[insertIdx];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const inp = targetRow.querySelector(".scene-title-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }, 40);
  showToast(`🎬 Inserted Scene Heading at position ${insertIdx + 1}!`);
}

function convertHeadingToSpeech(idx) {
  if (!state.currentProject?.blocks?.[idx]) return;
  recordHistory("Convert Divider to Speech");
  const b = state.currentProject.blocks[idx];
  const defs = getProjectDefaultSettings();
  b.type = "speech";
  b.is_spoken = true;
  b.voice_id = b.voice_id || defs.voice_id;
  b.speed = b.speed !== undefined ? b.speed : defs.speed;
  b.gain = b.gain !== undefined ? b.gain : defs.gain;
  b.pause_after = b.pause_after !== undefined ? b.pause_after : defs.pause_after;
  b.pitch_shift = b.pitch_shift !== undefined ? b.pitch_shift : defs.pitch_shift;
  b.warmth = b.warmth !== undefined ? b.warmth : defs.warmth;
  b.clarity = b.clarity !== undefined ? b.clarity : defs.clarity;
  b.reverb = b.reverb !== undefined ? b.reverb : defs.reverb;
  b.fx_filter = b.fx_filter || defs.fx_filter;
  b.radio_fx = Boolean(b.fx_filter === "radio");
  renderStudio();
  debouncedSave();
  showToast("🎙️ Converted divider to spoken sentence block!");
}

function convertSpeechToHeading(idx) {
  if (!state.currentProject?.blocks?.[idx]) return;
  recordHistory("Convert Sentence to Divider");
  const b = state.currentProject.blocks[idx];
  b.type = "heading";
  b.is_spoken = false;
  b.pause_after = b.pause_after !== undefined ? b.pause_after : 1.0;
  delete b.cachedAudioUrl;
  delete b.cachedSig;
  delete b.duration;
  renderStudio();
  debouncedSave();
  showToast("🎬 Converted to non-spoken Scene Heading!");
}

// ---------------- GLOBAL WINDOW EXPORTS FOR INLINE ONCLICK ---------------- //
window.toggleSelectAll = toggleSelectAll;
window.openVoiceDrawer = openVoiceDrawer;
window.closeVoiceDrawer = closeVoiceDrawer;
window.handleBulkRender = handleBulkRender;
window.handleBulkDelete = handleBulkDelete;
window.handleMakeDefaultVoice = handleMakeDefaultVoice;
window.handleApplyVoiceToAll = handleApplyVoiceToAll;
window.handleApplyPacingToAll = handleApplyPacingToAll;
window.handleSetCurrentAsDefault = handleSetCurrentAsDefault;
window.getProjectDefaultSettings = getProjectDefaultSettings;
window.handleToggleRadioFx = handleToggleRadioFx;
window.handleSelectAudioFilter = handleSelectAudioFilter;
window.splitBlock = splitBlock;
window.insertBlockAfter = insertBlockAfter;
window.handleAutoSplitAll = handleAutoSplitAll;
window.handleAutoDirectStory = handleAutoDirectStory;
window.handleMergeShortBlocks = handleMergeShortBlocks;
window.handleBulkMergeSelected = handleBulkMergeSelected;
window.applyDeliveryPreset = applyDeliveryPreset;
window.splitTextIntoSentences = splitTextIntoSentences;
window.deleteBlock = deleteBlock;
window.switchToView = switchToView;
window.openProject = openProject;
window.saveCurrentProject = saveCurrentProject;
window.showToast = showToast;
window.openColabModal = openColabModal;
window.closeColabModal = closeColabModal;
window.handleTestColab = handleTestColab;
window.handleSaveColab = handleSaveColab;
window.handleClearColab = handleClearColab;
window.handleCopyColabScript = handleCopyColabScript;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.handleDoImport = handleDoImport;
window.openNewProjectModal = openNewProjectModal;
window.closeNewProjectModal = closeNewProjectModal;
window.handleCreateProjectSubmit = handleCreateProjectSubmit;
window.toggleBatchRender = toggleBatchRender;
window.exportMasterAudio = exportMasterAudio;
window.exportZipAudio = exportZipAudio;
window.handleMasterPlayToggle = handleMasterPlayToggle;
window.handleMasterPrev = handleMasterPrev;
window.handleMasterNext = handleMasterNext;
window.handleMasterStop = handleMasterStop;
window.playBlockAudio = playBlockAudio;
window.handleDashboardFileImport = handleDashboardFileImport;
window.handleNewProjectFile = handleNewProjectFile;
window.loadSampleIntoNewProject = loadSampleIntoNewProject;
window.clearNewProjectFile = clearNewProjectFile;
window.handleImportModalFile = handleImportModalFile;
window.processImportedFile = processImportedFile;
window.cleanTitleFromFilename = cleanTitleFromFilename;
window.handleUndo = handleUndo;
window.handleRedo = handleRedo;
window.toggleHistoryDropdown = toggleHistoryDropdown;
window.revertToHistoryStep = revertToHistoryStep;
window.addNewSceneHeading = addNewSceneHeading;
window.insertHeadingAfter = insertHeadingAfter;
window.convertHeadingToSpeech = convertHeadingToSpeech;
window.convertSpeechToHeading = convertSpeechToHeading;
window.handleApplyVoiceToSelected = handleApplyVoiceToSelected;
window.handleApplySettingsToSelected = handleApplySettingsToSelected;
window.handleOpenSaveCharacterModal = handleOpenSaveCharacterModal;
window.closeSaveCharacterModal = closeSaveCharacterModal;
window.confirmSaveCharacter = confirmSaveCharacter;
window.applyCharacterToSelected = applyCharacterToSelected;
window.updateCharacterWithCurrent = updateCharacterWithCurrent;
window.renameCharacter = renameCharacter;
window.deleteCharacter = deleteCharacter;
window.renderSavedCharactersList = renderSavedCharactersList;

// ---------------- INSPECTOR TAB NAVIGATION & CONTROLS ---------------- //

function switchInspectorTab(tabName) {
  if (!tabName) tabName = "audio";
  state.currentInspectorTab = tabName;

  // Uncollapse panel if collapsed
  const panel = document.getElementById("inspector-panel") || document.querySelector(".inspector-panel");
  if (panel && panel.classList.contains("collapsed")) {
    toggleInspectorCollapse(false);
  }

  // Update tabs & rail buttons
  ["audio", "cast", "fx"].forEach(tab => {
    const railBtn = document.getElementById(`rail-tab-${tab}`);
    if (railBtn) railBtn.classList.toggle("active", tab === tabName);

    const tabPill = document.getElementById(`tab-btn-${tab}`);
    if (tabPill) tabPill.classList.toggle("active", tab === tabName);

    const pane = document.getElementById(`inspector-tab-pane-${tab}`);
    if (pane) pane.classList.toggle("active", tab === tabName);
  });
}

function toggleInspectorCollapse(forceState = null) {
  const panel = document.getElementById("inspector-panel") || document.querySelector(".inspector-panel");
  if (!panel) return;
  const isCollapsed = forceState !== null ? forceState : !panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed", isCollapsed);
  const btn = document.getElementById("btn-toggle-inspector-collapse");
  if (btn) {
    btn.textContent = isCollapsed ? "▶" : "◀";
    btn.title = isCollapsed ? "Expand Inspector Panel" : "Collapse Inspector Panel";
  }
}

function resetDspToNeutral() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex]);

  targets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.pitch_shift = 0.0;
    b.warmth = 0.0;
    b.clarity = 0.0;
    b.reverb = 0.0;
    if (b.character_id) {
      b.is_custom_edited = true;
    }
  });
  renderInspector();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  recordHistory("Reset Tone to Neutral");
  showToast("↺ Voice tone reset to neutral");
}

window.switchInspectorTab = switchInspectorTab;
window.toggleInspectorCollapse = toggleInspectorCollapse;
window.resetDspToNeutral = resetDspToNeutral;
window.openEditCharacterModal = openEditCharacterModal;
window.handleApplyVoiceAndSettingsToSelected = handleApplyVoiceAndSettingsToSelected;
window.revertActiveBlockToCharacter = revertActiveBlockToCharacter;
window.pullActiveSentenceToCharModal = pullActiveSentenceToCharModal;
window.selectCharModalFilter = selectCharModalFilter;
window.updateActiveCharacterStatusBanner = updateActiveCharacterStatusBanner;
window.reorderBlock = reorderBlock;
window.moveBlockUp = moveBlockUp;
window.moveBlockDown = moveBlockDown;
window.handleDashboardSearch = handleDashboardSearch;
window.clearDashboardSearch = clearDashboardSearch;
window.setDashboardFilter = setDashboardFilter;
window.handleDashboardSort = handleDashboardSort;
window.setDashboardLayout = setDashboardLayout;
window.loadSampleStoryIntoProject = loadSampleStoryIntoProject;
window.toggleDashboardPreview = toggleDashboardPreview;
window.handleDuplicateProject = handleDuplicateProject;
window.handleRenameProject = handleRenameProject;
window.toggleExportDropdown = toggleExportDropdown;
window.closeExportDropdown = closeExportDropdown;
window.updateExportDropdownUI = updateExportDropdownUI;
window.exportSelectedAudio = exportSelectedAudio;
window.handleExportSelectedFromMenu = handleExportSelectedFromMenu;
window.handleExportMasterFromMenu = handleExportMasterFromMenu;
window.handleExportZipFromMenu = handleExportZipFromMenu;
window.handleExportProjectJson = handleExportProjectJson;


