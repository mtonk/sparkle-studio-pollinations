const DEFAULTS = { model: 'flux' };

function updateAccountUI(user) {
  const status = document.getElementById('account-status');
  const loginBtn = document.getElementById('btn-login');
  const logoutBtn = document.getElementById('btn-logout');
  const nameSpan = status.querySelector('.account-name');
  const detailSpan = status.querySelector('.account-detail');

  if (user && user.preferred_username) {
    status.classList.remove('not-logged-in');
    status.classList.add('logged-in');
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    nameSpan.textContent = user.preferred_username;
    detailSpan.textContent = user.name ? `${user.name} — logged in` : 'Logged in';
  } else {
    status.classList.remove('logged-in');
    status.classList.add('not-logged-in');
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    nameSpan.textContent = 'Not logged in';
    detailSpan.textContent = 'Free tier — text-to-image only';
  }
}

function loginWithPollinations() {
  const state = Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem('byop-state', state);
  const redirectUri = window.location.origin + '/auth/callback';
  const params = new URLSearchParams({ redirect_uri: redirectUri, scope: 'usage profile', state });
  window.location.href = `https://enter.pollinations.ai/authorize?${params}`;
}

document.getElementById('btn-login').addEventListener('click', loginWithPollinations);
document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'DELETE' });
  updateAccountUI(null);
  refreshModelList();
});

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sparkle-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

function saveSettings(settings) {
  localStorage.setItem('sparkle-settings', JSON.stringify(settings));
}

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

    label.textContent = data.authenticated
      ? 'Free and premium models — your pollen used for premium.'
      : 'Free models — log in for more.';

    if (currentVal && [...select.options].some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

// --- Init ---
const settings = loadSettings();
const select = document.getElementById('model-select');
if (settings.model) select.value = settings.model;

(async function init() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.loggedIn && data.user) {
      updateAccountUI(data.user);
    }
  } catch (err) {
    console.error('Session check failed:', err);
  }
  await refreshModelList();
})();

// --- Save ---
document.getElementById('btn-save').addEventListener('click', () => {
  const model = document.getElementById('model-select').value;
  saveSettings({ model });
  const confirm = document.getElementById('save-confirm');
  confirm.classList.remove('hidden');
  setTimeout(() => confirm.classList.add('hidden'), 2000);
});