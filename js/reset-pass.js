// Check oobCode before showing form
  (function() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('oobCode');
    if (!code) {
      document.addEventListener('DOMContentLoaded', function() {
        const form = document.getElementById('resetForm');
        if (form) {
          form.innerHTML = '<div style="text-align:center;padding:20px 0;">' +
            '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 16px;display:block;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
            '<p style="font-family:Outfit,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:8px;">Invalid Reset Link</p>' +
            '<p style="font-size:13px;color:#64748b;margin-bottom:20px;">This password reset link is invalid or has expired.</p>' +
            '<a href="index.html" style="display:inline-block;padding:10px 24px;background:#2563eb;color:#fff;border-radius:10px;font-family:Outfit,sans-serif;font-weight:700;font-size:13px;text-decoration:none;">Return to Login</a>' +
            '</div>';
        }
      });
    }
  })();

  import { auth } from './firebase-config.js';
  import { confirmPasswordReset, verifyPasswordResetCode } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

  const params     = new URLSearchParams(window.location.search);
  const actionCode = params.get('oobCode');
  const mode       = params.get('mode');

  const verifyDiv  = document.getElementById('verifying');
  const formDiv    = document.getElementById('resetForm');
  const successDiv = document.getElementById('successMsg');
  const errorDiv   = document.getElementById('errorMsg');
  const saveBtn    = document.getElementById('saveBtn');

  window.checkStrength = (val) => {
    const bar = document.getElementById('strengthBar'), hint = document.getElementById('strengthHint');
    let s = 0;
    if (val.length >= 6)  s++;
    if (val.length >= 10) s++;
    if (/[A-Z]/.test(val)) s++;
    if (/\d/.test(val))    s++;
    if (/[@$!%*?&]/.test(val)) s++;
    const L = [{p:'0%',c:'#e2e8f0',t:'Enter a password above',tc:'#94a3b8'},{p:'20%',c:'#ef4444',t:'Too weak',tc:'#ef4444'},{p:'45%',c:'#f59e0b',t:'Fair',tc:'#d97706'},{p:'70%',c:'#3b82f6',t:'Good',tc:'#2563eb'},{p:'90%',c:'#22c55e',t:'Strong',tc:'#16a34a'},{p:'100%',c:'#15803d',t:'Excellent',tc:'#15803d'}];
    const l = L[Math.min(s,5)];
    bar.style.width=l.p; bar.style.background=l.c; hint.textContent=l.t; hint.style.color=l.tc;
  };

  async function init() {
    if (!actionCode || mode !== 'resetPassword') {
      verifyDiv.classList.add('hidden');
      errorDiv.textContent = 'Invalid or expired link. Please request a new password reset from the login page.';
      errorDiv.classList.remove('hidden');
      return;
    }
    try {
      await verifyPasswordResetCode(auth, actionCode);
      verifyDiv.classList.add('hidden');
      formDiv.classList.remove('hidden');
    } catch {
      verifyDiv.classList.add('hidden');
      errorDiv.textContent = 'This link has expired or already been used. Please request a new password reset.';
      errorDiv.classList.remove('hidden');
    }
  }

  saveBtn.onclick = async () => {
    const newPwd  = document.getElementById('newPass').value;
    const confPwd = document.getElementById('confirmPass').value;
    if (newPwd.length < 6)      { document.getElementById('pwErr').textContent='Password must be at least 6 characters.'; return; }
    if (newPwd !== confPwd)     { document.getElementById('pwErr').textContent='Passwords do not match.'; return; }
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;
    errorDiv.classList.add('hidden');
    try {
      await confirmPasswordReset(auth, actionCode, newPwd);
      formDiv.classList.add('hidden');
      successDiv.classList.remove('hidden');
    } catch(e) {
      errorDiv.textContent = 'Error: ' + e.message;
      errorDiv.classList.remove('hidden');
      saveBtn.textContent = 'Save New Password';
      saveBtn.disabled = false;
    }
  };

  init();