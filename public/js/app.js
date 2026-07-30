// --- Login state (managed server-side via session) ---

async function fetchSession() {
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (err) {
    console.error('Session check failed:', err);
  }
  return { loggedIn: false };
}

function updateAccountUI(user) {
  const status = document.getElementById('account-status');
  const loginBtn = document.getElementById('btn-login');
  const logoutBtn = document.getElementById('btn-logout');
  const nameSpan = status.querySelector('.account-name');
  const detailSpan = status.querySelector('.account-detail');

  const loggedIn = user && user.preferred_username;

  if (loggedIn) {
    status.classList.remove('not-logged-in');
    status.classList.add('logged-in');
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    nameSpan.textContent = user.preferred_username;
    detailSpan.textContent = user.name ? `${user.name} — logged in` : 'Logged in';
    if (user.picture) {
      const container = status.querySelector('.account-avatar');
      // Build the node instead of interpolating into innerHTML, and only accept
      // https URLs — user.picture comes from the OAuth provider's userinfo and
      // must not be trusted as markup.
      if (container && /^https:\/\//.test(user.picture)) {
        container.innerHTML = '';
        const img = document.createElement('img');
        img.src = user.picture;
        img.alt = '';
        img.className = 'account-avatar-img';
        container.appendChild(img);
      }
    }
    refreshModelList();
  } else {
    status.classList.remove('logged-in');
    status.classList.add('not-logged-in');
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    nameSpan.textContent = 'Not logged in';
    detailSpan.textContent = 'Free tier — text-to-image only';
    const container = status.querySelector('.account-avatar');
    if (container) container.innerHTML = '<i data-lucide="user"></i>';
    refreshModelList();
  }

  const overlay = document.getElementById('canvas-login-overlay');
  if (overlay) {
    if (loggedIn) {
      overlay.classList.add('hidden');
    } else {
      overlay.classList.remove('hidden');
    }
  }
}

// Hook canvas login button
document.addEventListener('click', (e) => {
  if (e.target.closest('.canvas-login-btn')) {
    loginWithPollinations();
  }
});

async function refreshModelList() {
  const select = document.getElementById('model-select');
  const label = document.getElementById('model-tier-label');
  const currentVal = select.value;

  try {
    const res = await fetch('/api/models');
    const data = await res.json();

    select.innerHTML = '';
    data.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      let l = m.name;
      if (m.tier === 'free') l += ' (free)';
      opt.textContent = l;
      select.appendChild(opt);
    });

    if (data.authenticated) {
      label.textContent = 'Free and premium models — your pollen used for premium.';
    } else {
      label.textContent = 'Free models — log in for more.';
    }

    if (currentVal && [...select.options].some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  } catch (err) {
    console.error('Failed to load models:', err);
    if (!select.options.length) {
      select.innerHTML = '<option value="flux">Flux</option>';
    }
  }
}

function loginWithPollinations() {
  const state = Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem('byop-state', state);

  const redirectUri = window.location.origin + '/auth/callback';
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    scope: 'usage profile',
    state: state,
  });

  window.location.href = `https://enter.pollinations.ai/authorize?${params}`;
}

// --- Settings modal ---
const SETTINGS_DEFAULTS = { model: 'flux' };

function loadSparkleSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('sparkle-settings') || '{}') }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}

function openSettingsModal() {
  const s = loadSparkleSettings();
  const select = document.getElementById('model-select');

  // Set saved model if available
  if (s.model && [...select.options].some(o => o.value === s.model)) {
    select.value = s.model;
  }

  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
document.getElementById('btn-settings-close').addEventListener('click', closeSettingsModal);
document.querySelector('.settings-modal-backdrop').addEventListener('click', closeSettingsModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsModal(); });

document.getElementById('modal-btn-save').addEventListener('click', () => {
  const model = document.getElementById('model-select').value;
  localStorage.setItem('sparkle-settings', JSON.stringify({ model }));
  closeSettingsModal();
});

document.getElementById('btn-login').addEventListener('click', loginWithPollinations);

document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'DELETE' });
  updateAccountUI(null);
  refreshModelList();
});

// --- Canvas setup ---
const canvas = new fabric.Canvas('drawing-canvas', {
  isDrawingMode: true,
  width: 520,
  height: 480,
  backgroundColor: '#ffffff',
});

canvas.freeDrawingBrush.color = '#000000';
canvas.freeDrawingBrush.width = 4;

function resizeCanvas() {
  const maxWidth = Math.min(window.innerWidth - 48, 520);
  if (maxWidth < 520) {
    const scale = maxWidth / 520;
    canvas.setWidth(maxWidth);
    canvas.setHeight(480 * scale);
    canvas.setZoom(scale);
  }
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// --- History (undo/redo) ---
const history = [canvas.toJSON()];
let historyIndex = 0;
let restoringState = false;

function saveState() {
  if (restoringState) return;
  history.splice(historyIndex + 1);
  history.push(canvas.toJSON());
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = historyIndex <= 0;
  document.getElementById('btn-redo').disabled = historyIndex >= history.length - 1;
}

canvas.on('path:created', saveState);
canvas.on('object:added', saveState);
canvas.on('object:modified', saveState);
canvas.on('object:removed', saveState);

document.getElementById('btn-undo').addEventListener('click', () => {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoringState = true;
  canvas.loadFromJSON(history[historyIndex], () => {
    canvas.renderAll();
    restoringState = false;
    updateHistoryButtons();
  });
});

document.getElementById('btn-redo').addEventListener('click', () => {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoringState = true;
  canvas.loadFromJSON(history[historyIndex], () => {
    canvas.renderAll();
    restoringState = false;
    updateHistoryButtons();
  });
});

// --- Toolbar ---
const colorPicker = document.getElementById('color-picker');
const brushSize = document.getElementById('brush-size');

let eraserActive = false;
let fillHandler = null;

colorPicker.addEventListener('input', () => {
  if (!eraserActive) canvas.freeDrawingBrush.color = colorPicker.value;
});

brushSize.addEventListener('input', () => {
  const size = parseInt(brushSize.value);
  canvas.freeDrawingBrush.width = eraserActive ? size * 3 : size;
});

function setActiveTool(id) {
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(id);
  if (btn) btn.classList.add('active');
  if (id !== 'btn-eraser' && eraserActive) {
    eraserActive = false;
    canvas.freeDrawingBrush.color = colorPicker.value;
    canvas.freeDrawingBrush.width = parseInt(brushSize.value);
  }
  if (id !== 'btn-fill' && fillHandler) {
    canvas.off('mouse:down', fillHandler);
    fillHandler = null;
  }
}

document.getElementById('btn-pencil').addEventListener('click', () => {
  canvas.isDrawingMode = true;
  setActiveTool('btn-pencil');
});

document.getElementById('btn-circle').addEventListener('click', () => {
  canvas.isDrawingMode = false;
  setActiveTool('btn-circle');
  const circle = new fabric.Circle({
    left: 180, top: 160, radius: 60,
    fill: 'transparent', stroke: colorPicker.value, strokeWidth: parseInt(brushSize.value),
  });
  canvas.add(circle);
  canvas.setActiveObject(circle);
});

document.getElementById('btn-rect').addEventListener('click', () => {
  canvas.isDrawingMode = false;
  setActiveTool('btn-rect');
  const rect = new fabric.Rect({
    left: 160, top: 160, width: 120, height: 80,
    fill: 'transparent', stroke: colorPicker.value, strokeWidth: parseInt(brushSize.value),
  });
  canvas.add(rect);
  canvas.setActiveObject(rect);
});

document.getElementById('btn-heart').addEventListener('click', () => {
  canvas.isDrawingMode = false;
  setActiveTool('btn-heart');
  const heart = new fabric.Path(
    'M 0 -30 C 5 -60 50 -60 50 -20 C 50 10 25 35 0 60 C -25 35 -50 10 -50 -20 C -50 -60 -5 -60 0 -30 Z',
    { left: 260, top: 240, originX: 'center', originY: 'center',
      fill: 'transparent', stroke: colorPicker.value, strokeWidth: parseInt(brushSize.value) }
  );
  canvas.add(heart);
  canvas.setActiveObject(heart);
});

document.getElementById('btn-eraser').addEventListener('click', () => {
  canvas.isDrawingMode = true;
  eraserActive = true;
  canvas.freeDrawingBrush.color = '#ffffff';
  canvas.freeDrawingBrush.width = parseInt(brushSize.value) * 3;
  setActiveTool('btn-eraser');
});

document.getElementById('btn-fill').addEventListener('click', () => {
  canvas.isDrawingMode = false;
  setActiveTool('btn-fill');
  fillHandler = (opt) => {
    const target = opt.target;
    if (target) {
      target.set('fill', colorPicker.value);
      canvas.renderAll();
    } else {
      canvas.setBackgroundColor(colorPicker.value, canvas.renderAll.bind(canvas));
    }
    saveState();
  };
  canvas.on('mouse:down', fillHandler);
});

document.getElementById('btn-clear').addEventListener('click', () => {
  canvas.clear();
  canvas.setBackgroundColor('#ffffff', canvas.renderAll.bind(canvas));
  history.splice(0, history.length, canvas.toJSON());
  historyIndex = 0;
  updateHistoryButtons();
  descriptionTextarea.value = '';
  lastCanvasSnapshot = '';
  textDirty = false;
  resultImage.src = '';
  resultImage.style.display = 'none';
  saveBtn.style.display = 'none';
  if (placeholderText) placeholderText.style.display = '';
});

// --- Reference image search ---
const searchInput = document.getElementById('search-input');
const btnSearch = document.getElementById('btn-search');
const referenceGrid = document.getElementById('reference-grid');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  btnSearch.disabled = true;
  btnSearch.textContent = '...';
  referenceGrid.innerHTML = '<p class="placeholder-text">Searching...</p>';

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const images = await res.json();

    if (!images.length) {
      referenceGrid.innerHTML = '<p class="placeholder-text">No results found.</p>';
      return;
    }

    referenceGrid.innerHTML = '';
    images.forEach(({ thumb, full, credit }) => {
      const img = document.createElement('img');
      img.src = thumb;
      img.alt = credit ? `Photo by ${credit}` : 'Reference image';
      img.title = img.alt;
      img.addEventListener('click', () => {
        lightboxImg.src = full;
        lightbox.classList.remove('hidden');
      });
      referenceGrid.appendChild(img);
    });
  } catch (err) {
    console.error(err);
    referenceGrid.innerHTML = '<p class="placeholder-text">Search failed. Try again.</p>';
  } finally {
    btnSearch.disabled = false;
    btnSearch.textContent = 'Search';
  }
}

btnSearch.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

document.querySelector('.lightbox-backdrop').addEventListener('click', () => {
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
});

// --- Generate ---
const generateBtn = document.getElementById('btn-generate');
const resultImage = document.getElementById('result-image');
const placeholderText = document.querySelector('#result .placeholder-text');
const descriptionTextarea = document.getElementById('jewelry-description');
const saveBtn = document.getElementById('btn-save');
let lastCanvasSnapshot = '';
let textDirty = false;

descriptionTextarea.addEventListener('input', () => { textDirty = true; });

function descriptionToFilename(desc) {
  return (desc || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-') || 'sparkle-jewelry';
}

const RESOLVE_TIMEOUT_MS = 60000;
const GENERATE_TIMEOUT_MS = 120000;

async function postJson(url, body, timeoutMs, timeoutMessage) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new Error(timedOut ? timeoutMessage : 'Could not reach the server. Is it still running?');
  }

  if (!res.ok) {
    let message = '';
    try { message = (await res.json()).error; } catch {}
    throw new Error(message || `The server had a problem (${res.status}). Try again!`);
  }

  return res.json();
}

generateBtn.addEventListener('click', async () => {
  const description = descriptionTextarea.value.trim();
  const hasDrawing = canvas.getObjects().length > 0;

  if (!description && !hasDrawing) {
    alert('Draw something or describe your jewelry first!');
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = 'Thinking...';

  let sparkleSettings = { model: 'flux' };
  try { sparkleSettings = { ...sparkleSettings, ...JSON.parse(localStorage.getItem('sparkle-settings') || '{}') }; } catch {}

  const canvasSnapshot = JSON.stringify(canvas.toJSON());
  const sketchDirty = hasDrawing && canvasSnapshot !== lastCanvasSnapshot;

  try {
    let promptBody;
    if (hasDrawing && sketchDirty) {
      generateBtn.textContent = 'Analyzing your drawing...';
      const promptData = await postJson(
        '/api/resolve-prompt',
        { imageData: canvas.toDataURL({ format: 'png' }), description },
        RESOLVE_TIMEOUT_MS,
        'Reading your drawing took too long. Try again!',
      );

      if (promptData.description) {
        descriptionTextarea.value = promptData.description;
      }
      lastCanvasSnapshot = canvasSnapshot;
      textDirty = false;

      promptBody = {
        prompt: promptData.prompt,
        description: promptData.description,
        filename: promptData.filename,
        model: sparkleSettings.model,
      };
    } else if (hasDrawing) {
      promptBody = { description, model: sparkleSettings.model };
    } else {
      promptBody = { description, model: sparkleSettings.model };
    }

    generateBtn.textContent = 'Sprinkling sparkles...';
    const genData = await postJson('/api/generate', promptBody, GENERATE_TIMEOUT_MS, 'Making the picture took too long. Try again!');

    if (genData.imageUrl) {
      resultImage.src = genData.imageUrl;
      resultImage.style.display = 'block';
      if (placeholderText) placeholderText.style.display = 'none';
      saveBtn.href = genData.imageUrl;
      saveBtn.download = (genData.filename || descriptionToFilename(genData.description || descriptionTextarea.value)) + '.png';
      saveBtn.style.display = 'inline-flex';
      if (genData.description && !sketchDirty) descriptionTextarea.value = genData.description;
    } else {
      alert(genData.error || 'Something went wrong. Try again!');
    }
  } catch (err) {
    console.error(err);
    alert(err.message || 'Could not connect to the server.');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Make it Sparkle!';
  }
});

// --- Init ---
(async function init() {
  try {
    const session = await fetchSession();
    if (session.loggedIn && session.user) {
      updateAccountUI(session.user);
    } else {
      updateAccountUI(null);
    }
    refreshModelList();
  } catch (err) {
    console.error('init error:', err);
  }
  lucide.createIcons();
})();
