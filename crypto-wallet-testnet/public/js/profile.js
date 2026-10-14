const _user = requireAuth();
if (_user) {
  document.addEventListener('DOMContentLoaded', init);
}

async function init() {
  const u = await api('/api/auth/me').then(r => r.user);
  document.getElementById('avatar').textContent = u.username[0].toUpperCase();
  document.getElementById('uname').textContent = u.username;
  document.getElementById('email').textContent = u.email;
  document.getElementById('displayName').value = u.displayName || '';
  document.getElementById('country').value = u.country || '';
  document.getElementById('addr').textContent = u.walletAddress;

  renderKyc(u);
  renderDocs(u.kycDocuments || []);

  const sw = document.getElementById('twofa');
  if (u.twoFA) sw.classList.add('on');

  sw.addEventListener('click', () => {
    if (sw.classList.contains('on')) {
      disable2FA();
    } else {
      start2FASetup();
    }
  });

  // render recovery codes button if enabled
  if (u.twoFA) renderRecoverySection();

  setupUploader();
}

function renderKyc(u) {
  const pill = document.getElementById('kyc');
  pill.textContent = `KYC: ${u.kycStatus[0].toUpperCase() + u.kycStatus.slice(1)}`;
  pill.className = `kyc-pill kyc-${u.kycStatus}`;

  const banner = document.getElementById('kyc-status-banner');
  if (u.kycStatus === 'verified') {
    banner.innerHTML = '<div class="broadcast" style="--broadcast-icon: none;">✅ Your identity has been verified. Unlimited withdrawals enabled.</div>';
  } else if (u.kycStatus === 'pending') {
    banner.innerHTML = '<div class="broadcast">⏳ Documents under review. This usually takes a few minutes.</div>';
  } else {
    banner.innerHTML = '<div class="broadcast">🔓 Complete verification to unlock higher withdrawal limits.</div>';
  }
}

function setupUploader() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('kyc-file');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); });

  // drag & drop
  ['dragover','dragenter'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave','drop'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f);
  });
}

function uploadFile(file) {
  const allowed = ['.jpg','.jpeg','.png','.webp','.pdf'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) return toast('Only JPG, PNG, WEBP, or PDF allowed', 'error');
  if (file.size > 5 * 1024 * 1024) return toast('File must be under 5MB', 'error');

  const progWrap = document.getElementById('upload-progress');
  const progBar = document.getElementById('upload-progress-bar');
  progWrap.style.display = 'block';
  progBar.style.width = '0%';

  const form = new FormData();
  form.append('document', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload/kyc');
  xhr.setRequestHeader('Authorization', `Bearer ${token()}`);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = (e.loaded / e.total) * 100;
      progBar.style.width = pct + '%';
    }
  };

  xhr.onload = async () => {
    progWrap.style.display = 'none';
    if (xhr.status >= 200 && xhr.status < 300) {
      toast('Document uploaded — under review', 'success');
      const u = await api('/api/auth/me').then(r => r.user);
      renderKyc(u);
      renderDocs(u.kycDocuments || []);
    } else {
      let err = 'Upload failed';
      try { err = JSON.parse(xhr.responseText).error || err; } catch {}
      toast(err, 'error');
    }
  };

  xhr.onerror = () => {
    progWrap.style.display = 'none';
    toast('Upload failed', 'error');
  };

  xhr.send(form);
}

function renderDocs(docs) {
  const el = document.getElementById('docs');
  if (!docs.length) {
    el.innerHTML = '<div class="empty">No documents uploaded yet</div>';
    return;
  }
  el.innerHTML = `
    <div class="grid grid-2">
      ${docs.map(d => `
        <div class="doc-card">
          ${d.mimetype.startsWith('image/')
            ? `<img src="${d.url}" alt="doc" class="doc-thumb" />`
            : `<div class="doc-thumb doc-file">📄<div class="tag">${d.filename.split('.').pop().toUpperCase()}</div></div>`}
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; font-size:13px; word-break:break-all;">${d.filename}</div>
            <div class="tag">${(d.size/1024).toFixed(0)} KB · ${new Date(d.uploadedAt).toLocaleDateString()}</div>
          </div>
          <button class="danger sm" onclick="removeDoc('${d.filename}')">Remove</button>
        </div>`).join('')}
    </div>`;
}

window.removeDoc = async (filename) => {
  if (!confirm('Remove this document?')) return;
  try {
    await api(`/api/upload/kyc/${filename}`, { method: 'DELETE' });
    toast('Document removed', 'success');
    const u = await api('/api/auth/me').then(r => r.user);
    renderDocs(u.kycDocuments || []);
    renderKyc(u);
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ Existing profile actions ============ */
window.saveProfile = async () => {
  try {
    const displayName = document.getElementById('displayName').value;
    const country = document.getElementById('country').value;
    await api('/api/profile/update', { method: 'PUT', body: JSON.stringify({ displayName, country }) });
    toast('Profile updated', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

window.rotate = async () => {
  if (!confirm('Rotate your wallet address? Old addresses will no longer be accepted.')) return;
  try {
    const r = await api('/api/profile/rotate-address', { method: 'POST' });
    document.getElementById('addr').textContent = r.walletAddress;
    const stored = JSON.parse(localStorage.getItem('user') || '{}');
    stored.walletAddress = r.walletAddress;
    localStorage.setItem('user', JSON.stringify(stored));
    toast('Wallet address rotated', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

window.togglePwd = () => {
  const f = document.getElementById('pwd-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
};

window.changePwd = async () => {
  const current = document.getElementById('cur-pwd').value;
  const next = document.getElementById('new-pwd').value;
  try {
    await api('/api/profile/password', { method: 'PUT', body: JSON.stringify({ current, next }) });
    toast('Password updated', 'success');
    document.getElementById('cur-pwd').value = '';
    document.getElementById('new-pwd').value = '';
    togglePwd();
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ 2FA SETUP — STEP 1: show QR ============ */
async function start2FASetup() {
  try {
    const setup = await api('/api/auth/2fa/setup', { method: 'POST' });
    const modal = document.getElementById('twofa-modal');
    const body = document.getElementById('twofa-modal-body');

    body.innerHTML = `
      <p class="tag" style="margin-bottom: 14px;">
        Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
      </p>

      <div id="qr-2fa" style="display:flex; justify-content:center; padding: 12px; background:#fff; border-radius: 12px; width: fit-content; margin: 0 auto 14px;"></div>

      <details style="margin-bottom: 14px;">
        <summary class="tag" style="cursor:pointer;">Can't scan? Enter the setup key manually</summary>
        <div style="margin-top: 8px; padding: 10px 12px; background: rgba(148,163,184,.08); border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all;">
          ${setup.secret}
        </div>
      </details>

      <label>Enter the 6-digit code from your app</label>
      <input id="twofa-code-input" maxlength="7" placeholder="123 456"
        style="text-align:center; font-family: monospace; font-size: 20px; letter-spacing: 6px;" />

      <button style="width:100%" onclick="confirmEnable2FA()">Verify & Enable</button>
    `;

    modal.classList.add('open');

    // Render QR
    const qrHost = document.getElementById('qr-2fa');
    if (window.QRCode) {
      new QRCode(qrHost, {
        text: setup.otpauth,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      qrHost.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setup.otpauth)}" alt="QR" />`;
    }

    setTimeout(() => document.getElementById('twofa-code-input')?.focus(), 150);
  } catch (e) {
    toast(e.message, 'error');
  }
}

window.confirmEnable2FA = async () => {
  const code = document.getElementById('twofa-code-input').value.trim();
  if (!code) return toast('Enter the code', 'warn');

  try {
    const r = await api('/api/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ code })
    });

    // Show recovery codes — critical step
    const modalBody = document.getElementById('twofa-modal-body');
    modalBody.innerHTML = `
      <div class="broadcast" style="--broadcast-icon: none;">✅ 2FA enabled successfully</div>
      <p class="tag" style="margin: 14px 0;">
        <b>Save these recovery codes.</b> Each one can be used once to log in if you lose access
        to your authenticator app. Store them somewhere safe.
      </p>
      <div style="
        display:grid; grid-template-columns: 1fr 1fr; gap: 8px;
        padding: 14px; background: rgba(6,9,21,.5); border-radius: 10px;
        border: 1px solid var(--border); font-family: monospace; font-size: 13px;
        margin-bottom: 14px;
      ">
        ${r.recoveryCodes.map(c => `<div>${c}</div>`).join('')}
      </div>
      <button class="secondary" style="width:100%; margin-bottom: 8px;"
        onclick="copyRecoveryCodes(${JSON.stringify(r.recoveryCodes).replace(/"/g, '&quot;')})">
        Copy all codes
      </button>
      <button style="width:100%"
        onclick="document.getElementById('twofa-modal').classList.remove('open')">
        I've saved my codes
      </button>`;

    document.getElementById('twofa').classList.add('on');
    const stored = JSON.parse(localStorage.getItem('user') || '{}');
    stored.twoFA = true;
    localStorage.setItem('user', JSON.stringify(stored));

    toast('2FA enabled', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.copyRecoveryCodes = (codes) => {
  navigator.clipboard.writeText(codes.join('\n'));
  toast('Recovery codes copied', 'success', 1500);
};

/* ============ 2FA DISABLE ============ */
async function disable2FA() {
  const password = prompt('Enter your account password');
  if (!password) return;
  const code = prompt('Enter the current 6-digit code from your authenticator app');
  if (!code) return;

  try {
    await api('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code })
    });
    document.getElementById('twofa').classList.remove('on');
    toast('2FA disabled', 'success');
    const stored = JSON.parse(localStorage.getItem('user') || '{}');
    stored.twoFA = false;
    localStorage.setItem('user', JSON.stringify(stored));
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ============ Regenerate recovery codes ============ */
function renderRecoverySection() {
  const kycActions = document.getElementById('kyc-actions');
  if (!kycActions) return;
  const btn = document.createElement('button');
  btn.className = 'secondary sm';
  btn.textContent = 'Regenerate recovery codes';
  btn.style.marginTop = '12px';
  btn.onclick = async () => {
    const code = prompt('Enter the current 6-digit code from your authenticator app');
    if (!code) return;
    try {
      const r = await api('/api/auth/2fa/recovery-codes', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      alert('New recovery codes:\n\n' + r.recoveryCodes.join('\n') + '\n\nSave them now.');
    } catch (e) { toast(e.message, 'error'); }
  };
  kycActions.parentNode.insertBefore(btn, kycActions.nextSibling);
}