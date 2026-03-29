import { auth, rtdb } from './firebase-config.js';
        import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { ref, set, push, onValue, onChildAdded, remove, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

        window.auth = auth;
        let activeChatPath = null; let currentUserUid = null; let currentData = {}; let sentRequests = new Set();
        let currentChatPartner = {}; 
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

        // ── PIPELINE FILTER STATE ─────────────────────────────────────────
        let _pipeFilter = 'all';
        let _historyCache = null;  // stored on last renderSaved call
        window.setPipeFilter = (f) => {
            _pipeFilter = f;
            ['All','Watching','Requested','Connected'].forEach((t,i) => {
                const id = ['pipeAll','pipeWatching','pipeRequested','pipeConnected'][i];
                document.getElementById(id).classList.toggle('active', f === ['all','watching','requested','connected'][i]);
            });
            if (_historyCache !== null) renderSaved(_historyCache);
        };

        const escapeHTML = (str) => str ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])) : "";

        window.switchTab = (tab) => {
            document.getElementById('pipelineBar').style.display = (tab === 'history' && _historyCache) ? 'block' : 'none';
            const views = ['viewHistory', 'viewPartners', 'viewRequests'];
            const navs = ['navHistory', 'navPartners', 'navRequests'];
            const mobNavs = ['mobHistory', 'mobPartners', 'mobRequests'];
            views.forEach(v => document.getElementById(v).classList.add('hidden'));
            navs.forEach(n => document.getElementById(n)?.classList.remove('active'));
            mobNavs.forEach(n => document.getElementById(n)?.classList.remove('active'));
            document.getElementById('view' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.remove('hidden');
            const activeNav = document.getElementById('nav' + tab.charAt(0).toUpperCase() + tab.slice(1));
            const activeMob = document.getElementById('mob' + tab.charAt(0).toUpperCase() + tab.slice(1));
            if(activeNav) activeNav.classList.add('active');
            if(activeMob) activeMob.classList.add('active');
        };

        window.toggleNotifications = async () => {
            if(window.innerWidth < 768) document.getElementById('notifModal').classList.remove('hidden');
            else document.getElementById('notificationDropdown').classList.toggle('hidden');
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
            update(ref(rtdb, `users/${user.uid}`), { lastSeen: Date.now() }).catch(()=>{});
            
            onValue(ref(rtdb, 'users/' + user.uid), (snap) => {
                const data = snap.val(); if(!data) return;
                currentData = data;
                
                if (data.status === 'pending') { window.location.href = "waiting.html"; return; }
                if (data.status === 'disabled') { toast('Your account has been disabled.','error'); setTimeout(()=>window.location.href='index.html',2000); return; }
                if (data.role === 'Admin')    { window.location.href = "admin.html"; return; }
                if (data.role !== 'Investor') { window.location.href = "inventor.html"; return; }

                document.getElementById('sideName').innerText = data.name;
                document.getElementById('sideProfilePic').src = data.profile;
                document.getElementById('mobileProfilePic').src = data.profile;
                
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
                if(notifCount > 0) { dBadge.classList.remove('hidden'); mBadge.classList.remove('hidden'); }
                else { dBadge.classList.add('hidden'); mBadge.classList.add('hidden'); }

                renderSaved(data.history); renderPartners(data.partners);
            });

            onValue(ref(rtdb, 'requests'), (snap) => {
                const reqList = document.getElementById('requestsList'); reqList.innerHTML = ""; let count = 0;
                if(snap.exists()) {
                    Object.entries(snap.val()).forEach(([key, r]) => {
                        if (r.to === currentUserUid && r.status === 'pending') {
                            count++;
                            const row = document.createElement('div');
                            row.style.cssText = 'padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f1f5f9;gap:12px;';
                            const picEl = document.createElement('img');
                            picEl.src = r.fromPic || avatarSVG(r.fromName);
                            picEl.onerror = () => { picEl.src = avatarSVG(r.fromName); };
                            picEl.style.cssText = 'width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f1f5f9;flex-shrink:0;';
                            const nameP = document.createElement('p');
                            nameP.textContent = r.fromName || 'Unknown';
                            nameP.style.cssText = 'font-weight:700;color:#0f172a;font-size:13.5px;';
                            const subP = document.createElement('p');
                            subP.textContent = 'Wants to connect with you.';
                            subP.style.cssText = 'font-size:12px;color:#94a3b8;margin-top:1px;';
                            const infoDiv = document.createElement('div');
                            infoDiv.style.cssText = 'display:flex;align-items:center;gap:12px;min-width:0;flex:1;';
                            const txtDiv = document.createElement('div'); txtDiv.appendChild(nameP); txtDiv.appendChild(subP);
                            infoDiv.appendChild(picEl); infoDiv.appendChild(txtDiv);
                            const acceptBtn = document.createElement('button');
                            acceptBtn.textContent = 'Accept';
                            acceptBtn.style.cssText = 'padding:7px 16px;background:linear-gradient(135deg,#059669,#10b981);color:#fff;font-size:12px;font-weight:700;border:none;border-radius:9px;cursor:pointer;flex-shrink:0;';
                            acceptBtn.onclick = () => acceptRequest(key, r.from, r.fromName||'', r.fromPic||'');
                            const ignoreBtn = document.createElement('button');
                            ignoreBtn.textContent = 'Ignore';
                            ignoreBtn.style.cssText = 'padding:7px 14px;background:#f8fafc;color:#64748b;font-size:12px;font-weight:700;border:1px solid #e2e8f0;border-radius:9px;cursor:pointer;flex-shrink:0;';
                            ignoreBtn.onclick = () => rejectRequest(key);
                            const btnsDiv = document.createElement('div');
                            btnsDiv.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';
                            btnsDiv.appendChild(acceptBtn); btnsDiv.appendChild(ignoreBtn);
                            row.appendChild(infoDiv); row.appendChild(btnsDiv);
                            reqList.appendChild(row);
                        }
                    });
                }
                if (count === 0) reqList.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">No pending requests.</div>`;
                const badge = document.getElementById('reqCount'); const mobBadge = document.getElementById('mobReqCount');
                if (count > 0) { badge.innerText = count; badge.classList.remove('hidden'); mobBadge.classList.remove('hidden'); } else { badge.classList.add('hidden'); mobBadge.classList.add('hidden'); }
            });
        });

        window.submitUserSupport = async () => {
            const lastTicket = currentData.lastTicketAt || 0;
            if (Date.now() - lastTicket < 300000) {
                const mins = Math.ceil((300000-(Date.now()-lastTicket))/60000);
                toast(`Please wait ${mins} more minute(s) before submitting another ticket.`,'warn'); return;
            }
            const subject = document.getElementById('supSubject').value; const message = document.getElementById('supMessage').value;
            if(!subject || !message) return toast('Please fill in Subject and Message.','warn');
            await push(ref(rtdb, 'support_tickets'), { 
                name: currentData.name, email: currentData.email, subject: subject, message: message, role: 'Investor', 
                status: 'open', uid: currentUserUid,
                timestamp: Date.now() 
            });
            document.getElementById('supSubject').value = ""; document.getElementById('supMessage').value = ""; document.getElementById('supportModal').classList.add('hidden');
            await update(ref(rtdb,`users/${currentUserUid}`),{lastTicketAt:Date.now()});
            toast('Ticket sent!','success'); document.getElementById('supportModal').classList.add('hidden');
        };

        // =============================================
        // REBUILT — Investor Dashboard Chat + Connections
        // =============================================

        function avatarSVG(name) {
            const letter = (name||'?')[0].toUpperCase();
            const colors = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2'];
            const bg = colors[letter.charCodeAt(0) % colors.length];
            return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' rx='24' fill='${encodeURIComponent(bg)}'/><text x='50%' y='50%' dy='.35em' fill='white' font-size='18' font-family='system-ui' text-anchor='middle'>${letter}</text></svg>`;
        }

        // --- RENDER SAVED (Liked) PROJECTS ---
        function renderSaved(history) {
            _historyCache = history;  // cache for pipeline re-render
            const grid = document.getElementById('historyGrid');
            grid.innerHTML = '';
            if (!history || !Object.values(history).filter(h=>h&&h.projectTitle).length) {
                grid.innerHTML = `<div class="col-span-full text-center py-12 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 14px;display:block;"><path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"/></svg><p style="font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">No saved projects yet</p><p style="font-size:13px;color:#94a3b8;margin-bottom:16px;">Browse the marketplace and like projects to save them here.</p><a href="investor.html" style="display:inline-block;padding:10px 22px;background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;border-radius:50px;text-decoration:none;">Browse Marketplace</a></div>`;
                return;
            }
            
            // Update pipeline counts
            const entries = Object.entries(history).filter(([,h])=>h&&h.projectTitle);
            const watching   = entries.filter(([,h])=>!currentData.partners||!currentData.partners[h.inventorId]);
            const requested  = entries.filter(([,h])=>!(!currentData.partners||!currentData.partners[h.inventorId])).length; // simplified
            const connected  = entries.filter(([,h])=>currentData.partners&&currentData.partners[h.inventorId]);
            document.getElementById('pipeAllNum').textContent   = entries.length;
            document.getElementById('pipeWatchNum').textContent = watching.length;
            document.getElementById('pipeReqNum').textContent   = entries.length - connected.length - watching.length >= 0 ? entries.length - connected.length - watching.length : 0;
            document.getElementById('pipeConNum').textContent   = connected.length;
            document.getElementById('pipelineBar').style.display = 'block';
            
            // Filter by pipeline
            let filtered = entries;
            if (_pipeFilter === 'watching')   filtered = watching;
            if (_pipeFilter === 'connected')  filtered = connected;
            if (_pipeFilter === 'requested')  filtered = entries.filter(([,h])=> !watching.find(([k2])=>k2===Object.entries(history).find(([,hh])=>hh===h)?.[0]) && !connected.find(([,c2])=>c2===h));
            filtered.reverse().forEach(([key, h]) => {
                if (!h || !h.projectTitle) return;
                const isPartner = currentData.partners && currentData.partners[h.inventorId];
                const chatBtn = isPartner
                    ? `<button onclick="openChat('${h.inventorId}')" style="flex:1;padding:8px;background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">Message</button>`
                    : `<button disabled style="flex:1;padding:8px;background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0;border-radius:9px;font-size:12px;font-weight:700;">Not Connected</button>`;
                grid.innerHTML += `
                <div style="background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:18px;box-shadow:0 2px 6px rgba(15,23,42,.04);transition:box-shadow .2s;" onmouseover="this.style.boxShadow='0 6px 20px rgba(15,23,42,.08)'" onmouseout="this.style.boxShadow='0 2px 6px rgba(15,23,42,.04)'">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                        <h4 style="font-weight:700;color:#0f172a;font-size:15px;line-height:1.3;flex:1;margin-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(h.projectTitle)}</h4>
                        <button onclick="revokeInterest('${key}')" style="background:none;border:none;cursor:pointer;color:#94a3b8;flex-shrink:0;padding:0;line-height:1;" title="Remove">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                    <p style="font-size:12px;color:#94a3b8;font-weight:500;margin-bottom:14px;">Founder: <span style="color:#64748b;font-weight:600;">${escapeHTML(h.inventorName||'')}</span></p>
                    <div style="display:flex;gap:8px;">${chatBtn}
                        <button onclick="revokeInterest('${key}')" style="padding:8px 12px;background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#94a3b8'">Remove</button>
                    </div>
                </div>`;
            });
        }

        // --- RENDER CONNECTED FOUNDERS ---
        function renderPartners(partners) {
            const container = document.getElementById('partnerGridContainer');
            container.innerHTML = '';
            if (!partners || !Object.values(partners).filter(p=>p&&p.name).length) {
                container.innerHTML = `<div class="col-span-full text-center py-12 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><p style="font-size:13px;color:#94a3b8;font-weight:600;">No connections yet.</p><p style="font-size:12px;color:#cbd5e1;margin-top:4px;">Accept a founder's request to start chatting.</p></div>`;
                return;
            }
            Object.values(partners).forEach(p => {
                if (!p || !p.name) return;
                const pic = p.pic || avatarSVG(p.name);
                const since = p.since ? new Date(p.since).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';
                container.innerHTML += `
                <div class="clean-card" style="padding:22px;display:flex;flex-direction:column;align-items:center;text-align:center;">
                    <div style="position:relative;margin-bottom:12px;">
                        <img src="${pic}" onerror="this.src='${avatarSVG(p.name)}'" style="width:56px;height:56px;border-radius:50%;object-fit:cover;background:#f1f5f9;border:2px solid #fff;box-shadow:0 2px 8px rgba(15,23,42,.1);">
                        <div style="position:absolute;bottom:0;right:0;width:14px;height:14px;background:#22c55e;border-radius:50%;border:2px solid #fff;"></div>
                    </div>
                    <h4 style="font-weight:700;color:#0f172a;font-size:14px;margin-bottom:2px;">${escapeHTML(p.name)}</h4>
                    <span style="font-size:10px;background:#eff6ff;color:#2563eb;border:1px solid rgba(37,99,235,.15);padding:2px 10px;border-radius:50px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;">Founder</span>
                    ${since ? `<p style="font-size:11px;color:#cbd5e1;margin-top:6px;">Connected ${since}</p>` : ''}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:14px;">
                        <button onclick="viewFounderProfile('${p.uid}')" style="padding:8px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">Profile</button>
                        <button onclick="openChat('${p.uid}')" style="padding:8px;background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(37,99,235,.2);">Message</button>
                    </div>
                    <button onclick="inspectFounderAssets('${p.uid}','${escapeHTML(p.name)}')" style="width:100%;margin-top:8px;padding:8px;background:#0f172a;color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;" onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">View Projects</button>
                    <button onclick="cancelPartnership('${p.uid}','${escapeHTML(p.name)}')" style="margin-top:8px;font-size:11px;color:#ef4444;background:none;border:none;cursor:pointer;font-weight:600;">Remove Connection</button>
                </div>`;
            });
        }

        // --- VIEW FOUNDER PROFILE ---
        window.viewFounderProfile = async (uid) => {
            const snap = await get(ref(rtdb, `users/${uid}`));
            if (!snap.exists()) return;
            const u = snap.val();
            document.getElementById('fpName').innerText  = u.name || '';
            document.getElementById('fpPic').src         = u.profile || avatarSVG(u.name);
            document.getElementById('fpEmail').innerText = u.email || 'Hidden';
            document.getElementById('fpPhone').innerText = u.phone || 'Hidden';
            document.getElementById('founderProfileModal').classList.remove('hidden');
        };

        // --- INSPECT FOUNDER'S PROJECTS ---
        window.inspectFounderAssets = async (founderId, founderName) => {
            document.getElementById('inspectName').innerText = founderName;
            const box = document.getElementById('inspectContent');
            box.innerHTML = '<div style="display:flex;justify-content:center;padding:40px;"><div style="width:32px;height:32px;border:3px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite;"></div></div>';
            document.getElementById('inspectModal').classList.remove('hidden');
            const snap = await get(ref(rtdb, 'projects'));
            box.innerHTML = '';
            let found = false;
            if (snap.exists()) {
                snap.forEach(c => {
                    const p = c.val();
                    if (p.userid === founderId && p.nameOfIdea) {
                        found = true;
                        const ask = p.fundingGoal ? `${p.currency||'USD'} ${parseInt(p.fundingGoal).toLocaleString()}` : 'N/A';
                        box.innerHTML += `
                        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;box-shadow:0 1px 4px rgba(15,23,42,.04);">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                                <h4 style="font-weight:700;color:#0f172a;font-size:14.5px;">${escapeHTML(p.nameOfIdea)}</h4>
                                <span style="font-size:10.5px;background:#eff6ff;color:#2563eb;padding:3px 9px;border-radius:6px;font-weight:700;flex-shrink:0;margin-left:8px;">ASK: ${ask}</span>
                            </div>
                            <p style="font-size:13px;color:#64748b;line-height:1.6;margin-bottom:12px;">${escapeHTML(p.IdeaDescription||'')}</p>
                            ${p.projectLink ? `<a href="${p.projectLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;font-size:12px;font-weight:700;color:#2563eb;background:#eff6ff;padding:6px 14px;border-radius:8px;text-decoration:none;">View Pitch Deck →</a>` : ''}
                        </div>`;
                    }
                });
            }
            if (!found) box.innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8;font-size:13px;">No public projects from this founder.</div>`;
        };
        window.closeInspect = () => document.getElementById('inspectModal').classList.add('hidden');

        // --- ACCEPT REQUEST ---
        // FIX: delete the request after accepting (was only updating status, never cleaned up)
        window.acceptRequest = async (reqKey, founderUid, fName, fPic) => {
            try {
                await update(ref(rtdb, `users/${currentUserUid}/partners/${founderUid}`), {
                    name: fName, pic: fPic||'', uid: founderUid, role: 'Inventor', since: Date.now()
                });
                await update(ref(rtdb, `users/${founderUid}/partners/${currentUserUid}`), {
                    name: currentData.name, pic: currentData.profile||'', uid: currentUserUid, role: 'Investor', since: Date.now()
                });
                // Delete the request entirely — no need to keep it as 'accepted'
                await remove(ref(rtdb, `requests/${reqKey}`));
                // Notify the founder
                await push(ref(rtdb, `users/${founderUid}/notifications`), {
                    message: `${currentData.name} accepted your connection request. You can now chat!`,
                    timestamp: Date.now(), read: false, type: 'connected'
                });
                toast('Connection accepted! Chat is now unlocked.','success');
            } catch(e) { toast('Error: '+e.message,'error'); }
        };

        // --- REJECT / IGNORE REQUEST ---
        // FIX: delete entirely, not just mark ignored
        window.rejectRequest = async (reqKey) => {
            if (!(await confirmDialog('Ignore this request?',''))) return;
            await remove(ref(rtdb, `requests/${reqKey}`));
        };

        // --- REMOVE PARTNERSHIP ---
        window.cancelPartnership = async (partnerUid, partnerName) => {
            if (!(await confirmDialog(`Remove connection with ${partnerName}?`,'You will both lose access to your shared chat.'))) return;
            try {
                await remove(ref(rtdb, `users/${currentUserUid}/partners/${partnerUid}`));
                await remove(ref(rtdb, `users/${partnerUid}/partners/${currentUserUid}`));
            } catch(e) { toast('Error: '+e.message,'error'); }
        };

        // --- REMOVE SAVED PROJECT ---
        window.revokeInterest = async (key) => {
            if (!(await confirmDialog('Remove this saved project?',''))) return;
            try { await remove(ref(rtdb, `users/${currentUserUid}/history/${key}`)); }
            catch(e) { }
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
            const ccEl = document.getElementById('chatCharCount');
            if (ccEl) { ccEl.style.display='none'; ccEl.textContent=''; }
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
        window.saveProfile = async () => { const n = document.getElementById('editName').value; const p = document.getElementById('editPhone').value; const pic = document.getElementById('editPic').value; const comp = document.getElementById('editCompany').value; const job = document.getElementById('editJob').value; const ind = document.getElementById('editIndustry').value; const addr = document.getElementById('editAddress').value; let link = document.getElementById('editLinkedin').value.trim(); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link; if(!n) return toast('Name is required.','warn'); await update(ref(rtdb, 'users/' + currentUserUid), { name: n, phone: p, profile: pic, company: comp, jobTitle: job, industry: ind, address: addr, linkedin: link }); closeProfileModal(); toast('Profile saved!','success'); };