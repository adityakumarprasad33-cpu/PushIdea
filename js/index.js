import { auth, rtdb, googleProvider } from './firebase-config.js';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, set, get, child, update, push } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ── TOAST SYSTEM ─────────────────
const _TI={
  s:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
  e:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  i:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>',
  w:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/></svg>'
};

window.toast = function(msg, type, dur) {
  type = type || 'i'; dur = dur || 4000;
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = (_TI[type]||'') + '<span>' + msg + '</span>';
  var container = document.getElementById('toastContainer');
  if (!container) { container = document.createElement('div'); container.id='toastContainer'; document.body.appendChild(container); }
  container.appendChild(el);
  setTimeout(function(){ el.style.animation='toastOut .3s ease forwards'; setTimeout(function(){el.remove();},300); }, dur);
};

const toast = (...a) => window.toast(...a);

// Scroll reveal
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => { if(e.isIntersecting){ e.target.classList.add('visible'); observer.unobserve(e.target); }});
}, { threshold:.1, rootMargin:'0px 0px -40px 0px' });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Animated counters
function animateCount(el, target, duration=1800){
  let start=0, step=target/duration*16;
  const timer=setInterval(()=>{
    start+=step;
    if(start>=target){ el.textContent=target; clearInterval(timer); return; }
    el.textContent=Math.floor(start);
  },16);
}
const statsObs = new IntersectionObserver(entries=>{
  entries.forEach(e=>{
    if(e.isIntersecting){
      animateCount(document.getElementById('c1'),200);
      animateCount(document.getElementById('c2'),50);
      animateCount(document.getElementById('c3'),2);
      animateCount(document.getElementById('c4'),12);
      statsObs.disconnect();
    }
  });
},{threshold:.5});
statsObs.observe(document.querySelector('.stats-grid'));

// Old toggleHIW preserved for compatibility (hidden section)
let hiwOpen=false;
function toggleHIW(){}


// ── AUTH & LOGIC SYSTEM ─────────────────
let currentMode = 'LOGIN';
const btn = document.getElementById('actionBtn');
let tempUserUid = null, tempRole = null;

// Rate-limit login attempts
let loginAttempts = 0, loginLocked = false;
const MAX_ATTEMPTS = 5;

const esc = (str) => str ? String(str).replace(/[&<>'"]/g, t => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t])) : '';
const showLoader = (msg) => { document.getElementById('loadingText').innerText = msg || 'Processing…'; document.getElementById('loadingOverlay').classList.remove('hidden'); };
const hideLoader = () => document.getElementById('loadingOverlay').classList.add('hidden');
const isStrongPass = (v) => v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v) && /[@$!%*?&]/.test(v);

// Auth state
onAuthStateChanged(auth, async (user) => {
  const nb = document.getElementById('navAuthBtn');
  if (user) {
    nb.textContent = 'Dashboard';
    nb.onclick = () => checkAndRedirect(user.uid);
  } else {
    nb.textContent = 'Log In';
    nb.onclick = () => openMenu('LOGIN');
  }
});

window.togglePasswordVisibility = () => {
  const p = document.getElementById('password');
  const eye = document.getElementById('eyeIcon'), eyeOff = document.getElementById('eyeOffIcon');
  p.type = p.type === 'password' ? 'text' : 'password';
  eye.style.display = p.type === 'password' ? 'inline-block' : 'none';
  eyeOff.style.display = p.type === 'password' ? 'none' : 'inline-block';
};

const legalData = {
  INVENTOR: {
    terms:`<h4 style="font-weight:700;color:#0f172a;margin-bottom:10px;">Founder Terms of Service</h4><ul style="list-style:disc;padding-left:18px;display:flex;flex-direction:column;gap:7px;"><li>You confirm ownership of the IP for the project you list.</li><li>You agree not to submit false or misleading information.</li><li>PushIdea is a matching platform and does not guarantee investment.</li><li>Sharing sensitive business information is at your own risk.</li></ul>`,
    privacy:`<h4 style="font-weight:700;color:#0f172a;margin-bottom:10px;">Founder Privacy Policy</h4><p style="margin-bottom:10px;">We collect project details to match you with investors.</p><ul style="list-style:disc;padding-left:18px;display:flex;flex-direction:column;gap:7px;"><li>Your project summary is visible to verified investors.</li><li>Direct contact details are hidden until you accept a connection.</li></ul>`
  },
  INVESTOR: {
    terms:`<h4 style="font-weight:700;color:#0f172a;margin-bottom:10px;">Investor Terms of Service</h4><ul style="list-style:disc;padding-left:18px;display:flex;flex-direction:column;gap:7px;"><li>You confirm you are an accredited investor capable of assessing risk.</li><li>You agree to keep founder data confidential.</li><li>You understand startups are high-risk investments.</li><li>PushIdea is not a broker-dealer and does not facilitate money transfers.</li></ul>`,
    privacy:`<h4 style="font-weight:700;color:#0f172a;margin-bottom:10px;">Investor Privacy Policy</h4><p style="margin-bottom:10px;">We respect your privacy and deal flow preferences.</p><ul style="list-style:disc;padding-left:18px;display:flex;flex-direction:column;gap:7px;"><li>Your investment activity is private.</li><li>Founders cannot see your contact info unless you connect.</li></ul>`
  }
};

window.showLegal = (type) => {
  const mode = (currentMode==='INVENTOR'||currentMode==='INVESTOR') ? currentMode : 'INVENTOR';
  document.getElementById('legalTitle').innerText = type==='terms' ? 'Terms of Service' : 'Privacy Policy';
  document.getElementById('legalContent').innerHTML = legalData[mode][type==='terms'?'terms':'privacy'];
  document.getElementById('legalModal').classList.remove('hidden');
};

window.submitGuestSupport = async () => {
  const name=document.getElementById('guestName').value.trim(), email=document.getElementById('guestEmail').value.trim();
  const subject=document.getElementById('guestSubject').value.trim(), message=document.getElementById('guestMessage').value.trim();
  if (!name||!email||!subject||!message) return toast('Please fill in all fields.','w');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Please enter a valid email address.','w');
  try {
    const user = auth.currentUser;
    await push(ref(rtdb,'support_tickets'), { name:esc(name).slice(0,120), email:esc(email).slice(0,200), subject:esc(subject).slice(0,200), message:esc(message).slice(0,2000), role: user?'User':'Guest', uid: user?user.uid:'anonymous', status:'open', timestamp:Date.now() });
    toast('Message sent! Support will contact you via email.','s'); document.getElementById('contactModal').classList.add('hidden');
    document.getElementById('guestMessage').value='';
  } catch(e) { toast('Error: '+e.message,'e'); }
};

window.openMenu = (mode) => {
  currentMode = mode;
  if (auth.currentUser && mode!=='RESET') { checkAndRedirect(auth.currentUser.uid); return; }
  document.getElementById('authModal').classList.remove('hidden');
  const title=document.getElementById('modalTitle'), sub=document.getElementById('modalSubtitle'),
    roleD=document.getElementById('roleDisplay'), sFields=document.getElementById('signupFields'),
    passC=document.getElementById('passwordContainer'), terms=document.getElementById('termsContainer'),
    switchB=document.getElementById('switchBtn'), backB=document.getElementById('backToLoginBtn'),
    stdForm=document.getElementById('standardForm'), resetForm=document.getElementById('resetFlowContainer'),
    forgot=document.getElementById('forgotContainer'), googleC=document.getElementById('googleBtnContainer');
  [roleD,sFields,terms,backB,resetForm].forEach(e=>e.classList.add('hidden'));
  [passC,switchB,stdForm,googleC].forEach(e=>e.classList.remove('hidden'));
  forgot.classList.add('hidden');

  // Always clear password field when switching modes to prevent stale autofill
  const pwdInput = document.getElementById('password');
  pwdInput.value = '';

  if (mode==='LOGIN') {
    title.innerText='Welcome Back'; sub.innerText='Log in to your account'; forgot.classList.remove('hidden'); btn.textContent='Log In';
    switchB.textContent='Create New Account'; switchB.onclick=()=>{closeAuthModal();openMenu('INVENTOR');};
    // Login mode: let browser suggest saved credentials
    pwdInput.setAttribute('autocomplete','current-password');
    document.getElementById('email').setAttribute('autocomplete','email');
  } else if (mode==='RESET') {
    title.innerText='Reset Password'; sub.innerText='Enter your email address';
    stdForm.classList.add('hidden'); googleC.classList.add('hidden'); resetForm.classList.remove('hidden');
    switchB.classList.add('hidden'); backB.classList.remove('hidden'); btn.textContent='Send Reset Link';
  } else {
    title.innerText='Create Account'; sub.innerText='Join PushIdea for free';
    roleD.classList.remove('hidden'); document.getElementById('roleName').innerText = mode==='INVESTOR'?'Investor':'Founder';
    sFields.classList.remove('hidden'); terms.classList.remove('hidden'); btn.textContent='Sign Up';
    switchB.textContent='I already have an account'; switchB.onclick=()=>{closeAuthModal();openMenu('LOGIN');};
    // Signup mode: block autofill entirely — new-password tells browser this is a new credential
    pwdInput.setAttribute('autocomplete','new-password');
    document.getElementById('email').setAttribute('autocomplete','off');
  }
};
window.closeAuthModal = () => document.getElementById('authModal').classList.add('hidden');

async function checkAndRedirect(uid) {
  showLoader('Checking credentials…');
  try {
    const snap = await get(child(ref(rtdb),`users/${uid}`));
    if (!snap.exists()) { hideLoader(); toast('Account not found. Please sign up.','e'); await signOut(auth); return; }
    const data = snap.val();
    const status = (data.status||'pending').toLowerCase();
    if (status==='disabled'||status==='frozen'||status==='rejected') { hideLoader(); toast('Account disabled or rejected. Contact support.','e'); await signOut(auth); return; }
    if (data.role==='Admin') { window.location.href='admin.html'; return; }
    if (!data.phone||!data.company||!data.address) {
      hideLoader(); tempUserUid=uid; tempRole=data.role;
      if (tempRole==='Investor') {
        document.getElementById('lblCompany').textContent='Firm / Company Name *';
        document.getElementById('compName').placeholder='e.g. Acme Capital';
        document.getElementById('lblJob').textContent='Your Title';
        document.getElementById('jobTitle').placeholder='e.g. Angel Investor';
        document.getElementById('lblIndustry').textContent='Investment Focus';
      } else {
        document.getElementById('lblCompany').textContent='Startup / Project Name *';
        document.getElementById('compName').placeholder='e.g. NextGen App';
        document.getElementById('lblJob').textContent='Your Role';
        document.getElementById('jobTitle').placeholder='e.g. Founder';
        document.getElementById('lblIndustry').textContent='Industry';
      }
      document.getElementById('authModal').classList.add('hidden');
      document.getElementById('completionModal').classList.remove('hidden');
      return;
    }
    if (status!=='approved') { window.location.href='waiting.html'; }
    else { window.location.href = data.role==='Investor'?'investor-dashboard.html':'inventor.html'; }
  } catch(e) { hideLoader(); toast('Connection error. Please try again.','e'); }
}

window.saveMissingInfo = async () => {
  const code=document.getElementById('countryCode').value;
  const phone=document.getElementById('completePhone').value.trim();
  const comp=document.getElementById('compName').value.trim();
  const addr=document.getElementById('address').value.trim();
  const job=document.getElementById('jobTitle').value.trim();
  const ind=document.getElementById('industry').value;
  let link=document.getElementById('linkedin').value.trim(); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  if (!phone||phone.length<5) return toast('Valid phone number required.','w');
  if (!comp) return toast('Company / Project name is required.','w');
  if (!addr) return toast('Address is required.','w');
  showLoader('Finalizing profile…');
  try {
    await update(ref(rtdb,`users/${tempUserUid}`), { phone:code+' '+phone, company:esc(comp), address:esc(addr), jobTitle:esc(job)||'', industry:ind||'', linkedin:esc(link)||'' });
    window.location.href='waiting.html';
  } catch(e) { hideLoader(); toast('Error: '+e.message,'e'); }
};

window.handleGoogleLogin = async () => {
  try {
    showLoader('Connecting to Google…');
    const res = await signInWithPopup(auth, googleProvider);
    const user = res.user;
    const snap = await get(child(ref(rtdb),`users/${user.uid}`));
    if (snap.exists()) { checkAndRedirect(user.uid); return; }
    const role = currentMode==='INVESTOR' ? 'Investor' : 'Inventor';
    await set(ref(rtdb,`users/${user.uid}`), { name:user.displayName||'', email:user.email||'', role, profile:user.photoURL||'', status:'pending', createdAt:Date.now() });
    checkAndRedirect(user.uid);
  } catch(e) { hideLoader(); if (e.code!=='auth/popup-closed-by-user') toast('Login error: '+e.message,'e'); }
};

if(btn){
  btn.onclick = async () => {
    if (loginLocked) { toast('Too many attempts. Please wait 60 seconds.','w'); return; }
    const emailVal=document.getElementById('email').value.trim();
    const passVal=document.getElementById('password').value;
    if (currentMode==='RESET') {
      const rEmail=document.getElementById('resetEmail').value.trim();
      if (!rEmail||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rEmail)) return toast('Please enter a valid email address.','w');
      btn.textContent='Sending…'; btn.disabled=true;
      try { await sendPasswordResetEmail(auth,rEmail); toast('Reset link sent! Check your inbox.','s'); openMenu('LOGIN'); }
      catch(e) { toast('Error: '+e.message,'e'); } finally { btn.textContent='Send Reset Link'; btn.disabled=false; } return;
    }
    if (!emailVal||!passVal) return toast('Please fill in all fields.','w');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) return toast('Please enter a valid email address.','w');
    showLoader('Authenticating…');
    try {
      if (currentMode==='LOGIN') {
        loginAttempts++;
        if (loginAttempts>=MAX_ATTEMPTS) {
          loginLocked=true;
          hideLoader();
          toast('Too many failed attempts. Please wait 60 seconds.','w');
          setTimeout(()=>{ loginLocked=false; loginAttempts=0; }, 60000);
          return;
        }
        const res = await signInWithEmailAndPassword(auth,emailVal,passVal);
        loginAttempts=0;
        checkAndRedirect(res.user.uid);
      } else {
        if (!isStrongPass(passVal)) { hideLoader(); return toast('Password must be 8+ chars, with uppercase, number, and symbol (@$!%*?&).','w'); }
        if (!document.getElementById('termsCheck').checked) { hideLoader(); return toast('Please accept the Terms of Service.','w'); }
        const nameVal=document.getElementById('name').value.trim();
        if (!nameVal) { hideLoader(); return toast('Please enter your full name.','w'); }
        const role=currentMode==='INVENTOR'?'Inventor':'Investor';
        const pic = ''; // profile picture set after profile completion step
        const res = await createUserWithEmailAndPassword(auth,emailVal,passVal);
        await set(ref(rtdb,'users/'+res.user.uid), { name:esc(nameVal), email:emailVal, profile:pic, role, status:'pending', createdAt:Date.now() });
        checkAndRedirect(res.user.uid);
      }
    } catch(e) {
      hideLoader();
      if (e.code==='auth/email-already-in-use') { toast('Email already registered. Please log in.','w'); openMenu('LOGIN'); document.getElementById('email').value=emailVal; }
      else if (e.code==='auth/wrong-password'||e.code==='auth/user-not-found') toast('Incorrect email or password.','e');
      else toast('Error: '+e.message,'e');
    }
  };
}