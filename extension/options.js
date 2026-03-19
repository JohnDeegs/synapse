// options.js

// --- Tab switching ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --- Helpers ---
function setMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + type;
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : btn.dataset.label;
}

async function callAuth(apiBase, path, email, password) {
  const url = apiBase.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Show logged-in state ---
function showLoggedIn(email) {
  document.getElementById('auth-section').style.display = 'none';
  const section = document.getElementById('logged-in-section');
  section.style.display = 'block';
  document.getElementById('logged-in-email').textContent = email;
}

function showAuthForms() {
  document.getElementById('logged-in-section').style.display = 'none';
  document.getElementById('auth-section').style.display = 'block';
}

// --- Init: check existing session ---
chrome.storage.local.get(['token', 'apiBase', 'email'], ({ token, apiBase, email }) => {
  if (token && apiBase) {
    showLoggedIn(email || 'unknown');
  }
  // Pre-fill API base URL fields from storage
  if (apiBase) {
    document.getElementById('login-api').value = apiBase;
    document.getElementById('reg-api').value = apiBase;
  }
});

// --- Login ---
const loginBtn = document.getElementById('login-btn');
loginBtn.dataset.label = 'Log in';
loginBtn.addEventListener('click', async () => {
  const apiBase = document.getElementById('login-api').value.trim();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const msgEl = document.getElementById('login-msg');

  if (!apiBase || !email || !password) {
    setMsg(msgEl, 'All fields are required.', 'error');
    return;
  }

  setLoading(loginBtn, true);
  setMsg(msgEl, '', '');
  try {
    const { token } = await callAuth(apiBase, '/auth/login', email, password);
    chrome.storage.local.set({ token, apiBase, email }, () => {
      setMsg(msgEl, 'Logged in!', 'success');
      showLoggedIn(email);
    });
  } catch (err) {
    setMsg(msgEl, err.message, 'error');
  } finally {
    setLoading(loginBtn, false);
  }
});

// --- Register ---
const registerBtn = document.getElementById('register-btn');
registerBtn.dataset.label = 'Create account';
registerBtn.addEventListener('click', async () => {
  const apiBase = document.getElementById('reg-api').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const msgEl = document.getElementById('register-msg');

  if (!apiBase || !email || !password) {
    setMsg(msgEl, 'All fields are required.', 'error');
    return;
  }

  setLoading(registerBtn, true);
  setMsg(msgEl, '', '');
  try {
    const { token } = await callAuth(apiBase, '/auth/register', email, password);
    chrome.storage.local.set({ token, apiBase, email }, () => {
      setMsg(msgEl, 'Account created and logged in!', 'success');
      showLoggedIn(email);
    });
  } catch (err) {
    setMsg(msgEl, err.message, 'error');
  } finally {
    setLoading(registerBtn, false);
  }
});

// --- Logout ---
document.getElementById('logout-btn').addEventListener('click', () => {
  chrome.storage.local.remove(['token', 'apiBase', 'email'], () => {
    showAuthForms();
    setMsg(document.getElementById('login-msg'), '', '');
  });
});

// ── Quiet Hours ────────────────────────────────────────────────────────────

function buildHourOptions(selectEl) {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = h;
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    opt.textContent = `${h12}:00 ${h < 12 ? 'AM' : 'PM'}`;
    selectEl.appendChild(opt);
  }
}

buildHourOptions(document.getElementById('quiet-start'));
buildHourOptions(document.getElementById('quiet-end'));

// Load quiet hours from API, fall back to local cache
chrome.storage.local.get(['token', 'apiBase', 'quietEnabled', 'quietStart', 'quietEnd'],
  async ({ token, apiBase, quietEnabled, quietStart, quietEnd }) => {
    const enabledEl = document.getElementById('quiet-enabled');
    const rangeEl   = document.getElementById('quiet-range');

    if (token && apiBase) {
      try {
        const res = await fetch(`${apiBase.replace(/\/$/, '')}/settings`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const s = await res.json();
          quietEnabled = s.quiet_enabled !== 0;
          quietStart   = s.quiet_start;
          quietEnd     = s.quiet_end;
          chrome.storage.local.set({ quietEnabled, quietStart, quietEnd });
        }
      } catch {}
    }

    enabledEl.checked = quietEnabled !== false;
    document.getElementById('quiet-start').value = quietStart !== undefined ? quietStart : 23;
    document.getElementById('quiet-end').value   = quietEnd   !== undefined ? quietEnd   : 7;
    rangeEl.style.display = enabledEl.checked ? 'block' : 'none';
  }
);

document.getElementById('quiet-enabled').addEventListener('change', function () {
  document.getElementById('quiet-range').style.display = this.checked ? 'block' : 'none';
});

const quietSaveBtn = document.getElementById('quiet-save-btn');
quietSaveBtn.addEventListener('click', () => {
  const enabled = document.getElementById('quiet-enabled').checked;
  const start   = parseInt(document.getElementById('quiet-start').value, 10);
  const end     = parseInt(document.getElementById('quiet-end').value, 10);
  const msgEl   = document.getElementById('quiet-msg');

  chrome.storage.local.get(['token', 'apiBase'], async ({ token, apiBase }) => {
    setLoading(quietSaveBtn, true);
    try {
      if (token && apiBase) {
        const res = await fetch(`${apiBase.replace(/\/$/, '')}/settings`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ quiet_enabled: enabled, quiet_start: start, quiet_end: end })
        });
        if (!res.ok) throw new Error('Save failed');
      }
      chrome.storage.local.set({ quietEnabled: enabled, quietStart: start, quietEnd: end }, () => {
        setLoading(quietSaveBtn, false);
        setMsg(msgEl, 'Saved.', 'success');
      });
    } catch (err) {
      setLoading(quietSaveBtn, false);
      setMsg(msgEl, err.message, 'error');
    }
  });
});
