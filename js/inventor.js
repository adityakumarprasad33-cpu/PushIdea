import { auth, rtdb } from './firebase-config.js';
        import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { ref, set, push, onValue, onChildAdded, remove, runTransaction, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

        window.auth = auth;
        let activeChatPath = null; let currentUserUid = null; let currentData = {}; let sentRequests = new Set();
        let currentChatPartner = {}; let allInvestors = [];
        let _liveProjectStats = {}; // key → {interestCount, viewCount, likeCount, status}
        let currentStep = 1; let projectType = 'Idea'; // Default

        
        // ═══════════════════════════════════════════════════════
        //  CHAT ENCRYPTION — AES-GCM 256 via Web Crypto API
        //  Key = PBKDF2(roomId, salt, 100k iters, SHA-256)
        //  Never stored. Derived fresh each chat open.
        // ═══════════════════════════════════════════════════════
        const CHAT_SALT = 'pushidea_chat_salt_v1';
        let _chatKey = null; // cached for current open chat session

        async function deriveChatKey(roomId) {
            const enc = new TextEncoder();
            const keyMat = await crypto.subtle.importKey(
                'raw', enc.encode(roomId), 'PBKDF2', false, ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                { name:'PBKDF2', salt:enc.encode(CHAT_SALT), iterations:100000, hash:'SHA-256' },
                keyMat,
                { name:'AES-GCM', length:256 },
                false,
                ['encrypt','decrypt']
            );
        }

        async function encryptMsg(plaintext, key) {
            const iv  = crypto.getRandomValues(new Uint8Array(12));
            const enc = new TextEncoder();
            const ct  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(plaintext));
            const buf = new Uint8Array(12 + ct.byteLength);
            buf.set(iv, 0);
            buf.set(new Uint8Array(ct), 12);
            return btoa(String.fromCharCode(...buf));
        }

        async function decryptMsg(cipherB64, key) {
            try {
                const buf = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0));
                const iv  = buf.slice(0, 12);
                const ct  = buf.slice(12);
                const dec = new TextDecoder();
                const pt  = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
                return dec.decode(pt);
            } catch {
                return '[encrypted message]';
            }
        }


        // ── TOAST + CONFIRM SYSTEM ──────────────────────────────────────────
        const _ICONS = {
            success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
            error:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>',
            warn:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/></svg>',
        };
        function toast(msg, type='info', dur=3500) {
            const el = document.createElement('div');
            el.className = 'toast toast-'+type;
            el.innerHTML = _ICONS[type] + '<span>' + msg + '</span>';
            document.getElementById('toastContainer').appendChild(el);
            setTimeout(() => { el.style.animation='toastOut .3s ease forwards'; setTimeout(()=>el.remove(),300); }, dur);
        }
        function confirmDialog(msg, sub='') {
            return new Promise(resolve => {
                const ov = document.getElementById('confirmOverlay');
                document.getElementById('confirmMsg').textContent = msg;
                document.getElementById('confirmSub').textContent = sub;
                ov.style.display = 'flex';
                const ok = document.getElementById('confirmOK'), ca = document.getElementById('confirmCancel');
                const done = v => { ov.style.display='none'; ok.onclick=ca.onclick=null; resolve(v); };
                ok.onclick = () => done(true); ca.onclick = () => done(false);
            });
        }
        function errMsg(e) {
            const MAP = {'permission-denied':'Access denied.','network-request-failed':'Connection lost.'};
            return MAP[e?.code] || ('Error: ' + (e?.message||'unknown'));
        }
        // ───────────────────────────────────────────────────────────────────

        const escapeHTML = (str) => str ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])) : "";

        // --- TYPE SELECTOR LOGIC ---
        window.selectType = (type) => {
            projectType = type;
            // Visual Update
            document.getElementById('optIdea').classList.toggle('selected', type === 'Idea');
            document.getElementById('optLive').classList.toggle('selected', type === 'Live');
            
            // Logic Update
            // If idea, hide 3 & 4. If Live, show all.
            // Reset wizard to Step 1 when changing type to avoid stuck states
            currentStep = 1; window.changeStep(0);
        };

        // --- WIZARD LOGIC ---
        window.changeStep = (n) => {
            // Validation
            if (n === 1) {
                if (currentStep === 1 && (!document.getElementById('pName').value || !document.getElementById('pTagline').value)) return toast("Fill in Project Name and Tagline to continue.","warn");
                if (currentStep === 3 && projectType === 'Live' && !document.getElementById('pAmount').value) return toast("Funding Amount is required for Live projects.","warn");
            }

            document.getElementById(`step${currentStep}`).classList.remove('active');
            
            // Branching Logic
            let nextStep = currentStep + n;
            
            if (projectType === 'Idea') {
                if (currentStep === 2 && n === 1) nextStep = 5; // Skip 3,4
                if (currentStep === 5 && n === -1) nextStep = 2; // Back to 2
            }

            currentStep = nextStep;
            document.getElementById(`step${currentStep}`).classList.add('active');
            
            // Update UI
            let totalSteps = projectType === 'Idea' ? 3 : 5;
            let displayStep = currentStep;
            if(projectType === 'Idea' && currentStep === 5) displayStep = 3; // Visual hack for "Step 3 of 3"

            document.getElementById('stepCount').innerText = displayStep;
            document.getElementById('progressBar').style.width = `${(displayStep / totalSteps) * 100}%`;
            
            // Buttons
            document.getElementById('prevBtn').classList.toggle('hidden', currentStep === 1);
            if (currentStep === 5) {
                document.getElementById('nextBtn').classList.add('hidden');
                document.getElementById('pubBtn').classList.remove('hidden');
            } else {
                document.getElementById('nextBtn').classList.remove('hidden');
                document.getElementById('pubBtn').classList.add('hidden');
            }
        };

        window.switchTab = (tab) => {
            const views = ['viewProjects', 'viewLikes', 'viewPartners', 'viewDirectory'];
            const navs = ['navProjects', 'navLikes', 'navPartners', 'navDirectory'];
            const mobNavs = ['mobProjects', 'mobLikes', 'mobPartners', 'mobDirectory'];
            views.forEach(v => document.getElementById(v).classList.add('hidden'));
            navs.forEach(n => document.getElementById(n)?.classList.remove('active'));
            mobNavs.forEach(n => document.getElementById(n)?.classList.remove('active'));
            document.getElementById('view' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.remove('hidden');
            const activeNav = document.getElementById('nav' + tab.charAt(0).toUpperCase() + tab.slice(1));
            const activeMob = document.getElementById('mob' + tab.charAt(0).toUpperCase() + tab.slice(1));
            if(activeNav) activeNav.classList.add('active');
            if(activeMob) activeMob.classList.add('active');
            if(tab === 'directory') loadInvestorDirectory();
        };

        window.toggleNotifications = async () => {
            if(window.innerWidth < 768) document.getElementById('notifModal').classList.remove('hidden');
            else document.getElementById('notificationDropdown').classList.toggle('hidden');
            // Mark all notifications as read
            if (currentData.notifications) {
                const updates = {};
                Object.keys(currentData.notifications).forEach(k => {
                    if (!currentData.notifications[k].read)
                        updates[`users/${currentUserUid}/notifications/${k}/read`] = true;
                });
                if (Object.keys(updates).length) update(ref(rtdb), updates).catch(()=>{});
            }
        };
        window.clearNotifications = async () => { if(!(await confirmDialog("Clear all notifications?",""))) return; await remove(ref(rtdb, `users/${currentUserUid}/notifications`)); if(window.innerWidth < 768) document.getElementById('notifModal').classList.add('hidden'); else document.getElementById('notificationDropdown').classList.add('hidden'); };

        onAuthStateChanged(auth, async (user) => {
            if(!user) return window.location.href = "index.html";
            currentUserUid = user.uid;
            // Update lastSeen silently
            update(ref(rtdb, `users/${user.uid}`), { lastSeen: Date.now() }).catch(()=>{});
            
            onValue(ref(rtdb, 'users/' + user.uid), (snap) => {
                const data = snap.val(); if(!data) return;
                currentData = data;
                
                if (data.status === 'pending') { window.location.href = "waiting.html"; return; }
                if (data.status === 'disabled') { toast('Your account has been disabled.','error'); setTimeout(()=>window.location.href='index.html',2000); return; }
                if (data.role === 'Admin')    { window.location.href = "admin.html"; return; }
                if (data.role !== 'Inventor') { window.location.href = "investor-dashboard.html"; return; }

                document.getElementById('sideName').innerText = data.name;
                document.getElementById('sideProfilePic').src = data.profile;
                document.getElementById('mobileProfilePic').src = data.profile;
                // First render from user node (fast, real-time)
                renderProjects(data.project);
                renderLikes(data.likes);
                renderPartners(data.partners);
                
                // Also load any projects from /projects/ that aren't in user node yet
                // (handles projects submitted before user-ref write was added)
                if (!data.project || Object.keys(data.project).length === 0) {
                    get(ref(rtdb, 'projects')).then(snap => {
                        if (!snap.exists()) return;
                        const myProjects = {};
                        snap.forEach(child => {
                            const p = child.val();
                            if (p.userid === currentUserUid) {
                                myProjects[child.key] = {
                                    key: child.key, status: p.status || 'submitted',
                                    nameOfIdea: p.nameOfIdea || '', tagline: p.tagline || '',
                                    IdeaDescription: p.IdeaDescription || '',
                                    fundingGoal: p.fundingGoal || '', currency: p.currency || 'USD',
                                    interestCount: p.interestCount || 0, timestamp: p.timestamp || 0
                                };
                            }
                        });
                        if (Object.keys(myProjects).length > 0) renderProjects(myProjects);
                    }).catch(() => {});
                }
                
                // Update stats bar
                const totalInterests = data.likes ? Object.keys(data.likes).length : 0;
                const totalConnected = data.partners ? Object.keys(data.partners).length : 0;
                document.getElementById('statInterests').textContent = totalInterests;
                document.getElementById('statConnected').textContent = totalConnected;
                document.getElementById('statsBar').style.display = 'block';
                // Total views across all projects (from live stats)
                const totalViews = Object.values(_liveProjectStats).reduce((s,p)=>s+(p.viewCount||0), 0);
                const statViewsEl = document.getElementById('statViews');
                if (statViewsEl) statViewsEl.textContent = totalViews;
                
                const notifList = document.getElementById('notificationList');
                const mobNotifList = document.getElementById('mobNotifList');
                let notifCount = 0; let notifHTML = "";
                
                if(data.notifications) {
                    Object.values(data.notifications).reverse().forEach(n => {
                        const time = new Date(n.timestamp).toLocaleDateString();
                        notifHTML += `<div class="p-3 hover:bg-slate-50 border-b border-slate-50"><p class="text-sm text-slate-800 font-medium leading-snug">${escapeHTML(n.message)}</p><span class="text-[10px] text-slate-400 mt-1 block">${time}</span></div>`;
                        notifCount++;
                    });
                } else { notifHTML = `<div class="p-6 text-center text-xs text-slate-400">No new notifications.</div>`; }
                
                notifList.innerHTML = notifHTML; mobNotifList.innerHTML = notifHTML;
                const dBadge = document.getElementById('deskNotifBadge'); const mBadge = document.getElementById('mobNotifBadge');
                const unreadCount = data.notifications ? Object.values(data.notifications).filter(n=>!n.read).length : 0;
                if(unreadCount > 0) { dBadge.classList.remove('hidden'); mBadge.classList.remove('hidden'); dBadge.textContent=unreadCount>9?'9+':unreadCount; }
                else { dBadge.classList.add('hidden'); mBadge.classList.add('hidden'); }
            });

            onValue(ref(rtdb, 'requests'), (snap) => {
                sentRequests.clear();
                let pendingCount = 0;
                if(snap.exists()) {
                    Object.values(snap.val()).forEach(r => {
                        if(r.from === currentUserUid && r.status === 'pending') { sentRequests.add(r.to); pendingCount++; }
                    });
                }
                document.getElementById('statPending').textContent = pendingCount;
                if(!document.getElementById('viewDirectory').classList.contains('hidden')) filterInvestors();
            });

            // ── LIVE PROJECT STATS ────────────────────────────────────────────
            // Listen to /projects/ for this founder's projects to get real-time
            // interestCount, viewCount, likeCount — the lightweight user refs are stale
            onValue(ref(rtdb, 'projects'), (psnap) => {
                _liveProjectStats = {};
                if (psnap.exists()) {
                    psnap.forEach(child => {
                        const p = child.val();
                        if (p.userid === currentUserUid) {
                            _liveProjectStats[child.key] = {
                                interestCount: p.interestCount || 0,
                                viewCount:     p.viewCount     || 0,
                                likeCount:     p.likeCount     || 0,
                                status:        p.status        || 'submitted'
                            };
                        }
                    });
                }
                // Re-render project cards with fresh stats
                if (currentData.project) renderProjects(currentData.project);
            }, { onlyOnce: false });
        });

        // --- SUBMIT TICKET ---
        window.submitUserSupport = async () => {
            const lastTicket = currentData.lastTicketAt || 0;
            if (Date.now() - lastTicket < 300000) {
                const mins = Math.ceil((300000 - (Date.now()-lastTicket)) / 60000);
                toast(`Please wait ${mins} more minute(s) before submitting another ticket.`, 'warn'); return;
            }
            const subject = document.getElementById('supSubject').value; const message = document.getElementById('supMessage').value;
            if(!subject || !message) return toast('Please fill in Subject and Message.','warn');
            await push(ref(rtdb, 'support_tickets'), { name: currentData.name, email: currentData.email, subject: subject, message: message, role: 'Founder', status: 'open', uid: currentUserUid, timestamp: Date.now() });
            document.getElementById('supSubject').value = ''; document.getElementById('supMessage').value = ''; document.getElementById('supportModal').classList.add('hidden');
            await update(ref(rtdb, `users/${currentUserUid}`), { lastTicketAt: Date.now() });
            toast('Ticket sent! We will contact you soon.','success');
        };

        // --- SUBMIT PROJECT (20 FIELDS) ---
        window.submitProject = async () => {
            const btn = document.getElementById('pubBtn');
            // Max 5 active projects
            const activeCount = Object.values(currentData.project || {}).filter(p => p && p.nameOfIdea && p.status !== 'disabled').length;
            if (activeCount >= 5) { toast('Maximum 5 active projects allowed. Delete one to add a new one.', 'warn'); return; }
            const fields = {
                nameOfIdea: document.getElementById('pName').value, tagline: document.getElementById('pTagline').value, industry: document.getElementById('pIndustry').value, stage: projectType === 'Idea' ? 'Idea' : 'Live', website: document.getElementById('pWeb').value,
                teamSize: document.getElementById('pTeam').value, location: document.getElementById('pLoc').value, projectLink: document.getElementById('pDeck').value, videoLink: document.getElementById('pVideo').value, incDate: document.getElementById('pDate').value,
                currency: document.getElementById('pCurrency').value, fundingGoal: document.getElementById('pAmount').value, equity: document.getElementById('pEquity').value, valuation: document.getElementById('pValuation').value, minTicket: document.getElementById('pMinTicket').value,
                raised: document.getElementById('pRaised').value, revenue: document.getElementById('pRevenue').value, burn: document.getElementById('pBurn').value,
                IdeaDescription: document.getElementById('pProblem').value, solution: document.getElementById('pSolution').value
            };

            const banList = ["scam", "fraud", "guarantee", "money back", "hack", "drug", "casino", "gambling", "xxx", "100% return"];
            const combinedText = (fields.nameOfIdea + " " + fields.IdeaDescription).toLowerCase();
            const foundBadWord = banList.find(word => combinedText.includes(word));

            if (foundBadWord) {
                toast(`Restricted word "${foundBadWord}" found. Please remove it.`,'warn'); return;
            }

            btn.disabled = true; btn.textContent = "Publishing...";
            
            const pData = { ...fields, userid: currentUserUid, username: currentData.name, profilepic: currentData.profile||'', likeCount: 0, interestCount: 0, status: 'submitted', timestamp: Date.now(), type: projectType };
            const key = push(ref(rtdb, 'projects')).key;
            
            try {
                // Write full data to /projects/ (source of truth)
                await set(ref(rtdb, `projects/${key}`), pData);
                // Write lightweight ref to user node so dashboard can display it
                await set(ref(rtdb, `users/${currentUserUid}/project/${key}`), {
                    key,
                    status:       'submitted',
                    nameOfIdea:   fields.nameOfIdea  || '',
                    tagline:      fields.tagline      || '',
                    IdeaDescription: fields.IdeaDescription || '',
                    fundingGoal:  fields.fundingGoal  || '',
                    currency:     fields.currency     || 'USD',
                    interestCount: 0,
                    timestamp:    Date.now()
                });
                document.querySelectorAll('.input-field').forEach(i => i.value = '');
                toast('Project submitted! Under review by admin.', 'success');
                currentStep = 1; window.changeStep(0);
            } catch(e) { toast('Error submitting. Please try again.', 'error'); }
            finally { btn.disabled = false; btn.textContent = 'Publish Project'; }
        };

        function projectHealth(p) {
            let s = 0, max = 4;
            if (p.projectLink) s++;
            if (p.videoLink)   s++;
            if (p.valuation)   s++;
            if ((p.interestCount||0) >= 3) s++;
            return { score: s, max, pct: Math.round((s/max)*100) };
        }

        function renderProjects(projects) {
            const pGrid = document.getElementById('projectGrid'); pGrid.innerHTML = "";
            if(projects) {
                Object.entries(projects).reverse().forEach(([key, p]) => {
                    if(p.init || !p.nameOfIdea) return;
                    const ask = p.fundingGoal ? `${p.currency || 'USD'} ${parseInt(p.fundingGoal).toLocaleString()}` : 'N/A';
                    let statusBadge, extraContent = "";
                    const h = projectHealth(p);
                    const hColor = h.score >= 3 ? '#16a34a' : h.score >= 2 ? '#d97706' : '#ef4444';
                    // Use live stats from /projects/ listener (not stale lightweight ref)
                    const liveStats = _liveProjectStats[key] || {};
                    const views = liveStats.viewCount || p.viewCount || 0;
                    const interests = liveStats.interestCount || p.interestCount || 0;
                    const healthHtml = `<div style="margin-top:10px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:10.5px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;">Profile Strength</span><span style="font-size:11px;font-weight:700;color:${hColor};">${h.score}/${h.max}</span></div><div class="health-bar"><div class="health-fill" style="width:${h.pct}%;background:${hColor};"></div></div></div>`;
                    const statsRowHtml = `<div style="display:flex;align-items:center;gap:12px;margin-top:8px;"><span style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${views} views</span><span style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>${p.interestCount||0} interests</span></div>`;
                    if(p.status === 'approved') { statusBadge = `<span class="bg-emerald-100 text-emerald-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Live</span>`; } 
                    else if (p.status === 'disabled') { statusBadge = `<span class="bg-red-100 text-red-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Disabled</span>`; extraContent = `<div class="mt-4 bg-red-50 border border-red-200 p-3 rounded-lg flex flex-col gap-2"><p class="text-[10px] font-extrabold text-red-700 text-center uppercase tracking-wide leading-tight">PROJECT DISABLED: CONTACT ADMIN</p><button onclick="document.getElementById('supportModal').classList.remove('hidden')" class="w-full bg-red-600 text-white py-2 rounded-lg text-xs font-bold hover:bg-red-700 transition shadow-sm">Raise Ticket</button></div>`; } 
                    else if (p.status === 'under_review') { statusBadge = `<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Under Review</span>`; extraContent = `<div class="mt-4 bg-amber-50 border border-amber-200 p-3 rounded-lg"><p class="text-[10px] font-extrabold text-amber-700 text-center uppercase tracking-wide leading-tight">Blocked: Under Review</p></div>`; } 
                    else { statusBadge = `<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Pending</span>`; }
                    pGrid.innerHTML += `<div class="bg-white p-5 border border-slate-200 rounded-2xl shadow-sm hover:shadow-md transition-all"><div class="flex justify-between items-start mb-3"><div><h4 class="font-bold text-slate-900">${escapeHTML(p.nameOfIdea)}</h4><p class="text-xs font-bold text-slate-500 mt-1">ASK: <span class="text-slate-900">${ask}</span></p></div><div class="flex flex-col items-end gap-2">${statusBadge}<span style="font-size:11px;color:#94a3b8;">${views} views · ${interests} interests</span></div></div><p class="text-sm text-slate-600 mb-3 line-clamp-2">${escapeHTML(p.IdeaDescription||p.tagline||"")}</p>${healthHtml}<div class="border-t border-slate-100 pt-3 mt-3 flex justify-end"><button onclick="deleteProject('${key}')" class="text-xs text-red-500 font-bold bg-red-50 px-3 py-1.5 rounded-lg hover:bg-red-100 transition">Delete</button></div>${extraContent}</div>`;
                });
            }
            if(pGrid.innerHTML === "") pGrid.innerHTML = `<div style="text-align:center;padding:48px 24px;background:#f8fafc;border-radius:16px;border:1px dashed #e2e8f0;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 14px;display:block;"><path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/></svg><p style="font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">No projects yet</p><p style="font-size:13px;color:#94a3b8;margin-bottom:18px;">Use the wizard on the left to list your first idea and start getting discovered by investors.</p></div>`;
        }
        
        // ── AVATAR HELPER ─────────────────────────────────────────────────────────
        function avatarSVG(name) {
            const l=(name||'?')[0].toUpperCase(), cl=['#2563eb','#7c3aed','#059669','#d97706','#dc2626'];
            return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' rx='24' fill='${encodeURIComponent(cl[l.charCodeAt(0)%cl.length])}'/><text x='50%' y='50%' dy='.35em' fill='white' font-size='18' font-family='system-ui' text-anchor='middle'>${l}</text></svg>`;
        }

        // ── INTERESTED INVESTORS ───────────────────────────────────────────────
        function renderLikes(likes) {
            const grid = document.getElementById('likesGrid');
            grid.innerHTML = '';
            if (!likes || !Object.keys(likes).length) {
                grid.innerHTML = '<div style="text-align:center;padding:40px;background:#f8fafc;border-radius:16px;border:1px dashed #e2e8f0;"><p style="font-size:13px;color:#94a3b8;font-weight:600;">No investors have shown interest yet.</p></div>';
                return;
            }
            Object.values(likes).reverse().forEach(l => {
                const isPartner = currentData.partners && currentData.partners[l.investorId];
                const isPending = sentRequests.has(l.investorId);
                const name = escapeHTML(l.investorName || l.investorMail || 'Investor');
                const pic  = l.investorPic || avatarSVG(name);
                let btn;
                if (isPartner)      btn = `<button onclick="openChat('${l.investorId}')" style="padding:7px 16px;background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;font-size:12px;font-weight:700;border:none;border-radius:9px;cursor:pointer;">Message</button>`;
                else if (isPending) btn = `<span style="padding:7px 14px;background:#f1f5f9;color:#94a3b8;font-size:12px;font-weight:700;border-radius:9px;">Request Sent</span>`;
                else                btn = `<button onclick="sendRequest('${l.investorId}','${name}')" style="padding:7px 16px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;border:none;border-radius:9px;cursor:pointer;">Connect</button>`;
                grid.innerHTML += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 4px rgba(15,23,42,.04);margin-bottom:8px;"><div style="display:flex;align-items:center;gap:12px;min-width:0;"><img src="${pic}" onerror="this.src=avatarSVG('${name}')" style="width:44px;height:44px;border-radius:50%;object-fit:cover;background:#f1f5f9;flex-shrink:0;"><div style="min-width:0;"><p style="font-weight:700;font-size:13.5px;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</p><p style="font-size:11.5px;color:#94a3b8;margin-top:1px;">Interested in: <span style="color:#64748b;font-weight:600;">${escapeHTML(l.projectname||'your project')}</span></p></div></div><div style="flex-shrink:0;">${btn}</div></div>`;
            });
        }

        // ── CONNECTED PARTNERS ─────────────────────────────────────────────────
        function renderPartners(partners) {
            const container = document.getElementById('partnerGridContainer');
            container.innerHTML = '';
            if (!partners || !Object.keys(partners).length) {
                container.innerHTML = '<div class="col-span-full" style="text-align:center;padding:40px;background:#f8fafc;border-radius:16px;border:1px dashed #e2e8f0;"><p style="font-size:13px;color:#94a3b8;font-weight:600;">No connections yet.</p></div>';
                return;
            }
            Object.values(partners).forEach(p => {
                const pic   = p.pic || avatarSVG(p.name);
                const since = p.since ? new Date(p.since).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';
                container.innerHTML += `<div class="clean-card" style="padding:22px;display:flex;flex-direction:column;align-items:center;text-align:center;"><div style="position:relative;margin-bottom:12px;"><img src="${pic}" onerror="this.src=avatarSVG('${escapeHTML(p.name)}')" style="width:56px;height:56px;border-radius:50%;object-fit:cover;background:#f1f5f9;border:2px solid #fff;box-shadow:0 2px 8px rgba(15,23,42,.1);"><div style="position:absolute;bottom:0;right:0;width:14px;height:14px;background:#22c55e;border-radius:50%;border:2px solid #fff;"></div></div><h4 style="font-weight:700;color:#0f172a;font-size:14px;margin-bottom:2px;">${escapeHTML(p.name)}</h4><span style="font-size:10px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);color:#15803d;border:1px solid rgba(22,163,74,.18);padding:2px 10px;border-radius:50px;font-weight:700;text-transform:uppercase;">Investor</span>${since?`<p style="font-size:11px;color:#cbd5e1;margin-top:6px;">Connected ${since}</p>`:''}<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:14px;"><button onclick="viewInvestorProfile('${p.uid}')" style="padding:8px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">Profile</button><button onclick="openChat('${p.uid}')" style="padding:8px;background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">Message</button></div><button onclick="cancelPartnership('${p.uid}','${escapeHTML(p.name)}')" style="margin-top:10px;font-size:11px;color:#ef4444;background:none;border:none;cursor:pointer;font-weight:600;">Remove Connection</button></div>`;
            });
        }

        function loadInvestorDirectory() {
            const grid = document.getElementById('investorListGrid');
            // Skeleton while loading
            grid.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;width:100%;">' +
                Array(3).fill('<div style="background:#fff;border-radius:14px;padding:20px;border:1px solid #e2e8f0;"><div class="skeleton" style="width:48px;height:48px;border-radius:50%;margin-bottom:12px;"></div><div class="skeleton" style="height:14px;width:70%;margin-bottom:8px;"></div><div class="skeleton" style="height:12px;width:50%;margin-bottom:16px;"></div><div class="skeleton" style="height:36px;border-radius:9px;"></div></div>').join('') + '</div>';

            // Read approved investors from /users (rules now allow authenticated reads)
            get(ref(rtdb, 'users')).then(snap => {
                allInvestors = [];
                if (snap.exists()) {
                    snap.forEach(child => {
                        const u = child.val();
                        // Only show approved investors
                        if (u.role === 'Investor' && (u.status === 'approved' || u.status === 'live')) {
                            u.uid = child.key;
                            allInvestors.push(u);
                        }
                    });
                }
                filterInvestors();
            }).catch(err => { grid.innerHTML = '<div style="text-align:center;padding:48px 24px;">' +
                    '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 14px;display:block;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="#cbd5e1"/></svg>' +
                    '<p style="font-family:Outfit,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">Could not load directory</p>' +
                    '<p style="font-size:13px;color:#94a3b8;margin-bottom:16px;">Check your connection and try again.</p>' +
                    '<button onclick="loadInvestorDirectory()" style="padding:9px 22px;background:#0f172a;color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;">Retry</button></div>';
            });
        }
        function filterInvestors() {
            const ind=document.getElementById('invFilterIndustry').value, q=document.getElementById('invSearchInput').value.toLowerCase();
            const grid=document.getElementById('investorListGrid');
            const list=allInvestors.filter(inv=>((inv.name||'').toLowerCase().includes(q)||(inv.company||'').toLowerCase().includes(q))&&(ind==='All'||(inv.industry||'').includes(ind))&&(inv.status==='approved'||inv.status==='live'||!inv.status));
            grid.innerHTML='';
            if (!list.length) { grid.innerHTML='<div class="col-span-full" style="text-align:center;padding:40px;color:#94a3b8;font-size:13px;">No investors found.</div>'; return; }
            list.forEach(inv => {
                const isPartner=currentData.partners&&currentData.partners[inv.uid], isPending=sentRequests.has(inv.uid);
                const pic=inv.profile||avatarSVG(inv.name), tag=inv.industry?`<span style="font-size:10px;background:#eff6ff;color:#2563eb;padding:2px 8px;border-radius:5px;font-weight:700;text-transform:uppercase;">${escapeHTML(inv.industry)}</span>`:'';
                let btn;
                if (isPartner)      btn=`<button disabled style="width:100%;padding:9px;background:#f0fdf4;color:#15803d;border:1px solid rgba(22,163,74,.2);border-radius:9px;font-size:12px;font-weight:700;">Connected</button>`;
                else if (isPending) btn=`<button disabled style="width:100%;padding:9px;background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0;border-radius:9px;font-size:12px;font-weight:700;">Request Sent</button>`;
                else                btn=`<button onclick="sendRequest('${inv.uid}','${escapeHTML(inv.name)}')" style="width:100%;padding:9px;background:#0f172a;color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;" onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#0f172a'">Send Request</button>`;
                grid.innerHTML+=`<div class="clean-card fade-in" style="padding:20px;display:flex;flex-direction:column;"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;"><img src="${pic}" onerror="this.src=avatarSVG('${escapeHTML(inv.name)}')" style="width:48px;height:48px;border-radius:50%;object-fit:cover;background:#f1f5f9;">${tag}</div><h3 style="font-weight:700;color:#0f172a;font-size:15px;margin-bottom:2px;">${escapeHTML(inv.name)}</h3><p style="font-size:11.5px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px;">${escapeHTML(inv.jobTitle||'Investor')}</p><p style="font-size:13px;color:#64748b;margin-bottom:16px;">${escapeHTML(inv.company||'Independent')}</p><div style="margin-top:auto;padding-top:14px;border-top:1px solid #f8fafc;">${btn}</div></div>`;
            });
        }
        document.getElementById('invFilterIndustry').addEventListener('change', filterInvestors);
        document.getElementById('invSearchInput').addEventListener('input', filterInvestors);

        window.viewInvestorProfile = async (uid) => {
            const snap=await get(ref(rtdb,`users/${uid}`)); if(!snap.exists()) return;
            const u=snap.val();
            document.getElementById('ipName').innerText=u.name||''; document.getElementById('ipCompany').innerText=u.company||'';
            document.getElementById('ipPic').src=u.profile||avatarSVG(u.name);
            document.getElementById('ipEmail').innerText=u.email||'Hidden'; document.getElementById('ipPhone').innerText=u.phone||'Hidden';
            document.getElementById('ipTags').innerHTML=u.industry?`<span class="tag tag-blue">${escapeHTML(u.industry)}</span>`:'';
            document.getElementById('investorProfileModal').classList.remove('hidden');
        };

        window.sendRequest = async (toUid, toName) => {
            if (sentRequests.has(toUid)) return;
            if (!(await confirmDialog(`Send connection request to ${toName}?`, 'They will receive a notification and can accept or ignore.'))) return;
            try {
                await push(ref(rtdb,'requests'),{from:currentUserUid,fromName:currentData.name,fromPic:currentData.profile||'',to:toUid,status:'pending',timestamp:Date.now()});
                sentRequests.add(toUid);
                await push(ref(rtdb,`users/${toUid}/notifications`),{message:`${currentData.name} wants to connect with you.`,timestamp:Date.now(),read:false,type:'request'});
                toast('Connection request sent!','success'); filterInvestors();
            } catch(e) { toast(errMsg(e),'error'); }
        };

        window.cancelPartnership = async (uid, name) => {
            if (!(await confirmDialog(`Remove connection with ${name}?`, 'You will both lose chat access.'))) return;
            try {
                await remove(ref(rtdb, `users/${currentUserUid}/partners/${uid}`));
                await remove(ref(rtdb, `users/${uid}/partners/${currentUserUid}`));
                // Clean up stale request entries between these two users
                const reqSnap = await get(ref(rtdb, 'requests'));
                if (reqSnap.exists()) {
                    const kills = {};
                    reqSnap.forEach(c => {
                        const r = c.val();
                        if ((r.from===currentUserUid&&r.to===uid)||(r.from===uid&&r.to===currentUserUid))
                            kills[`requests/${c.key}`] = null;
                    });
                    if (Object.keys(kills).length) await update(ref(rtdb), kills);
                }
                toast('Connection removed.', 'info');
            } catch(e) { toast(errMsg(e), 'error'); }
        };

        window.deleteProject = async (key) => {
            if (!(await confirmDialog('Delete this project?', 'This is permanent and cannot be undone.'))) return;
            try {
                await remove(ref(rtdb, `projects/${key}`));
                await remove(ref(rtdb, `users/${currentUserUid}/project/${key}`));
                toast('Project deleted.', 'success');
            } catch(e) { toast(errMsg(e), 'error'); }
        };


        
        // ══════════════════════════════════════════════════════════════
        //  CHAT SYSTEM — rebuilt from scratch
        //  Uses: get() for history load + onChildAdded for live updates
        //  Encryption: AES-GCM 256, key derived via PBKDF2 from roomId
        //  No race conditions, no full re-renders, mobile-safe
        // ══════════════════════════════════════════════════════════════
        // chat state (activeChatPath + _chatKey declared at top of script)
        let chatListener    = null;
        let _chatPartnerUid = null;
        let _lastDateLabel  = null;

        // ── ENCRYPTION ─────────────────────────────────────────────────

        // ── RENDER SINGLE MESSAGE ───────────────────────────────────────
        async function renderMessage(m, box) {
            const isMe    = m.sender === currentUserUid;
            const ts      = m.timestamp ? new Date(m.timestamp) : new Date();
            const dateStr = ts.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
            const timeStr = ts.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

            // Date separator if new day
            if (dateStr !== _lastDateLabel) {
                _lastDateLabel = dateStr;
                const sep = document.createElement('div');
                sep.className = 'chat-date-sep';
                sep.innerHTML = `<span>${dateStr}</span>`;
                box.appendChild(sep);
            }

            const text = m.enc  ? await decryptMsg(m.enc, _chatKey)
                       : m.text ? m.text
                       : '[message]';

            const row  = document.createElement('div');
            row.className = `msg-row ${isMe ? 'me' : 'them'}`;
            const wrap = document.createElement('div'); wrap.className = 'msg-wrap';
            const bub  = document.createElement('div'); bub.className  = `bubble ${isMe ? 'me' : 'them'}`;
            bub.textContent = text;
            const time = document.createElement('p'); time.className = 'msg-time';
            time.textContent = timeStr;
            wrap.appendChild(bub); wrap.appendChild(time); row.appendChild(wrap);
            box.appendChild(row);
        }

        // ── OPEN CHAT ───────────────────────────────────────────────────
        window.openChat = async (uid) => {
            if (!currentData.partners || !currentData.partners[uid]) {
                toast('You must be connected to this person to chat.', 'warn'); return;
            }
            // Tear down previous session
            if (chatListener) { chatListener(); chatListener = null; }
            _chatKey = null; activeChatPath = null; _lastDateLabel = null;
            _chatPartnerUid = uid;

            const modal = document.getElementById('chatModal');
            const box   = document.getElementById('chatMessages');

            // Show loading state
            box.innerHTML = '<div class="chat-loading"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>Securing channel…</div>';
            modal.classList.remove('hidden');

            // Get partner info
            const psnap = await get(ref(rtdb, `users/${uid}`));
            if (psnap.exists()) {
                const p = psnap.val();
                document.getElementById('chatPartnerName').textContent = p.name || 'Partner';
                const av = document.getElementById('chatPartnerAvatar');
                av.src = p.profile || '';
                av.onerror = () => { av.src = avatarSVG(p.name || '?'); };
                if (!av.src) av.src = avatarSVG(p.name || '?');
            }

            // Build room path — sorted UIDs ensures both sides agree on path
            activeChatPath = `chats/${[currentUserUid, uid].sort().join('_')}`;

            // Derive encryption key (never stored, memory only)
            _chatKey = await deriveChatKey(activeChatPath);

            // ── Load existing messages once ──────────────────────────
            const histSnap = await get(ref(rtdb, activeChatPath));
            box.innerHTML = '';
            if (histSnap.exists()) {
                const msgs = [];
                histSnap.forEach(c => msgs.push(c.val()));
                for (const m of msgs) { await renderMessage(m, box); }
            } else {
                box.innerHTML = '<div class="chat-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="1.5" stroke-linecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><p style="font-family:Outfit,sans-serif;font-size:15px;font-weight:700;color:#0f172a;">No messages yet</p><p style="font-size:13px;color:#94a3b8;">Say hello to start the conversation!</p></div>';
            }
            box.scrollTop = box.scrollHeight;

            // ── Listen for NEW messages only (onChildAdded starts after existing) ──
            let skipCount = histSnap.exists() ? Object.keys(histSnap.val()).length : 0;
            chatListener = onChildAdded(ref(rtdb, activeChatPath), async snap => {
                // Skip messages that were in the initial load
                if (skipCount > 0) { skipCount--; return; }
                // Remove empty state if present
                const empty = box.querySelector('.chat-empty');
                if (empty) empty.remove();
                await renderMessage(snap.val(), box);
                box.scrollTop = box.scrollHeight;
            });

            // Focus input
            setTimeout(() => document.getElementById('chatInput')?.focus(), 100);
        };

        // ── SEND MESSAGE ────────────────────────────────────────────────
        window.sendMessage = async () => {
            const input = document.getElementById('chatInput');
            const text  = (input.value || '').trim();
            if (!text || !activeChatPath || !_chatKey) return;
            if (text.length > 1000) { toast('Message too long (max 1000 chars).', 'warn'); return; }
            input.value = '';
            input.focus();
            try {
                const enc = await encryptMsg(text, _chatKey);
                await push(ref(rtdb, activeChatPath), {
                    enc, sender: currentUserUid,
                    senderName: currentData.name || '',
                    timestamp: Date.now()
                });
            } catch(e) {
                input.value = text;
                toast('Failed to send. Check your connection.', 'error');
            }
        };

        // ── CLOSE CHAT ──────────────────────────────────────────────────
        window.closeChat = () => {
            if (chatListener) { chatListener(); chatListener = null; }
            _chatKey = null; activeChatPath = null; _chatPartnerUid = null; _lastDateLabel = null;
            document.getElementById('chatModal').classList.add('hidden');
            document.getElementById('chatMessages').innerHTML = '';
        };

        // ── CLEAR CHAT VIEW ─────────────────────────────────────────────
        window.clearCurrentChat = async () => {
            if (!(await confirmDialog('Clear your chat view?', 'This only clears your screen. The other person keeps their messages.'))) return;
            if (chatListener) { chatListener(); chatListener = null; }
            _lastDateLabel = null;
            document.getElementById('chatMessages').innerHTML = '<div class="chat-empty"><p style="font-size:13px;color:#94a3b8;font-family:DM Sans,sans-serif;">Chat view cleared.</p></div>';
        };

        // Enter key to send
        document.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey && activeChatPath && document.activeElement?.id === 'chatInput') {
                e.preventDefault(); sendMessage();
            }
        });


        window.openProfileModal = () => { document.getElementById('editName').value = currentData.name||""; document.getElementById('editPhone').value = currentData.phone||""; document.getElementById('editPic').value = currentData.profile||""; document.getElementById('editCompany').value = currentData.company||""; document.getElementById('editJob').value = currentData.jobTitle||""; document.getElementById('editIndustry').value = currentData.industry||""; document.getElementById('editAddress').value = currentData.address||""; document.getElementById('editLinkedin').value = currentData.linkedin||""; document.getElementById('profileModal').classList.remove('hidden'); };
        window.closeProfileModal = () => document.getElementById('profileModal').classList.add('hidden');
        window.saveProfile = async () => { const n = document.getElementById('editName').value; const p = document.getElementById('editPhone').value; const pic = document.getElementById('editPic').value.trim();
            if (pic && !/^https?:\/\//i.test(pic)) { toast('Profile picture must be a valid https:// URL.','warn'); return; } const comp = document.getElementById('editCompany').value; const job = document.getElementById('editJob').value; const ind = document.getElementById('editIndustry').value; const addr = document.getElementById('editAddress').value; let link = document.getElementById('editLinkedin').value.trim(); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link; if(!n) return toast('Name is required.','warn'); await update(ref(rtdb, 'users/' + currentUserUid), { name: n, phone: p, profile: pic, company: comp, jobTitle: job, industry: ind, address: addr, linkedin: link }); closeProfileModal(); toast('Profile saved!','success'); };