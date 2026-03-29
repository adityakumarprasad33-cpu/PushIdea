import { auth, rtdb } from './firebase-config.js';
  import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
  import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

  window.auth = auth;

  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.replace('index.html'); return; }
    const st = document.getElementById('statusText');
    const userRef = ref(rtdb, 'users/' + user.uid);
    onValue(userRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      const status = (data.status || 'pending').toLowerCase();
      if (status === 'approved' || status === 'live') {
        st.textContent = 'Approved! Redirecting…';
        st.style.color = '#16a34a';
        setTimeout(() => {
          window.location.href = data.role === 'Inventor' ? 'inventor.html' : 'investor-dashboard.html';
        }, 1000);
      } else if (status === 'disabled' || status === 'frozen' || status === 'rejected') {
        signOut(auth).then(() => {
          document.body.innerHTML='<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fef2f2;"><div style="text-align:center;padding:40px;"><p style="font-family:Outfit,sans-serif;font-size:18px;font-weight:700;color:#dc2626;">Account Disabled</p><p style="color:#64748b;margin-top:8px;font-size:14px;">Contact support for assistance.</p><a href="index.html" style="display:inline-block;margin-top:18px;padding:10px 24px;background:#dc2626;color:#fff;border-radius:50px;font-weight:700;font-size:13px;text-decoration:none;">Go Back</a></div></div>';
          window.location.replace('index.html');
        });
      } else {
        st.textContent = 'Still under review — we are checking your profile.';
      }
    });
  });