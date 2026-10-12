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
  config: { remote_worker_url: "", active: false }
};

// ---------------- INITIALIZATION ---------------- //

async function initApp() {
  try {
    await loadVoices();
    await loadProjectsList();
    await loadConfig();
    setupEventListeners();
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

async function openProject(projectId) {
  try {
    const res = await fetch(`/api/project?id=${encodeURIComponent(projectId)}&t=${Date.now()}`);
    state.currentProject = await res.json();
    state.activeBlockIndex = 0;
    state.selectedBlockIndices = new Set([0]);
    state.lastClickedIndex = 0;
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
    switchToView("studio");
    renderStudio();
  } catch (err) {
    alert("Failed to load project: " + err);
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
  let blendStr = "";
  if (block.blend_weights) {
    blendStr = Object.entries(block.blend_weights).sort().map(([k, v]) => `${k}:${Number(v).toFixed(2)}`).join(",");
  }
  return `${text}__${voice}__${blendStr}__${speed}__${gain}`;
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

// ---------------- VIEW ROUTING ---------------- //

function switchToView(viewName) {
  state.currentView = viewName;
  const dashEl = document.getElementById("view-dashboard");
  const studioEl = document.getElementById("view-studio");

  if (viewName === "dashboard") {
    dashEl.style.display = "flex";
    studioEl.style.display = "none";
    loadProjectsList();
  } else {
    dashEl.style.display = "none";
    studioEl.style.display = "flex";
  }
}

// ---------------- VIEW 1: DASHBOARD RENDERING ---------------- //

function renderDashboard() {
  const grid = document.getElementById("projects-grid");
  grid.innerHTML = "";

  document.getElementById("dashboard-project-count").textContent = 
    `${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`;

  // 1. "Create New Project" Card
  const newCard = document.createElement("div");
  newCard.className = "project-card project-card-new";
  newCard.innerHTML = `
    <div class="new-icon">＋</div>
    <div style="font-weight: 700; font-size: 15px; color: #fff;">Create New Story Project</div>
    <div style="font-size: 12px; color: var(--text-subtle);">Type or paste a manuscript to auto-chunk</div>
  `;
  newCard.addEventListener("click", () => {
    openNewProjectModal();
  });
  grid.appendChild(newCard);

  // 1b. "Import Story File" Card
  const importCard = document.createElement("div");
  importCard.className = "project-card project-card-import";
  importCard.innerHTML = `
    <div class="import-icon">📥</div>
    <div style="font-weight: 700; font-size: 15px; color: #fff;">Import Story File</div>
    <div style="font-size: 12px; color: var(--text-subtle);">Click or drop .txt, .md, or project .json</div>
  `;
  importCard.addEventListener("click", () => {
    document.getElementById("dashboard-file-input")?.click();
  });
  importCard.addEventListener("dragover", (e) => {
    e.preventDefault();
    importCard.classList.add("drag-over");
  });
  importCard.addEventListener("dragleave", () => {
    importCard.classList.remove("drag-over");
  });
  importCard.addEventListener("drop", (e) => {
    e.preventDefault();
    importCard.classList.remove("drag-over");
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      processImportedFile(e.dataTransfer.files[0], "dashboard");
    }
  });
  grid.appendChild(importCard);

  // 2. Existing Project Cards
  state.projects.forEach(p => {
    const card = document.createElement("div");
    card.className = "project-card";
    const dateStr = p.updated_at ? new Date(p.updated_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Recently";

    card.innerHTML = `
      <div>
        <div class="project-card-title">${p.title}</div>
        <div class="project-meta-pills">
          <span class="meta-pill">📝 ${p.block_count} Sentences</span>
          <span class="meta-pill">⏱ ${dateStr}</span>
        </div>
      </div>
      <div class="project-card-footer">
        <button class="btn btn-primary open-proj-btn" style="padding: 6px 14px;">Open in Studio →</button>
        <button class="icon-btn delete-proj-btn" title="Delete project" style="color: var(--text-subtle);">🗑</button>
      </div>
    `;

    card.querySelector(".open-proj-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openProject(p.id);
    });

    card.addEventListener("click", () => {
      openProject(p.id);
    });

    card.querySelector(".delete-proj-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Delete project "${p.title}"?`)) {
        await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
        loadProjectsList();
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

function renderBlocks() {
  const container = document.getElementById("story-container");
  container.innerHTML = "";

  state.currentProject.blocks.forEach((block, idx) => {
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

    // SENTENCE BLOCK WITH AUDIO SCRUBBER & SLEEK CUSTOM CHECKBOX
    row.innerHTML = `
      <button class="block-select-btn" data-index="${idx}" title="${isSelected ? 'Deselect sentence' : 'Select sentence'}">
        <span class="custom-chk-box"></span>
      </button>
      <button class="block-voice-btn" title="Voice: ${voice.name} (Click to change)">
        <div class="block-avatar" style="background-color: ${voice.color}">
          ${voice.badge || voice.id.slice(0, 2).toUpperCase()}
        </div>
      </button>
      <div class="block-content-col">
        <textarea class="block-textarea" placeholder="Type sentence here...">${block.text}</textarea>
        <div class="block-audio-scrubber" title="Click anywhere to jump & listen from this point">
          <div class="scrubber-track">
            <div class="scrubber-fill"></div>
          </div>
          <span class="scrubber-time">${durText}</span>
        </div>
      </div>
      <div class="block-actions">
        <button class="play-block-btn" title="Play sentence (or Space)">${isPlaying ? "🔊" : "▶"}</button>
        <button class="delete-block-btn" onclick="deleteBlock(${idx})" title="Delete sentence">✕</button>
      </div>
    `;

    container.appendChild(row);

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
      if (!state.selectedBlockIndices.has(idx)) {
        selectBlock(idx, "single");
      } else {
        state.activeBlockIndex = idx;
        renderInspector();
        highlightTimelineBlock(idx);
        updateActiveSentenceHint(idx);
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
  const rows = document.querySelectorAll(".block-row");
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

  const newVoiceId = activeBlock.voice_id || "blend_fenrir_onyx";
  const newBlendWeights = activeBlock.blend_weights ? JSON.parse(JSON.stringify(activeBlock.blend_weights)) : null;
  const voiceObj = getVoiceById(newVoiceId);

  state.currentProject.default_voice = newVoiceId;

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

  const remaining = state.currentProject.blocks.filter((_, idx) => !state.selectedBlockIndices.has(idx));
  if (remaining.length === 0) {
    state.currentProject.blocks = [{
      id: "b_1",
      text: "Type sentence here...",
      voice_id: state.currentProject.default_voice || "blend_fenrir_onyx",
      speed: 0.90,
      gain: 1.0,
      pause_after: 0.6
    }];
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

function handleApplyVoiceToAll() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const voice = getVoiceById(activeBlock.voice_id);
  const total = state.currentProject.blocks.length;

  state.currentProject.blocks.forEach(b => {
    b.voice_id = activeBlock.voice_id;
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
  });

  renderStudio();
  debouncedSave();
  showToast(`🎭 Applied voice "${voice.name}" to all ${total} sentences!`);
}

function handleApplyPacingToAll() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const gainVal = activeBlock.gain || 1.0;
  const speedVal = activeBlock.speed || 0.90;
  const pauseVal = activeBlock.pause_after || 0.6;
  const total = state.currentProject.blocks.length;

  state.currentProject.blocks.forEach(b => {
    b.gain = gainVal;
    b.speed = speedVal;
    b.pause_after = pauseVal;
    delete b.cachedAudioUrl;
    delete b.cachedSig;
  });

  renderStudio();
  debouncedSave();
  showToast(`⚡ Applied pacing (${speedVal}x speed, ${Math.round(gainVal * 100)}% vol) to all ${total} sentences!`);
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
        expand_dialogue: true
      })
    });

    const directedBlocks = await res.json();
    if (!Array.isArray(directedBlocks) || directedBlocks.length === 0) {
      showToast("⚠️ No changes made to story blocks.");
      return;
    }

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
    voice_id: defVoice,
    speed: 0.90,
    gain: 1.0,
    pause_after: 0.6,
    clearBlend: false
  };

  switch (presetKey) {
    case "narrator":
      presetConfig = {
        name: "Narrator",
        voice_id: defVoice,
        speed: 0.90,
        gain: 1.0,
        pause_after: 0.6,
        clearBlend: false
      };
      break;
    case "whisper":
      presetConfig = {
        name: "Soft Whisper",
        voice_id: "af_river",
        speed: 0.80,
        gain: 0.75,
        pause_after: 1.0,
        clearBlend: true
      };
      break;
    case "intense":
      presetConfig = {
        name: "Intense Scream",
        voice_id: "am_fenrir",
        speed: 1.04,
        gain: 1.15,
        pause_after: 0.8,
        clearBlend: true
      };
      break;
    case "female":
      presetConfig = {
        name: "Female Dialogue",
        voice_id: "af_heart",
        speed: 0.86,
        gain: 1.0,
        pause_after: 0.8,
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
        clearBlend: true
      };
      break;
  }

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.voice_id = presetConfig.voice_id;
    block.speed = presetConfig.speed;
    block.gain = presetConfig.gain;
    block.pause_after = presetConfig.pause_after;
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
  const selectedList = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
  if (selectedList.length === 0) return;

  const btnBulkRender = document.getElementById("btn-bulk-render");
  if (btnBulkRender) {
    btnBulkRender.textContent = `⏳ Rendering (0/${selectedList.length})...`;
    btnBulkRender.disabled = true;
  }

  let completed = 0;
  for (let idx of selectedList) {
    const block = state.currentProject.blocks[idx];
    if (!block) continue;
    const row = document.querySelectorAll(".block-row")[idx];
    const currentSig = getBlockSignature(block);

    if (btnBulkRender) {
      btnBulkRender.textContent = `⏳ Rendering (${completed + 1}/${selectedList.length})...`;
    }

    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
      if (row) row.classList.add("ready");
      completed++;
      continue;
    }

    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
          gain: block.gain || 1.0
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
          if (timeText && data.duration) timeText.textContent = `${data.duration.toFixed(1)}s`;
        }
      }
    } catch (err) {
      console.error("Bulk render error on block", idx, err);
      if (row) row.classList.remove("processing");
    }
    completed++;
    await new Promise(r => setTimeout(r, 60));
  }

  if (btnBulkRender) {
    btnBulkRender.disabled = false;
    btnBulkRender.textContent = `✓ Selected Rendered!`;
    setTimeout(() => {
      updateSelectionUI();
    }, 2500);
  }
  renderTimeline();
  showToast(`✓ Finished rendering ${selectedList.length} sentence(s)!`);
}

function updateActiveSentenceHint(idx) {
  const hintEl = document.getElementById("player-active-sentence-hint");
  if (!hintEl || !state.currentProject || !state.currentProject.blocks) return;
  const block = state.currentProject.blocks[idx];
  if (!block) return;
  const total = state.currentProject.blocks.length;
  hintEl.textContent = `Sentence ${idx + 1}/${total}: "${block.text.slice(0, 55)}${block.text.length > 55 ? '...' : ''}"`;
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

  // Inspector voice card
  const avatar = document.getElementById("inspector-voice-avatar");
  if (avatar) {
    avatar.style.backgroundColor = voice.color || "#6366f1";
    avatar.textContent = voice.badge || (voice.id ? voice.id.slice(0, 2).toUpperCase() : "VO");
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
}

function renderTimeline() {
  const container = document.getElementById("timeline-blocks");
  if (!container) return;
  container.innerHTML = "";

  if (!state.currentProject || !state.currentProject.blocks) return;

  state.currentProject.blocks.forEach((block, idx) => {
    const voice = getVoiceById(block.voice_id);
    const item = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isReady = !!(block.cachedAudioUrl && block.cachedSig === currentSig);
    const isActive = state.activeBlockIndex === idx;
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const row = document.querySelectorAll(".block-row")[idx];
    const isProcessing = row ? row.classList.contains("processing") : false;

    item.className = `timeline-block-item ${isReady ? "ready" : "pending"} ${isProcessing ? "processing" : ""} ${isActive ? "active" : ""} ${isPlaying ? "playing" : ""}`;
    item.style.backgroundColor = voice.color;
    item.textContent = block.text.slice(0, 25) + (block.text.length > 25 ? "..." : "");
    item.title = `Sentence ${idx + 1} [${isReady ? 'Ready' : 'Draft'} • ${voice.name}]: ${block.text}`;

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
      elapsedSec += b.duration || ((b.text || "").trim().split(/\s+/).length / 2.8 / (b.speed || 0.9));
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
  if (!nextBlock.text || !nextBlock.text.trim()) return;
  const sig = getBlockSignature(nextBlock);
  if (nextBlock.cachedAudioUrl && nextBlock.cachedSig === sig) return;

  const nextRow = document.querySelectorAll(".block-row")[nextIdx];

  fetch("/api/synthesize_block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: nextBlock.text,
      voice_id: nextBlock.voice_id,
      blend_weights: nextBlock.blend_weights,
      speed: nextBlock.speed || 0.90,
      gain: nextBlock.gain || 1.0
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
  const allRows = document.querySelectorAll(".block-row");
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
  if (!block || !block.text.trim()) {
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

  const row = document.querySelectorAll(".block-row")[idx];
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

      const curRow = document.querySelectorAll(".block-row")[idx];
      if (curRow) {
        const fill = curRow.querySelector(".scrubber-fill");
        const timeText = curRow.querySelector(".scrubber-time");
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
        if (timeText) timeText.textContent = `${cur.toFixed(1)}s / ${dur.toFixed(1)}s`;
      }
      updateStoryTimeDisplay();
    };

    state.storyAudioPlayer.onended = () => {
      const curRow = document.querySelectorAll(".block-row")[idx];
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
        gain: block.gain || 1.0
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

// ---------------- SEQUENTIAL BATCH GENERATOR (1 BY 1) ---------------- //

async function toggleBatchRender() {
  const batchBtn = document.getElementById("btn-batch-generate");
  if (!state.currentProject || !state.currentProject.blocks.length) return;

  if (state.isBatchRunning) {
    state.isBatchRunning = false;
    if (batchBtn) {
      batchBtn.textContent = "⚡ Render All (1 by 1)";
      batchBtn.classList.remove("stopping");
    }
    return;
  }

  state.isBatchRunning = true;
  if (batchBtn) {
    batchBtn.classList.add("stopping");
  }

  const blocks = state.currentProject.blocks;
  const total = blocks.length;

  for (let i = 0; i < total; i++) {
    if (!state.isBatchRunning) break;

    const block = blocks[i];
    const row = document.querySelectorAll(".block-row")[i];
    const playBtn = row ? row.querySelector(".play-block-btn") : null;
    const currentSig = getBlockSignature(block);

    if (batchBtn) {
      batchBtn.textContent = `⏹ Stop (${i + 1}/${total})`;
    }

    // If already generated with matching signature, mark ready and move to next
    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
      if (row) {
        row.classList.add("ready");
        row.classList.remove("processing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText && block.duration) timeText.textContent = `● ${block.duration.toFixed(1)}s`;
      }
      continue;
    }

    // Highlight active sentence as processing
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      row.classList.add("processing");
      row.classList.remove("ready");
      if (playBtn) playBtn.textContent = "⏳";
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "⏳ Synthesizing...";
    }
    renderTimeline();

    try {
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: block.text,
          voice_id: block.voice_id,
          blend_weights: block.blend_weights,
          speed: block.speed || 0.90,
          gain: block.gain || 1.0
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
        updateStoryTimeDisplay();
        renderTimeline();
      }
    } catch (err) {
      console.error(`Error rendering block ${i}:`, err);
      if (row) {
        row.classList.remove("processing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
      if (playBtn) playBtn.textContent = "▶";
      renderTimeline();
    }

    // Small delay between blocks
    await new Promise(r => setTimeout(r, 80));
  }

  state.isBatchRunning = false;
  if (batchBtn) {
    batchBtn.classList.remove("stopping");
    batchBtn.textContent = "✓ All Rendered!";
    setTimeout(() => {
      batchBtn.textContent = "⚡ Render All (1 by 1)";
    }, 3000);
  }
  renderTimeline();
  showToast("✓ All sentences rendered and ready for playback!");
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
  });

  renderStudio();
  debouncedSave();
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
            openProject(newProj.id);
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

  try {
    const res = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, text, default_voice: defaultVoice })
    });

    const newProj = await res.json();
    closeNewProjectModal();
    openProject(newProj.id);
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
  try {
    const res = await fetch("/api/split_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, default_voice: defaultVoice })
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

// ---------------- MASTER EXPORT ---------------- //

async function exportMasterAudio() {
  const exportBtn = document.getElementById("btn-export-master");
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Project has no sentences to export.");
    return;
  }
  if (exportBtn) {
    exportBtn.textContent = "⏳ Stitching Master Track...";
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
      if (exportBtn) exportBtn.textContent = "✓ Master Ready!";
      state.storyAudioPlayer.src = `${data.master_url}?t=${Date.now()}`;
      state.storyAudioPlayer.play().catch(() => {});

      // Download
      const a = document.createElement("a");
      a.href = data.master_url;
      a.download = data.filename || filename;
      a.click();
      showToast("🎬 Master WAV compiled and download started!");
    }
  } catch (err) {
    showToast("Export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.textContent = "🎬 Export Master WAV";
        exportBtn.disabled = false;
      }
    }, 2500);
  }
}

async function exportZipAudio() {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) {
    showToast("⚠️ No sentences to export.");
    return;
  }

  const exportBtn = document.getElementById("btn-export-zip");
  if (exportBtn) {
    exportBtn.textContent = "⏳ Packaging ZIP...";
    exportBtn.disabled = true;
  }

  try {
    const titleSlug = (state.currentProject.title || "story")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "story";
    const filename = `${titleSlug}_sentences.zip`;

    showToast("📦 Packaging individual sentence audio files into ZIP...");

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
      if (exportBtn) exportBtn.textContent = "✓ ZIP Ready!";
      const a = document.createElement("a");
      a.href = data.zip_url;
      a.download = data.filename || filename;
      a.click();
      showToast(`📦 Downloaded ZIP with ${data.file_count} individual sentence audio files!`);
    }
  } catch (err) {
    showToast("ZIP export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.textContent = "📦 Export Audio (ZIP)";
        exportBtn.disabled = false;
      }
    }, 2500);
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

  // Project title rename in Studio
  document.getElementById("project-title")?.addEventListener("input", (e) => {
    if (state.currentProject) {
      state.currentProject.title = e.target.value;
      debouncedSave();
    }
  });

  // Add Block button
  document.getElementById("btn-add-block")?.addEventListener("click", () => {
    if (!state.currentProject) return;
    const defVoice = state.currentProject.default_voice || "blend_fenrir_onyx";
    const newIdx = state.currentProject.blocks.length;
    state.currentProject.blocks.push({
      id: "b_" + (newIdx + 1),
      text: "New sentence...",
      voice_id: defVoice,
      speed: 0.90,
      gain: 1.0,
      pause_after: 0.6
    });
    renderStudio();
    selectBlock(newIdx, "single");
    debouncedSave();
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
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelectorAll(".block-row")[idx];
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
  });

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
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelectorAll(".block-row")[idx];
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    renderTimeline();
    debouncedSave();
  });

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
    });
    debouncedSave();
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

  // Keyboard shortcut: Space toggles story playback
  window.addEventListener("keydown", (e) => {
    if (["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space" && state.currentView === "studio") {
      e.preventDefault();
      handleMasterPlayToggle();
    }
  });

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

  const baseVoice = block.voice_id || state.currentProject.default_voice || "blend_fenrir_onyx";
  const baseSpeed = block.speed || 0.90;
  const baseGain = block.gain || 1.0;
  const basePause = block.pause_after || 0.6;
  const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : undefined;

  const newBlocks = sentences.map((sent, sIdx) => {
    const newB = {
      id: `${block.id || 'b'}_s${sIdx + 1}_${Date.now()}`,
      text: sent,
      voice_id: baseVoice,
      speed: baseSpeed,
      gain: baseGain,
      pause_after: basePause
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

  let totalSplits = 0;
  const newBlocksList = [];

  state.currentProject.blocks.forEach((block) => {
    const sentences = splitTextIntoSentences(block.text || "");
    if (sentences.length > 1) {
      totalSplits += (sentences.length - 1);
      const baseVoice = block.voice_id || state.currentProject.default_voice || "blend_fenrir_onyx";
      const baseSpeed = block.speed || 0.90;
      const baseGain = block.gain || 1.0;
      const basePause = block.pause_after || 0.6;
      const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : undefined;

      sentences.forEach((sent, sIdx) => {
        const nb = {
          id: `${block.id || 'b'}_s${sIdx + 1}_${Date.now()}`,
          text: sent,
          voice_id: baseVoice,
          speed: baseSpeed,
          gain: baseGain,
          pause_after: basePause
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
    showToast("⚠️ Project must have at least one sentence.");
    return;
  }
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
  showToast("✓ Sentence deleted.");
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
window.splitBlock = splitBlock;
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
