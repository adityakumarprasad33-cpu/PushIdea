import { auth, rtdb } from './firebase-config.js';
        import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { ref, onValue, get, push, set, update, remove, runTransaction, query, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

        window.auth = auth;
        let currentUser, userData;
        // Show welcome banner to first-time visitors
        if (!localStorage.getItem('pi_inv_welcomed')) {
            document.getElementById('welcomeBanner').style.display = 'block';
        }
        let allProjects = [], filteredProjects = [], myLikes = new Set(), myHistory = new Set(), myPartners = new Set(), allProjectsCache = {};
        function avatarSVG(name) {
            const l=(name||'?')[0].toUpperCase(), cl=['#2563eb','#7c3aed','#059669','#d97706','#dc2626'];
            return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='${encodeURIComponent(cl[l.charCodeAt(0)%cl.length])}'/><text x='50%' y='50%' dy='.35em' fill='white' font-size='24' font-family='system-ui' text-anchor='middle'>${l}</text></svg>`;
        }


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

        const escapeHTML = (str) => str ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])) : "";
        let currentModalKey = null;

        // --- FILTERS ---
        const runFilter = () => {
            const term  = document.getElementById('searchInput').value.toLowerCase();
            const ind   = document.getElementById('industryFilter').value;
            const stage = document.getElementById('stageFilter').value;
            const sort  = document.getElementById('sortFilter').value;
            const now   = Date.now();
            const DAY   = 86400000;

            filteredProjects = allProjects.filter(p => {
                const matchSearch = (p.nameOfIdea||'').toLowerCase().includes(term) || (p.tagline||'').toLowerCase().includes(term) || (p.username||'').toLowerCase().includes(term);
                const matchInd   = ind   === 'All' || (p.industry||'').includes(ind);
                const matchStage = stage === 'All' || p.type === stage || p.stage === stage;
                return matchSearch && matchInd && matchStage;
            });

            // Sort
            if (sort === 'interest') filteredProjects.sort((a,b) => (b.interestCount||0) - (a.interestCount||0));
            else if (sort === 'trending') {
                filteredProjects.sort((a,b) => {
                    const ageA = Math.max(1, (now - (a.timestamp||now)) / DAY);
                    const ageB = Math.max(1, (now - (b.timestamp||now)) / DAY);
                    return ((b.interestCount||0)/ageB) - ((a.interestCount||0)/ageA);
                });
            } else { filteredProjects.sort((a,b) => (b.timestamp||0) - (a.timestamp||0)); }

            const meta = document.getElementById('resultsMeta');
            meta.textContent = filteredProjects.length === 0 ? '' : `${filteredProjects.length} deal${filteredProjects.length===1?'':'s'} found`;
            renderGrid();
        };
        document.getElementById('searchInput').addEventListener('input', runFilter);
        document.getElementById('industryFilter').addEventListener('change', runFilter);
        document.getElementById('stageFilter').addEventListener('change', runFilter);
        document.getElementById('sortFilter').addEventListener('change', runFilter);

        // --- AUTH ---
        // Timeout fallback — if data doesn't load in 12s, show error instead of frozen skeletons
        const _loadTimeout = setTimeout(() => {
            const grid = document.getElementById('globalGrid');
            if (grid && grid.querySelector('.skeleton')) {
                grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 24px;background:#fff;border-radius:20px;border:1px solid #fee2e2;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 16px;display:block;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="#ef4444"/></svg>
                    <p style="font-family:Outfit,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:8px;">Taking too long to load</p>
                    <p style="font-size:13px;color:#94a3b8;margin-bottom:16px;">This is usually a Firebase rules issue. Make sure you have deployed the latest rtdb-rules.json to your Firebase project.</p>
                    <button onclick="window.location.reload()" style="padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Retry</button>
                </div>`;
            }
        }, 12000);

        onAuthStateChanged(auth, async (user) => {
            if (!user) { window.location.href = "index.html"; return; }

            currentUser = user;
            update(ref(rtdb, `users/${user.uid}`), { lastSeen: Date.now() }).catch(()=>{});

            // Wrap user fetch in try/catch — if this throws, everything stops silently
            let snap;
            try {
                snap = await get(ref(rtdb, 'users/' + user.uid));
            } catch(e) {
                clearTimeout(_loadTimeout);
                const grid = document.getElementById('globalGrid');
                if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 24px;background:#fff;border-radius:20px;border:1px solid #fee2e2;"><p style="font-family:Outfit,sans-serif;font-size:16px;font-weight:700;color:#dc2626;margin-bottom:8px;">Connection error</p><p style="font-size:13px;color:#94a3b8;margin-bottom:16px;">${e.message}</p><button onclick="window.location.reload()" style="padding:9px 22px;background:#0f172a;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;">Retry</button></div>`;
                return;
            }

            userData = snap.exists() ? snap.val() : null;

            // Handle missing user record in DB
            if (!userData) {
                clearTimeout(_loadTimeout);
                window.location.href = "index.html";
                return;
            }

            // Role & status guards
            if (userData.role === 'Inventor') { window.location.href = "inventor.html"; return; }
            if (userData.role === 'Admin')    { window.location.href = "admin.html"; return; }
            const status = (userData.status || '').toLowerCase();
            if (status === 'pending' || status === 'rejected') { window.location.href = "waiting.html"; return; }
            if (status === 'disabled') { toast('Your account has been disabled. Contact support.','error'); setTimeout(()=>window.location.href='index.html',2500); return; }

            // projectsReady flag — myLikes/history/partners must NOT call renderGrid()
            // until projects have loaded at least once. Without this, those 3 listeners
            // fire first with allProjects=[] and the grid shows "No deals" immediately.
            let projectsReady = false;

            onValue(ref(rtdb, `users/${user.uid}/myLikes`), (s) => {
                myLikes.clear();
                if(s.exists()) Object.keys(s.val()).forEach(k => myLikes.add(k));
                if (projectsReady) renderGrid();
            });
            onValue(ref(rtdb, `users/${user.uid}/history`), (s) => {
                myHistory.clear();
                if(s.exists()) Object.values(s.val()).forEach(h => { if(h.projectId) myHistory.add(h.projectId); });
                if (projectsReady) renderGrid();
            });
            onValue(ref(rtdb, `users/${user.uid}/partners`), (s) => {
                myPartners.clear();
                if(s.exists()) Object.keys(s.val()).forEach(k => myPartners.add(k));
                if (projectsReady) renderGrid();
            });

            // Load projects — THIS triggers the first render
            onValue(ref(rtdb, 'projects'), (s) => {
                clearTimeout(_loadTimeout);
                allProjects = [];
                if(s.exists()) {
                    s.forEach(child => {
                        let v = child.val(); v.key = child.key;
                        if(v.nameOfIdea && (v.status === 'approved' || v.status === 'live')) {
                            allProjects.push(v);
                            allProjectsCache[v.key] = v;
                        }
                    });
                    allProjects.sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
                }
                projectsReady = true;
                runFilter();
            }, (err) => {
                // Firebase read failed — permission denied or network error
                clearTimeout(_loadTimeout);
                const grid = document.getElementById('globalGrid');
                if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 24px;background:#fff;border-radius:20px;border:1px solid #fee2e2;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 16px;display:block;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    <p style="font-family:Outfit,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:8px;">Could not load marketplace</p>
                    <p style="font-size:13px;color:#94a3b8;margin-bottom:4px;">Firebase rules may be blocking this read.</p>
                    <p style="font-size:12px;color:#ef4444;margin-bottom:16px;font-family:monospace;">${err.message}</p>
                    <p style="font-size:12.5px;color:#64748b;margin-bottom:16px;">Deploy your <strong>rtdb-rules.json</strong> to Firebase Console → Realtime Database → Rules</p>
                    <button onclick="window.location.reload()" style="padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Retry</button>
                </div>`;
            });
        });

        // --- RENDER GRID ---
        function renderGrid() {
            const grid = document.getElementById('globalGrid'); while(grid.firstChild) grid.removeChild(grid.firstChild);
            if(filteredProjects.length === 0) {
                grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:64px 24px;background:#fff;border-radius:20px;border:1px dashed #e2e8f0;margin:8px 0;">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 16px;display:block;"><path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/></svg>
                  <p style="font-family:Outfit,sans-serif;font-size:17px;font-weight:700;color:#0f172a;margin-bottom:8px;">${allProjects.length===0?'No deals live yet':'No results match your filters'}</p>
                  <p style="font-size:13px;color:#94a3b8;margin-bottom:20px;">${allProjects.length===0?'Check back soon — founders are onboarding now.':'Try clearing your filters.'}</p>
                  ${allProjects.length>0?`<button onclick="document.getElementById('searchInput').value='';document.getElementById('industryFilter').value='All';document.getElementById('stageFilter').value='All';document.getElementById('sortFilter').value='newest';runFilter();" style="padding:10px 22px;background:#0f172a;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Clear Filters</button>`:''}
                </div>`;
                return;
            }

            filteredProjects.forEach(p => {
                const safeTitle = escapeHTML(p.nameOfIdea);
                const safeUser = escapeHTML(p.username);
                const safeDesc = escapeHTML(p.tagline || p.IdeaDescription || "No description.");
                const isLiked = myLikes.has(p.key);
                const isContacted = myHistory.has(p.key);
                const isPartner = myPartners.has(p.userid); // Check if they are a partner
                
                const cur = p.currency || 'USD';
                const askDisplay = p.fundingGoal ? `${cur} ${parseInt(p.fundingGoal).toLocaleString()}` : 'N/A';
                const equityDisplay = p.equity ? `${p.equity}%` : 'N/A';
                const stageTag = p.stage ? `<span class="tag tag-green ml-2">${escapeHTML(p.stage)}</span>` : '';

                const likeClass = isLiked ? "text-red-500 bg-red-50 border-red-100" : "text-slate-400 bg-white border-slate-200 hover:text-red-500 hover:border-red-200";
                
                // ── BADGES (computed from existing data) ─────────────────
                const NOW = Date.now(), DAY = 86400000;
                const isNew      = p.timestamp && (NOW - p.timestamp) < (3 * DAY);
                const isTrending = (p.interestCount||0) >= 3 && p.lastActivity && (NOW - p.lastActivity) < (2 * DAY);
                const badgesHtml = [
                    isNew      ? '<span class="badge-new">New</span>'      : '',
                    isTrending ? '<span class="badge-trending">Trending</span>' : '',
                ].filter(Boolean).join('');
                
                // --- SMART BUTTON LOGIC ---
                let connText = "Connect";
                let connClass = "bg-slate-900 text-white hover:bg-blue-600 border-transparent shadow-md";
                let disabledAttr = "";

                if (isPartner) {
                    connText = "Connected";
                    connClass = "bg-green-100 text-green-700 border-green-200 cursor-default shadow-none";
                    disabledAttr = "disabled";
                } else if (isContacted) {
                    connText = "Request Sent";
                    connClass = "bg-slate-100 text-slate-500 border-slate-200 cursor-default shadow-none";
                    disabledAttr = "disabled";
                }

                grid.innerHTML += `
                <div class="clean-card flex flex-col group fade-in">
                    <div class="p-6 flex-1">
                        <div class="flex justify-between items-start mb-4">
                            <div class="flex items-center gap-3">
                                <img src="${p.profilepic || avatarSVG(p.username)}" onerror="this.src=avatarSVG(p.username||'?')" class="w-10 h-10 rounded-full object-cover bg-slate-100 border border-slate-200">
                                <div><p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Founder</p><p class="text-sm font-bold text-slate-900 leading-none">${safeUser}</p></div>
                            </div>
                            <span class="tag tag-blue">${escapeHTML(p.industry || 'Tech')}</span>
                        </div>
                        <h3 class="text-lg font-bold text-slate-900 mb-1 group-hover:text-blue-600 transition flex items-center flex-wrap gap-2">${safeTitle} ${stageTag} ${badgesHtml}</h3>
                        <p class="text-sm text-slate-500 leading-relaxed line-clamp-2 mb-4 h-10">${safeDesc}</p>
                        
                        <div class="grid grid-cols-2 gap-2 mb-4">
                            <div class="bg-slate-50 p-2 rounded-lg border border-slate-100 text-center"><p class="text-[10px] font-bold text-slate-400 uppercase">Ask</p><p class="text-xs font-bold text-slate-900">${askDisplay}</p></div>
                            <div class="bg-slate-50 p-2 rounded-lg border border-slate-100 text-center"><p class="text-[10px] font-bold text-slate-400 uppercase">Equity</p><p class="text-xs font-bold text-slate-900">${equityDisplay}</p></div>
                        </div>
                    </div>
                    <div class="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
                        <button onclick="openModal('${p.key}')" class="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-600 text-xs font-bold hover:bg-slate-100 transition">View Data Room</button>
                        <div class="flex-1 flex gap-2 justify-end">
                            <button onclick="doLike('${p.key}', this)" ${isLiked ? 'disabled' : ''} title="${isLiked ? 'Liked' : 'Save this project'}" class="w-10 h-10 flex items-center justify-center rounded-xl transition border ${likeClass}"><svg width="17" height="17" viewBox="0 0 24 24" fill="${isLiked ? '#ef4444' : 'none'}" stroke="${isLiked ? '#ef4444' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></button>
                            <button onclick="doInterest('${p.key}', this)" ${disabledAttr} class="flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide transition border ${connClass}">${connText}</button>
                        </div>
                    </div>
                </div>`;
            });
        }

        // --- ACTIONS ---
        window.doLike = async (key, btn) => {
            if(myLikes.has(key)) return;
            btn.innerHTML = '...'; btn.disabled = true;
            myLikes.add(key); // optimistic
            const p = allProjectsCache[key];
            try {
                await runTransaction(ref(rtdb,`projects/${key}/likeCount`), c => (c||0)+1);
                // Save to myLikes (for heart button state)
                await set(ref(rtdb,`users/${currentUser.uid}/myLikes/${key}`), true);
                // ALSO save to history so it appears in "Saved Projects" on dashboard
                await set(ref(rtdb,`users/${currentUser.uid}/history/${key}`), {
                    projectTitle: p.nameOfIdea || '',
                    inventorName: p.username   || '',
                    inventorId:   p.userid     || '',
                    projectId:    key,
                    timestamp:    Date.now(),
                    savedViaLike: true   // flag: saved by like, not by sending interest
                });
                myHistory.add(key);
                renderGrid();
                toast('Project saved!', 'success');
            } catch(e) {
                myLikes.delete(key); // rollback optimistic
                toast('Error saving project. Try again.', 'error');
                renderGrid();
            }
        };

        window.doInterest = async (key, btn) => {
            if(myHistory.has(key)) return;
            if(!currentUser || !userData) { toast('Session expired. Please refresh.','warn'); return; }
            const p = allProjectsCache[key];
            if(!(await confirmDialog(`Send connection request to ${p.username}?`,'They will receive a notification.'))) return;

            btn.innerText = "..."; btn.disabled = true;
            try {
                await set(push(ref(rtdb, `users/${p.userid}/likes`)), { projectname: p.nameOfIdea, investorId: currentUser.uid, investorName: userData.name, investorMail: userData.email, investorPic: userData.profile || '', projectId: key, timestamp: Date.now() });
                await set(push(ref(rtdb, `users/${currentUser.uid}/history`)), { projectTitle: p.nameOfIdea, inventorName: p.username, inventorId: p.userid, projectId: key, timestamp: Date.now() });
                await push(ref(rtdb, 'requests'), { from: currentUser.uid, fromName: userData.name, fromPic: userData.profile, to: p.userid, status: 'pending', timestamp: Date.now() });
                await runTransaction(ref(rtdb, `projects/${key}/interestCount`), (c) => (c||0)+1);
                // Notify the founder
                await push(ref(rtdb, `users/${p.userid}/notifications`), {
                    message: `${userData.name} is interested in your project "${p.nameOfIdea}".`,
                    timestamp: Date.now(), read: false, type: 'interest'
                });
                
                myHistory.add(key); renderGrid(); toast('Connection request sent!','success');
            } catch(e) { toast('Connection failed. Please try again.','error'); renderGrid(); }
        };
        
        // --- MODAL ---
        // ── PDF DOWNLOAD HELPER ─────────────────────────────────────────────
        // Converts any doc link to a PDF-downloadable URL where possible.
        // Google Docs/Slides/Drive → export as PDF
        // Direct PDF → download directly
        // Everything else → open print dialog in new window
        window.downloadAsPdf = () => {
            const link = document.getElementById('mLink').href;
            if (!link || link === '#') return toast('No pitch deck link available.', 'warn');

            // Google Docs: convert export URL
            const gdocsMatch = link.match(/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([^/]+)/);
            if (gdocsMatch) {
                const type = gdocsMatch[1];
                const id   = gdocsMatch[2];
                const exportMap = { document:'pdf', presentation:'pdf', spreadsheets:'pdf' };
                const exportUrl = `https://docs.google.com/${type}/d/${id}/export?format=${exportMap[type]}`;
                const a = document.createElement('a');
                a.href = exportUrl; a.download = 'pitch-deck.pdf'; a.target = '_blank';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                toast('Downloading PDF…', 'success');
                return;
            }

            // Google Drive file
            const gdriveMatch = link.match(/drive\.google\.com\/file\/d\/([^/]+)/);
            if (gdriveMatch) {
                const exportUrl = `https://drive.google.com/uc?export=download&id=${gdriveMatch[1]}`;
                const a = document.createElement('a');
                a.href = exportUrl; a.download = 'pitch-deck.pdf'; a.target = '_blank';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                toast('Downloading from Google Drive…', 'success');
                return;
            }

            // Direct PDF link
            if (link.match(/\.pdf(\?.*)?$/i)) {
                const a = document.createElement('a');
                a.href = link; a.download = 'pitch-deck.pdf'; a.target = '_blank';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                toast('Downloading PDF…', 'success');
                return;
            }

            // Fallback: open in new window and trigger print dialog (user can Save as PDF)
            toast('Opening document — use File → Print → Save as PDF in the new tab.', 'info', 5000);
            const win = window.open(link, '_blank');
            if (win) {
                win.addEventListener('load', () => {
                    try { win.print(); } catch(e) {}
                }, { once: true });
            }
        };
        // ───────────────────────────────────────────────────────────────────

        window.openModal = (key) => {
            const p = allProjectsCache[key]; if(!p) return;
            currentModalKey = key;
            runTransaction(ref(rtdb, `projects/${key}/viewCount`), cur => (cur||0)+1).catch(()=>{});

            const cur = p.currency || 'USD';
            const fmt = (n) => n ? `${cur} ${parseInt(n).toLocaleString()}` : '—';

            // Header tags
            document.getElementById('mInd').innerText   = p.industry  || 'Startup';
            document.getElementById('mStage').innerText = p.stage     || (p.type === 'Live' ? 'Live' : 'Idea');
            document.getElementById('mLoc').innerText   = p.location  || 'Remote';

            // Title & tagline
            document.getElementById('mTitle').textContent   = p.nameOfIdea || '';
            document.getElementById('mTagline').textContent = p.tagline    || '';

            // Founder chip
            const inv = document.getElementById('mInventor');
            const chip = document.getElementById('mFounderChip');
            if (p.username) { inv.textContent = p.username; chip.classList.remove('hidden'); chip.classList.add('flex'); }
            else chip.classList.add('hidden');

            // Quick links — Website
            const web = document.getElementById('mWeb');
            if (p.website) { web.href = p.website; web.classList.remove('hidden'); web.classList.add('flex'); }
            else { web.classList.add('hidden'); web.classList.remove('flex'); }

            // Quick links — Video
            const vid = document.getElementById('mVideo');
            if (p.videoLink) { vid.href = p.videoLink; vid.classList.remove('hidden'); vid.classList.add('flex'); }
            else { vid.classList.add('hidden'); vid.classList.remove('flex'); }

            // Financials
            document.getElementById('mAsk').textContent    = fmt(p.fundingGoal);
            document.getElementById('mEquity').textContent = p.equity   ? `${p.equity}%`               : '—';
            document.getElementById('mVal').textContent    = fmt(p.valuation);
            document.getElementById('mMin').textContent    = fmt(p.minTicket);

            // Traction
            document.getElementById('mRev').textContent    = p.revenue  ? `${fmt(p.revenue)}/mo`  : '—';
            document.getElementById('mBurn').textContent   = p.burn     ? `${fmt(p.burn)}/mo`     : '—';
            document.getElementById('mRaised').textContent = fmt(p.raised);
            document.getElementById('mTeam').textContent   = p.teamSize || '—';

            // Problem & Solution
            document.getElementById('mProb').textContent = p.IdeaDescription || p.pProblem || 'No problem statement provided.';
            document.getElementById('mSol').textContent  = p.solution || p.pSolution || 'No solution statement provided.';

            // Company info row
            const infoRow = document.getElementById('mInfoRow');
            const incWrap = document.getElementById('mIncWrap');
            const indWrap = document.getElementById('mIndustryWrap');
            const locWrap = document.getElementById('mLocWrap');
            if (p.incDate)   { document.getElementById('mInc').textContent       = p.incDate;   incWrap.classList.remove('hidden'); } else incWrap.classList.add('hidden');
            if (p.industry)  { document.getElementById('mIndustryVal').textContent = p.industry; indWrap.classList.remove('hidden'); } else indWrap.classList.add('hidden');
            if (p.location)  { document.getElementById('mLocVal').textContent    = p.location;  locWrap.classList.remove('hidden'); } else locWrap.classList.add('hidden');
            if (p.incDate || p.industry || p.location) infoRow.classList.remove('hidden');
            else infoRow.classList.add('hidden');

            // Pitch deck + PDF
            if (p.projectLink) {
                document.getElementById('mLinkContainer').classList.remove('hidden');
                document.getElementById('mLink').href = p.projectLink;
                const urlEl = document.getElementById('mLinkUrl');
                try { urlEl.textContent = new URL(p.projectLink).hostname; } catch { urlEl.textContent = p.projectLink.slice(0,50); }
            } else {
                document.getElementById('mLinkContainer').classList.add('hidden');
            }
            
            // DYNAMIC BUTTON IN MODAL
            const modalBtnContainer = document.getElementById('modalConnectContainer');
            const isPartner = myPartners.has(p.userid);
            const isContacted = myHistory.has(p.key);
            
            if (isPartner) {
                modalBtnContainer.innerHTML = `<button class="bg-green-100 text-green-700 px-6 py-2.5 rounded-xl text-xs font-bold cursor-default">Connected</button>`;
            } else if (isContacted) {
                modalBtnContainer.innerHTML = `<button class="bg-slate-100 text-slate-500 px-6 py-2.5 rounded-xl text-xs font-bold cursor-default">Request Sent</button>`;
            } else {
                modalBtnContainer.innerHTML = `<button onclick="connectFromModal()" class="bg-slate-900 text-white px-6 py-2.5 rounded-xl text-xs font-bold hover:bg-slate-700 shadow-lg">Connect with Founder</button>`;
            }

            document.getElementById('projectModal').classList.remove('hidden'); 
        };

        window.connectFromModal = () => {
            if(!currentModalKey) return;
            const btn = document.querySelector(`button[onclick*="doInterest('${currentModalKey}'"]`);
            if(btn && !btn.disabled) window.doInterest(currentModalKey, btn);
            document.getElementById('projectModal').classList.add('hidden');
        };

        // --- SUPPORT ---
        window.submitUserSupport = async () => {
            const subject = document.getElementById('supSubject').value; const message = document.getElementById('supMessage').value;
            if(!subject || !message) return toast('Please fill in Subject and Message.','warn');
            await push(ref(rtdb, 'support_tickets'), { name: userData.name, email: userData.email, subject: subject, message: message, role: 'Investor', status: 'open', uid: currentUser.uid, timestamp: Date.now() });
            document.getElementById('supSubject').value = ""; document.getElementById('supMessage').value = ""; document.getElementById('supportModal').classList.add('hidden');
            toast('Ticket sent! We will contact you soon.','success'); document.getElementById('supportModal').classList.add('hidden');
        };

        window.reportProject = async () => {
            if(!(await confirmDialog('Report this project?','It will be flagged for admin review.'))) return;
            await push(ref(rtdb, 'support_tickets'), { name: userData.name, email: userData.email, subject: `REPORT PROJECT: ${currentModalKey}`, message: "User reported this project.", role: 'System', status: 'open', uid: currentUser.uid, timestamp: Date.now() });
            toast('Report submitted. Thank you.','info');
        };