import { auth, rtdb } from './firebase-config.js';
        import { onValue, ref, get, update, push, set, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
        import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

        // Global State & Cache
        let projectsCache = []; 
        let usersCache = []; 
        let ticketCache = {};
        let _adminUid = null;
        let _listenersSetUp = false;
        
        // Settings
        const TICKET_RETENTION = 30 * 24 * 60 * 60 * 1000; // 30 Days

        // Helper functions attached to window so HTML can trigger them
        window.escapeHTML = (str) => str ? String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])) : "";
        window.adminAvatarSVG = (name) => {
            const l = (name||'?')[0].toUpperCase();
            const c = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626'][l.charCodeAt(0)%5];
            return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='16' fill='${encodeURIComponent(c)}'/><text x='50%' y='50%' dy='.35em' fill='white' font-size='13' font-family='system-ui' text-anchor='middle'>${l}</text></svg>`;
        };

        // UI Helpers
        const _ICONS = {
            success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
            error:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>'
        };
        
        window.toast = (msg, type='info', dur=4000) => {
            const el = document.createElement('div');
            el.className = 'toast toast-'+type;
            el.innerHTML = _ICONS[type] + '<span>' + msg + '</span>';
            document.getElementById('toastContainer').appendChild(el);
            setTimeout(() => { 
                el.style.animation = 'toastOut 0.3s ease forwards'; 
                setTimeout(() => el.remove(), 300); 
            }, dur);
        };

        window.confirmDialog = (msg, sub='') => {
            return new Promise(resolve => {
                const ov = document.getElementById('confirmOverlay');
                document.getElementById('confirmMsg').textContent = msg;
                document.getElementById('confirmSub').textContent = sub;
                ov.style.display = 'flex';
                
                const ok = document.getElementById('confirmOK');
                const ca = document.getElementById('confirmCancel');
                
                const done = (val) => { 
                    ov.style.display = 'none'; 
                    ok.onclick = null; 
                    ca.onclick = null; 
                    resolve(val); 
                };
                ok.onclick = () => done(true); 
                ca.onclick = () => done(false);
            });
        };

        // System Hooks
        async function logAdminAction(action, targetKey, note='') {
            if (!_adminUid) return;
            try {
                await push(ref(rtdb, 'admin_logs'), { adminUid: _adminUid, action, targetKey: targetKey||'', note, timestamp: Date.now() });
            } catch(e) { console.warn('Audit fail:', e); }
        }

        async function sendNotification(uid, message) { 
            if(!uid) return;
            await push(ref(rtdb, `users/${uid}/notifications`), { message: message, timestamp: Date.now(), read: false, type: 'system' }); 
        }

        // --- AUTHENTICATION GATEWAY ---
        onAuthStateChanged(auth, async (user) => {
            if (!user) { window.location.href = "index.html"; return; }
            
            try {
                const snap = await get(ref(rtdb, `users/${user.uid}`));
                const userData = snap.val();
                
                // Bulletproof Admin check
                if (!userData || !userData.role || userData.role.toLowerCase() !== 'admin') { 
                    window.toast("Access denied. Admin accounts only.", "error"); 
                    setTimeout(() => window.location.href="index.html", 2000); 
                    return; 
                }
                
                _adminUid = user.uid;
                document.getElementById('securityScreen').classList.add('hidden');
                document.body.style.opacity = "1";
                
                window.loadData();
            } catch(error) {
                window.toast("Auth Error: " + error.message, "error");
            }
        });

        // Keeps UI clock ticking
        setInterval(() => { const el = document.getElementById('clock'); if (el) el.innerText = new Date().toLocaleTimeString(); }, 1000);

        // --- NAVIGATION ---
        window.switchSection = (id) => {
            ['projects','users','support'].forEach(s => {
                document.getElementById(`section-${s}`).classList.add('hidden');
                document.getElementById(`nav-${s}`).classList.remove('active');
            });
            document.getElementById(`section-${id}`).classList.remove('hidden');
            document.getElementById(`nav-${id}`).classList.add('active');
            
            const titles = { projects: "Project Approval Queue", users: "User Registry", support: "Support Inbox" };
            document.getElementById('pageTitle').innerText = titles[id];
            
            // Re-render specific section on click to ensure UI is fresh
            if (id === 'support') window.renderSupport();
            if (id === 'users') window.renderUsers();
            if (id === 'projects') {
                const activeTab = document.querySelector('#tab-pending').classList.contains('bg-slate-900') ? 'pending' : 
                                 (document.querySelector('#tab-live').classList.contains('bg-slate-900') ? 'live' : 'disabled');
                window.filterProjects(activeTab);
            }
        };

        // --- DATABASE FETCHING (Runs once on auth, listens real-time) ---
        window.loadData = () => {
            if (_listenersSetUp) return; 
            _listenersSetUp = true;

            const loader = '<tr><td colspan="5" style="padding:24px;text-align:center;"><div style="display:flex;align-items:center;justify-content:center;gap:10px;color:#94a3b8;font-size:13px;"><div style="width:18px;height:18px;border:2px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:spin .7s linear infinite;"></div>Loading…</div></td></tr>';
            document.getElementById('projectTable').innerHTML = loader;
            document.getElementById('userTable').innerHTML = loader;

            // 1. Projects
            onValue(ref(rtdb, 'projects'), (snap) => {
                projectsCache = [];
                if (snap.exists()) { snap.forEach(child => { projectsCache.push({ key: child.key, ...child.val() }); }); }
                
                // Determine which tab is active and re-render
                let currentTab = 'pending';
                if(document.getElementById('tab-live').classList.contains('bg-slate-900')) currentTab = 'live';
                if(document.getElementById('tab-disabled').classList.contains('bg-slate-900')) currentTab = 'disabled';
                window.filterProjects(currentTab);
                updateAdminStats();
            });

            // 2. Users
            onValue(ref(rtdb, 'users'), (snap) => {
                usersCache = [];
                if (snap.exists()) { snap.forEach(child => { usersCache.push({ uid: child.key, ...child.val() }); }); }
                window.renderUsers();
                updateAdminStats();
            });

            // 3. Support Tickets
            onValue(ref(rtdb, 'support_tickets'), (snap) => {
                ticketCache = snap.exists() ? snap.val() : {};
                
                // Auto-delete old tickets
                Object.entries(ticketCache).forEach(([key, t]) => {
                    if ((Date.now() - (t.timestamp||0)) > TICKET_RETENTION) {
                        remove(ref(rtdb, `support_tickets/${key}`)).catch(()=>{});
                        delete ticketCache[key];
                    }
                });
                updateAdminStats();
                window.renderSupport();
            });
        };

        // Update top KPI numbers
        function updateAdminStats() {
            const pendingUsers = usersCache.filter(u => (u.status||'pending').toLowerCase() === 'pending').length;
            const pendingProj  = projectsCache.filter(p => !p.status || p.status === 'submitted' || p.status === 'under_review').length;
            const openTickets  = Object.values(ticketCache).filter(t => (t.status||'open').toLowerCase() !== 'resolved').length;
            
            document.getElementById('sPendingUsers').textContent = pendingUsers;
            document.getElementById('sPendingProj').textContent  = pendingProj;
            document.getElementById('sOpenTickets').textContent  = openTickets;
            document.getElementById('sTotalUsers').textContent   = usersCache.length;
            
            // Red dot on sidebar
            const nav = document.getElementById('nav-support');
            if (nav) {
                let badge = nav.querySelector('.ticket-badge');
                if (openTickets > 0) {
                    if (!badge) { badge = document.createElement('span'); badge.className = 'ticket-badge'; nav.appendChild(badge); }
                    badge.textContent = openTickets;
                } else if (badge) badge.remove();
            }
        }

        // --- PROJECTS ENGINE ---
        window.filterProjects = (type) => {
            const btns = ['pending', 'live', 'disabled'];
            btns.forEach(id => {
                const b = document.getElementById(`tab-${id}`);
                b.classList.remove('bg-slate-900', 'text-white');
                b.classList.add('bg-white', 'text-slate-600', 'border');
            });
            const active = document.getElementById(`tab-${type}`);
            active.classList.remove('bg-white', 'text-slate-600', 'border');
            active.classList.add('bg-slate-900', 'text-white', 'border-transparent');

            // Bulletproof filtering
            let filtered = [];
            if (type === 'pending') filtered = projectsCache.filter(p => !p.status || p.status === 'submitted' || p.status === 'under_review');
            else if (type === 'live') filtered = projectsCache.filter(p => p.status === 'approved' || p.status === 'live');
            else filtered = projectsCache.filter(p => p.status === 'disabled');
            
            // Update tab counts safely
            document.getElementById('countPending').innerText = projectsCache.filter(p => !p.status || p.status === 'submitted' || p.status === 'under_review').length;
            document.getElementById('countLive').innerText = projectsCache.filter(p => p.status === 'approved' || p.status === 'live').length;
            document.getElementById('countDisabled').innerText = projectsCache.filter(p => p.status === 'disabled').length;
            
            const table = document.getElementById('projectTable');
            table.innerHTML = "";
            
            if (filtered.length === 0) { 
                table.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400">No projects in this queue.</td></tr>`; 
                return; 
            }
            
            // Sort newest first
            filtered.sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0));
            
            filtered.forEach(p => {
                const date = p.timestamp ? new Date(p.timestamp).toLocaleDateString() : 'N/A';
                const name = window.escapeHTML(p.nameOfIdea || p.projectName || 'Unnamed Project');
                const founder = window.escapeHTML(p.username || p.founderName || 'Unknown');
                
                let badge = type === 'pending' ? `<span class="badge bg-amber-100 text-amber-700">Pending</span>` : 
                           (type === 'live' ? `<span class="badge bg-green-100 text-green-700">Live</span>` : 
                                              `<span class="badge bg-red-100 text-red-700">Disabled</span>`);
                
                let acts = '';
                if (type === 'pending') {
                    acts = `<button onclick="reviewProject('${p.key}')" class="bg-blue-50 text-blue-600 px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-100">Review</button>`;
                } else if (type === 'live') {
                    acts = `<div class="flex justify-end gap-2"><button onclick="toggleProjectStatus('${p.key}', 'disabled')" class="bg-amber-50 text-amber-600 px-3 py-1.5 rounded border border-amber-200 text-xs font-bold">Disable</button><button onclick="deleteProject('${p.key}')" class="bg-red-50 text-red-600 px-3 py-1.5 rounded border border-red-200 text-xs font-bold">Delete</button><button onclick="reviewProject('${p.key}')" class="bg-blue-50 text-blue-600 px-3 py-1.5 rounded border border-blue-200 text-xs font-bold">Edit</button></div>`;
                } else {
                    acts = `<div class="flex justify-end gap-2"><button onclick="toggleProjectStatus('${p.key}', 'approved')" class="bg-green-50 text-green-600 px-3 py-1.5 rounded border border-green-200 text-xs font-bold">Enable</button><button onclick="deleteProject('${p.key}')" class="bg-red-50 text-red-600 px-3 py-1.5 rounded border border-red-200 text-xs font-bold">Delete</button><button onclick="reviewProject('${p.key}')" class="bg-blue-50 text-blue-600 px-3 py-1.5 rounded border border-blue-200 text-xs font-bold">View</button></div>`;
                }

                table.innerHTML += `<tr class="hover:bg-slate-50 border-b border-slate-50"><td class="p-4 font-bold text-slate-900">${name}</td><td class="p-4 text-slate-600">${founder}</td><td class="p-4 text-xs font-mono text-slate-500">${date}</td><td class="p-4">${badge}</td><td class="p-4 text-right">${acts}</td></tr>`;
            });
        };

        window.reviewProject = (key) => {
            const p = projectsCache.find(x => x.key === key); 
            if(!p) return window.toast('Project not found.','error'); 
            
            // Bulletproof mapping for the modal
            document.getElementById('rTitle').innerText = p.nameOfIdea || p.projectName || "Unnamed Project"; 
            document.getElementById('rFounder').innerText = p.username || p.founderName || "Unknown"; 
            document.getElementById('rType').innerText = p.industry || p.category || "Tech"; 
            document.getElementById('rDate').innerText = p.timestamp ? new Date(p.timestamp).toLocaleDateString() : "N/A";
            
            document.getElementById('rTagline').innerText = p.tagline || p.shortDescription || "-"; 
            document.getElementById('rProb').innerText = p.IdeaDescription || p.pProblem || p.problem || "-"; 
            document.getElementById('rSol').innerText = p.solution || p.pSolution || "-";
            
            document.getElementById('rTeam').innerText = p.teamSize || "-"; 
            document.getElementById('rLoc').innerText = p.location || "-"; 
            document.getElementById('rInc').innerText = p.incDate || "-"; 
            document.getElementById('rWeb').href = p.website || "#";
            
            const cur = p.currency || "$"; 
            document.getElementById('rAsk').innerText = `${cur} ${p.fundingGoal || p.fundingAsk || 0}`; 
            document.getElementById('rEquity').innerText = `${p.equity || 0}%`; 
            document.getElementById('rVal').innerText = `${cur} ${p.valuation || 0}`; 
            document.getElementById('rMin').innerText = `${cur} ${p.minTicket || 0}`;
            
            document.getElementById('rRev').innerText = p.revenue || "0"; 
            document.getElementById('rBurn').innerText = p.burn || "0"; 
            document.getElementById('rRaised').innerText = p.raised || "0"; 
            document.getElementById('rStage').innerText = p.stage || "Idea";
            
            document.getElementById('rDeck').href = p.projectLink || p.pitchDeck || "#"; 
            document.getElementById('rVideo').href = p.videoLink || p.demoVideo || "#";
            
            const footer = document.getElementById('modalActions');
            const status = (p.status || 'pending').toLowerCase();
            
            let fHTML = `<button onclick="document.getElementById('reviewModal').classList.add('hidden')" class="px-5 py-2.5 rounded-lg bg-slate-100 text-slate-600 text-sm font-bold hover:bg-slate-200">Close</button>`;
            
            if (status === 'approved' || status === 'live') {
                fHTML = `<button onclick="toggleProjectStatus('${key}', 'disabled'); document.getElementById('reviewModal').classList.add('hidden');" class="px-5 py-2.5 rounded-lg border border-red-200 text-red-600 text-sm font-bold hover:bg-red-50">Disable</button>` + fHTML;
            } else if (status === 'disabled') {
                fHTML = `<button onclick="toggleProjectStatus('${key}', 'approved'); document.getElementById('reviewModal').classList.add('hidden');" class="px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700 shadow-md">Enable</button>` + fHTML;
            } else {
                fHTML = `<button onclick="toggleProjectStatus('${key}', 'disabled'); document.getElementById('reviewModal').classList.add('hidden');" class="px-5 py-2.5 rounded-lg border border-red-200 text-red-600 text-sm font-bold hover:bg-red-50">Reject</button>
                         <button onclick="toggleProjectStatus('${key}', 'approved'); document.getElementById('reviewModal').classList.add('hidden');" class="px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700 shadow-md">Approve</button>` + fHTML;
            }
            footer.innerHTML = fHTML;
            document.getElementById('reviewModal').classList.remove('hidden');
        };

        window.toggleProjectStatus = async (key, status) => {
            const msg = status === 'approved' ? 'Project Approved & Live.' : 'Project Disabled.'; 
            if(!(await window.confirmDialog(msg, 'Are you sure?'))) return;
            
            try {
                await update(ref(rtdb, `projects/${key}`), { status });
                const p = projectsCache.find(x => x.key === key);
                if (p && p.userid) {
                    await update(ref(rtdb, `users/${p.userid}/project/${key}`), { status });
                    await sendNotification(p.userid, `Project Update: ${status.toUpperCase()} — "${p.nameOfIdea || 'Your Project'}"`);
                }
                await logAdminAction(`status_${status}`, key, p?.nameOfIdea||'');
                window.toast(msg, 'success'); 
            } catch(e) { window.toast(e.message, 'error'); }
        };

        window.deleteProject = async (key) => {
            if(!(await window.confirmDialog('Permanently delete project?', 'This cannot be undone.'))) return;
            const p = projectsCache.find(x => x.key === key);
            try {
                await remove(ref(rtdb, `projects/${key}`));
                if(p && p.userid) {
                    await remove(ref(rtdb, `users/${p.userid}/project/${key}`));
                    await sendNotification(p.userid, `Your project was removed by admin.`);
                }
                await logAdminAction('delete_project', key);
                window.toast('Project deleted.','success');
            } catch(e) { window.toast(e.message,'error'); }
        };


        // --- USERS ENGINE ---
        window.renderUsers = () => {
            const table = document.getElementById('userTable'); 
            const term = document.getElementById('userSearch').value.toLowerCase(); 
            const roleF = document.getElementById('roleFilter').value;
            const statusF = document.getElementById('statusFilter').value;
            
            let filtered = usersCache.filter(u => {
                const textMatch = (u.name && u.name.toLowerCase().includes(term)) || (u.email && u.email.toLowerCase().includes(term));
                const roleMatch = roleF === 'All' || u.role === roleF;
                const statMatch = statusF === 'All' || (u.status||'pending').toLowerCase() === statusF.toLowerCase();
                return textMatch && roleMatch && statMatch;
            });
            
            // Sort newest first
            filtered.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));

            table.innerHTML = "";
            if(filtered.length === 0) { table.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400">No users found.</td></tr>`; return; }

            filtered.forEach(u => {
                const stat = (u.status || 'pending').toLowerCase();
                const name = window.escapeHTML(u.name || 'Unknown User');
                const email = window.escapeHTML(u.email || 'No Email');
                const role = u.role || 'User';
                
                let badge = `<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Pending</span>`;
                if (stat === 'live' || stat === 'approved') badge = `<span class="bg-green-100 text-green-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Approved</span>`;
                else if (stat === 'disabled' || stat === 'rejected') badge = `<span class="bg-red-100 text-red-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Disabled</span>`;
                
                let controls = `<button onclick="inspectUser('${u.uid}')" class="text-xs font-bold bg-blue-50 text-blue-600 px-3 py-1.5 rounded border border-blue-200">Inspect</button>`;
                
                if (stat === 'pending') {
                    controls += `<button onclick="updateUserStatus('${u.uid}', 'approved')" class="text-xs font-bold bg-green-50 text-green-600 px-3 py-1.5 rounded border border-green-200">Approve</button>
                                 <button onclick="updateUserStatus('${u.uid}', 'disabled')" class="text-xs font-bold bg-amber-50 text-amber-600 px-3 py-1.5 rounded border border-amber-200">Reject</button>`;
                } else if (stat === 'disabled' || stat === 'rejected') {
                    controls += `<button onclick="updateUserStatus('${u.uid}', 'approved')" class="text-xs font-bold bg-green-50 text-green-600 px-3 py-1.5 rounded border border-green-200">Enable</button>`;
                } else {
                    controls += `<button onclick="updateUserStatus('${u.uid}', 'disabled')" class="text-xs font-bold bg-amber-50 text-amber-600 px-3 py-1.5 rounded border border-amber-200">Disable</button>`;
                }
                controls += `<button onclick="deleteUser('${u.uid}')" class="text-xs font-bold bg-red-50 text-red-600 px-3 py-1.5 rounded border border-red-200">Delete</button>`;

                const date = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
                const pic = u.profile || window.adminAvatarSVG(name);
                
                table.innerHTML += `
                    <tr class="border-b border-slate-50 hover:bg-slate-50">
                        <td class="p-4 flex items-center gap-3">
                            <img src="${pic}" onerror="this.src=window.adminAvatarSVG('${name}')" class="w-8 h-8 rounded-full bg-slate-200 object-cover border border-slate-200">
                            <div><p class="font-bold text-slate-900">${name}</p><p class="text-xs text-slate-500">${email}</p></div>
                        </td>
                        <td class="p-4 font-medium text-slate-600">${role}</td>
                        <td class="p-4">${badge}</td>
                        <td class="p-4 hidden md:table-cell text-xs text-slate-400">${date}</td>
                        <td class="p-4 text-right flex justify-end gap-2">${controls}</td>
                    </tr>`;
            });
        };

        window.inspectUser = (uid) => {
            const u = usersCache.find(x => x.uid === uid); if (!u) return;
            document.getElementById('mPic').src = u.profile || window.adminAvatarSVG(u.name || '?'); 
            document.getElementById('mName').innerText = u.name || "Unknown"; 
            document.getElementById('mRole').innerText = u.role || 'User'; 
            document.getElementById('mStatus').innerText = (u.status || 'pending').toLowerCase(); 
            document.getElementById('mEmail').innerText = u.email || "-"; 
            document.getElementById('mPhone').innerText = u.phone || "-"; 
            document.getElementById('mAddress').innerText = u.address || "-"; 
            document.getElementById('mCompany').innerText = u.company || "-";
            
            const link = document.getElementById('mLink'); 
            if(u.linkedin) { link.href = /^https?:\/\//.test(u.linkedin) ? u.linkedin : 'https://'+u.linkedin; link.classList.remove('hidden'); } 
            else { link.classList.add('hidden'); }
            
            document.getElementById('inspectModal').classList.remove('hidden');
        };

        window.updateUserStatus = async (uid, status) => { 
            if(!(await window.confirmDialog(`Change status to ${status.toUpperCase()}?`))) return;
            try {
                const u = usersCache.find(x => x.uid === uid);
                await update(ref(rtdb, `users/${uid}`), { status });
                
                if (status === 'approved') {
                    await sendNotification(uid, 'Your account has been verified and approved!');
                    // Investor directory sync
                    if (u && u.role === 'Investor') {
                        await set(ref(rtdb, `directory/${uid}`), {
                            uid, name: u.name||'', company: u.company||'', jobTitle: u.jobTitle||'', industry: u.industry||'', profile: u.profile||'', status: 'approved'
                        });
                    }
                } else if (status === 'disabled') {
                    remove(ref(rtdb, `directory/${uid}`)).catch(()=>{});
                }
                
                await logAdminAction(`user_${status}`, uid);
                window.toast('Status updated.', 'success');
            } catch(e) { window.toast(e.message, 'error'); } 
        };
        
        window.deleteUser = async (uid) => {
            if (uid === _adminUid) return window.toast('Cannot delete yourself.', 'warn'); 
            if(!(await window.confirmDialog('Delete this user?', 'Permanent action.'))) return;
            try {
                await remove(ref(rtdb, `users/${uid}`));
                await remove(ref(rtdb, `directory/${uid}`)).catch(()=>{});
                await logAdminAction('delete_user', uid);
                window.toast('User deleted.','success');
            } catch(e) { window.toast(e.message, 'error'); } 
        };

        // --- SUPPORT ENGINE ---
        window.renderSupport = () => {
            const grid = document.getElementById('ticketGrid'); 
            const history = document.getElementById('resolvedGrid'); 
            const term = document.getElementById('searchSupport').value.toLowerCase(); 
            
            grid.innerHTML = ""; history.innerHTML = "";
            const tickets = Object.entries(ticketCache).reverse(); // Newest first
            
            if(tickets.length === 0) {
                grid.innerHTML = `<div class="col-span-full p-12 text-center bg-white border border-dashed rounded-xl"><p class="font-bold text-slate-900">No support tickets</p></div>`;
                return;
            }

            tickets.forEach(([key, t]) => {
                const strData = JSON.stringify(t).toLowerCase();
                if (term && !strData.includes(term)) return;
                
                // Bulletproof mappings
                const time = t.timestamp ? new Date(t.timestamp).toLocaleDateString() : 'Recent';
                const role = t.role || 'User';
                const subj = window.escapeHTML(t.subject || t.issue || t.title || 'Support Request');
                const msg  = window.escapeHTML(t.message || t.description || 'No message provided.');
                const name = window.escapeHTML(t.name || t.userName || 'Anonymous');
                const stat = (t.status || 'open').toLowerCase();

                const roleColor = role === 'Investor' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600';
                const borderColor = stat === 'resolved' ? 'border-l-green-500' : 'border-l-blue-500';
                
                const html = `
                    <div class="clean-card p-5 border-l-4 ${borderColor}">
                        <div class="flex justify-between items-start mb-2"><span class="badge ${roleColor}">${role}</span><span class="text-xs text-slate-400 font-mono">${time}</span></div>
                        <h4 class="font-bold text-slate-900 text-sm mb-1">${subj}</h4>
                        <p class="text-xs text-slate-600 mb-4 line-clamp-2">${msg}</p>
                        <div class="flex justify-between items-center border-t border-slate-50 pt-3 gap-2">
                            <span class="text-xs font-bold text-slate-500 truncate max-w-[100px]">${name}</span>
                            <div class="flex gap-2">
                                ${stat !== 'resolved' ? `<button onclick="resolveAndNotify('${key}')" class="px-3 py-1.5 bg-green-50 text-green-700 text-[10px] font-bold rounded hover:bg-green-100 border border-green-200">Resolve</button>` : `<span class="text-[10px] font-bold text-green-600 px-2 py-1 bg-green-50 rounded">Resolved</span>`}
                                <button onclick="deleteTicket('${key}')" class="px-3 py-1.5 bg-red-50 text-red-600 text-[10px] font-bold rounded hover:bg-red-100 border border-red-200">Delete</button>
                            </div>
                        </div>
                    </div>`;
                    
                if (stat === 'resolved') history.innerHTML += html;
                else grid.innerHTML += html;
            });
        };

        window.resolveAndNotify = async (key) => {
            const t = ticketCache[key]; if(!t) return;
            if(!(await window.confirmDialog('Mark as resolved?', 'An email client will open to reply to the user.'))) return;
            
            await update(ref(rtdb, `support_tickets/${key}`), { status: 'resolved', resolvedAt: Date.now() });
            
            const subj = t.subject || t.issue || 'Support Ticket';
            if (t.uid && t.uid !== 'anonymous') await sendNotification(t.uid, `Your ticket "${subj}" is resolved.`);
            
            if (t.email || t.userEmail) {
                window.location.href = `mailto:${t.email || t.userEmail}?subject=${encodeURIComponent(`[Resolved] Re: ${subj} - PushIdea Support`)}&body=${encodeURIComponent(`Hi ${t.name || 'there'},\n\nThis ticket has been marked as resolved.\n\nBest,\nPushIdea Admin`)}`;
            } else {
                window.toast('Ticket resolved (No email on file).', 'success');
            }
        };

        window.deleteTicket = async (key) => { 
            if(!(await window.confirmDialog('Delete this ticket?'))) return; 
            await remove(ref(rtdb, `support_tickets/${key}`)); 
            window.toast('Ticket deleted.','success'); 
        };