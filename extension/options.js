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
  const res = await fetch(apiBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Show logged-in state ---
function showLoggedIn(email, apiBase) {
  document.getElementById('auth-section').style.display = 'none';
  const section = document.getElementById('logged-in-section');
  section.style.display = 'block';
  document.getElementById('logged-in-email').textContent = email;
  document.getElementById('open-web').href = apiBase + '/web/';
}

function showAuthForms() {
  document.getElementById('logged-in-section').style.display = 'none';
  document.getElementById('auth-section').style.display = 'block';
}

// --- Init: check existing session ---
chrome.storage.local.get(['token', 'apiBase', 'email'], ({ token, apiBase, email }) => {
  if (token && apiBase) {
    showLoggedIn(email || 'unknown', apiBase);
  }
  // Pre-fill API base URL fields from storage
  if (apiBase) {
    document.getElementById('login-api').value = apiBase;
    document.getElementById('reg-api').value = apiBase;
  }
});

// --- Login / register ---
function wireAuth(btnId, label, path, prefix, msgId) {
  const btn = document.getElementById(btnId);
  btn.dataset.label = label;
  btn.addEventListener('click', async () => {
    const apiBase = document.getElementById(`${prefix}-api`).value.trim().replace(/\/+$/, '');
    const email = document.getElementById(`${prefix}-email`).value.trim();
    const password = document.getElementById(`${prefix}-password`).value;
    const msgEl = document.getElementById(msgId);

    if (!apiBase || !email || !password) {
      setMsg(msgEl, 'All fields are required.', 'error');
      return;
    }

    setLoading(btn, true);
    setMsg(msgEl, '', '');
    try {
      const { token } = await callAuth(apiBase, path, email, password);
      chrome.storage.local.set({ token, apiBase, email }, () => {
        setMsg(msgEl, 'Signed in.', 'success');
        showLoggedIn(email, apiBase);
      });
    } catch (err) {
      setMsg(msgEl, err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });
}

wireAuth('login-btn', 'Log in', '/auth/login', 'login', 'login-msg');
wireAuth('register-btn', 'Create account', '/auth/register', 'reg', 'register-msg');

// --- On-device AI toggle (default on) ---
const aiBox = document.getElementById('ai-enabled');
chrome.storage.local.get(['aiEnabled'], ({ aiEnabled }) => { aiBox.checked = aiEnabled !== false; });
aiBox.addEventListener('change', () => chrome.storage.local.set({ aiEnabled: aiBox.checked }));

// --- Logout ---
document.getElementById('logout-btn').addEventListener('click', () => {
  chrome.storage.local.remove(['token', 'email'], () => {
    showAuthForms();
    setMsg(document.getElementById('login-msg'), '', '');
  });
});
