/**
 * WhatsApp AI Bridge - Control Dashboard Client Logic
 */

// State
let appState = {
    status: 'CONNECTING',
    contacts: {},
    activeTab: 'all',
    searchQuery: '',
    isEditingConfig: false
};

// DOM Elements
const el = {
    // Nav & Connection
    statusBadge: document.getElementById('connectionStatusBadge'),
    statusText: document.getElementById('connectionStatusText'),
    btnRestartSocket: document.getElementById('btnRestartSocket'),
    btnLogout: document.getElementById('btnLogout'),

    // Stats
    statReceived: document.getElementById('statReceived'),
    statReplies: document.getElementById('statReplies'),
    statWhitelisted: document.getElementById('statWhitelisted'),
    statUptime: document.getElementById('statUptime'),

    // Connection Views
    viewConnected: document.getElementById('viewConnected'),
    viewQR: document.getElementById('viewQR'),
    connectedUserName: document.getElementById('connectedUserName'),
    connectedUserPhone: document.getElementById('connectedUserPhone'),
    qrImage: document.getElementById('qrImage'),
    qrLoading: document.getElementById('qrLoading'),

    // Pairing Code
    pairingPhoneInput: document.getElementById('pairingPhoneInput'),
    btnGetPairingCode: document.getElementById('btnGetPairingCode'),
    pairingCodeDisplay: document.getElementById('pairingCodeDisplay'),
    pairingCodeValue: document.getElementById('pairingCodeValue'),

    // Master Switch & Modes
    masterToggle: document.getElementById('masterToggle'),
    masterStatusBadge: document.getElementById('masterStatusBadge'),
    whitelistModeSelect: document.getElementById('whitelistModeSelect'),
    allowGroupsSelect: document.getElementById('allowGroupsSelect'),

    // Contacts
    contactsList: document.getElementById('contactsList'),
    noContactsMsg: document.getElementById('noContactsMsg'),
    contactSearchInput: document.getElementById('contactSearchInput'),
    filterTabs: document.querySelectorAll('.tab-btn'),
    countAll: document.getElementById('countAll'),
    countWhitelisted: document.getElementById('countWhitelisted'),
    countDisabled: document.getElementById('countDisabled'),
    btnOpenAddContact: document.getElementById('btnOpenAddContact'),

    // Settings & Key Pool
    keyPoolBadge: document.getElementById('keyPoolBadge'),
    keyPoolList: document.getElementById('keyPoolList'),
    btnTestGroq: document.getElementById('btnTestGroq'),
    groqTestFeedback: document.getElementById('groqTestFeedback'),
    modelSelect: document.getElementById('modelSelect'),
    tempRange: document.getElementById('tempRange'),
    tempValue: document.getElementById('tempValue'),
    tokensRange: document.getElementById('tokensRange'),
    tokensValue: document.getElementById('tokensValue'),
    defaultPromptInput: document.getElementById('defaultPromptInput'),
    btnSaveConfig: document.getElementById('btnSaveConfig'),
    presetChips: document.querySelectorAll('.preset-chip'),

    // Console
    consoleFeed: document.getElementById('consoleFeed'),
    btnClearLogs: document.getElementById('btnClearLogs'),
    btnClearContext: document.getElementById('btnClearContext'),

    // Modal
    contactModal: document.getElementById('contactModal'),
    modalTitle: document.getElementById('modalTitle'),
    modalJid: document.getElementById('modalJid'),
    modalPhone: document.getElementById('modalPhone'),
    modalName: document.getElementById('modalName'),
    modalEnabled: document.getElementById('modalEnabled'),
    modalEnabledLabel: document.getElementById('modalEnabledLabel'),
    modalCustomPrompt: document.getElementById('modalCustomPrompt'),
    btnCloseModal: document.getElementById('btnCloseModal'),
    btnCancelModal: document.getElementById('btnCancelModal'),
    btnSaveContactModal: document.getElementById('btnSaveContactModal'),

    // Toast
    toast: document.getElementById('toast')
};

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    fetchStatus();
    // Poll status every 2.5 seconds
    setInterval(fetchStatus, 2500);
});

// -------------------------------------------------------------
// Event Listeners Setup
// -------------------------------------------------------------
function initEventListeners() {
    // Master Toggle
    el.masterToggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        updateMasterBadge(enabled);
        await savePartialConfig({ masterEnabled: enabled });
        showToast(enabled ? 'Master AI Auto-Responder Activated' : 'Master AI Auto-Responder Paused');
    });

    // Whitelist Mode Change
    el.whitelistModeSelect.addEventListener('change', async (e) => {
        await savePartialConfig({ whitelistMode: e.target.value });
        showToast('Whitelist mode updated');
    });

    // Allow Groups Change
    el.allowGroupsSelect.addEventListener('change', async (e) => {
        await savePartialConfig({ allowGroups: e.target.value === 'true' });
        showToast('Group chats policy updated');
    });

    // Contacts Filter Tabs
    el.filterTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            el.filterTabs.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.activeTab = btn.dataset.filter;
            renderContacts();
        });
    });

    // Contact Search
    el.contactSearchInput.addEventListener('input', (e) => {
        appState.searchQuery = e.target.value.toLowerCase().trim();
        renderContacts();
    });

    // Open Add Contact Modal
    el.btnOpenAddContact.addEventListener('click', () => {
        openContactModal();
    });

    // Modal Close
    el.btnCloseModal.addEventListener('click', closeContactModal);
    el.btnCancelModal.addEventListener('click', closeContactModal);
    el.modalEnabled.addEventListener('change', (e) => {
        el.modalEnabledLabel.textContent = e.target.checked ? 'Enabled (AI will reply)' : 'Disabled (AI will ignore)';
    });
    el.btnSaveContactModal.addEventListener('click', handleSaveContactModal);

    // Save Groq Settings
    el.btnSaveConfig.addEventListener('click', handleSaveSettings);

    // Test Groq Key Pool
    el.btnTestGroq.addEventListener('click', handleTestGroqKey);

    // Sliders
    el.tempRange.addEventListener('input', (e) => {
        el.tempValue.textContent = e.target.value;
    });
    el.tokensRange.addEventListener('input', (e) => {
        el.tokensValue.textContent = e.target.value;
    });

    // Preset Prompt Chips
    el.presetChips.forEach(chip => {
        chip.addEventListener('click', () => {
            el.defaultPromptInput.value = chip.dataset.prompt;
            showToast('Preset prompt applied');
        });
    });

    // Pairing Code Request
    el.btnGetPairingCode.addEventListener('click', handleGetPairingCode);

    // WhatsApp Socket Actions
    el.btnRestartSocket.addEventListener('click', async () => {
        if (!confirm('Restart WhatsApp socket?')) return;
        try {
            await fetch('/api/auth/restart', { method: 'POST' });
            showToast('Restarting WhatsApp connection...');
            fetchStatus();
        } catch (err) {
            showToast('Failed to restart socket', true);
        }
    });

    el.btnLogout.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to log out? This will delete local authentication credentials and generate a fresh QR code.')) return;
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
            showToast('Logged out. Re-initializing QR...');
            fetchStatus();
        } catch (err) {
            showToast('Failed to logout', true);
        }
    });

    // Clear Feed
    el.btnClearLogs.addEventListener('click', async () => {
        await fetch('/api/logs/clear', { method: 'POST' });
        el.consoleFeed.innerHTML = '<div class="terminal-placeholder">Console logs cleared.</div>';
    });

    // Reset Memory Context
    if (el.btnClearContext) {
        el.btnClearContext.addEventListener('click', async () => {
            if (!confirm('Reset conversation context memory for all contacts?')) return;
            try {
                await fetch('/api/history/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
                showToast('All contact conversation memory reset');
            } catch (err) {
                showToast('Failed to reset memory', true);
            }
        });
    }
}

// -------------------------------------------------------------
// Fetch & Sync System Status
// -------------------------------------------------------------
async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('Network error');
        const data = await res.json();

        appState.status = data.status;
        appState.contacts = data.contacts || {};

        // 1. Connection Status Badge
        updateConnectionBadge(data.status);

        // 2. Connection View (Connected vs QR Code)
        if (data.status === 'CONNECTED') {
            el.viewConnected.classList.remove('hidden');
            el.viewQR.classList.add('hidden');
            const userName = data.connectedUser?.name || 'WhatsApp User';
            const userPhone = data.connectedUser?.id ? data.connectedUser.id.split(':')[0] : 'Linked';
            el.connectedUserName.textContent = userName;
            el.connectedUserPhone.textContent = `+${userPhone}`;
        } else {
            el.viewConnected.classList.add('hidden');
            el.viewQR.classList.remove('hidden');

            if (data.status === 'QR_READY' && data.qr) {
                el.qrImage.src = data.qr;
                el.qrLoading.classList.add('hidden');
            } else {
                el.qrLoading.classList.remove('hidden');
            }
        }

        // 3. Stats Ribbon
        el.statReceived.textContent = data.stats?.messagesReceived || 0;
        el.statReplies.textContent = data.stats?.repliesSent || 0;
        
        // Count Whitelisted
        const contactEntries = Object.values(appState.contacts);
        const whitelistedCount = contactEntries.filter(c => c.enabled).length;
        el.statWhitelisted.textContent = whitelistedCount;

        // Uptime Formatter
        const uptimeSecs = data.stats?.uptimeSeconds || 0;
        const mins = Math.floor(uptimeSecs / 60);
        const hours = Math.floor(mins / 60);
        el.statUptime.textContent = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;

        // 4. Master Switch Sync (only if user is not actively toggling)
        if (document.activeElement !== el.masterToggle) {
            el.masterToggle.checked = !!data.masterEnabled;
            updateMasterBadge(data.masterEnabled);
        }

        // 5. Config Fields Sync (only on initial load or if not focused)
        if (!appState.initialConfigLoaded) {
            el.whitelistModeSelect.value = data.whitelistMode || 'only_whitelisted';
            el.allowGroupsSelect.value = data.allowGroups ? 'true' : 'false';
            el.modelSelect.value = data.model || 'llama-3.3-70b-versatile';
            el.tempRange.value = data.temperature !== undefined ? data.temperature : 0.7;
            el.tempValue.textContent = el.tempRange.value;
            el.tokensRange.value = data.maxTokens || 300;
            el.tokensValue.textContent = el.tokensRange.value;
            el.defaultPromptInput.value = data.defaultPrompt || '';
            appState.initialConfigLoaded = true;
        }

        // 6. Render Groq Key Pool Cards
        renderKeyPool(data.keyStats || [], data.keysCount || 0);

        // 6. Render Contacts List
        renderContacts();

        // 7. Render Logs Console
        renderLogs(data.recentLogs || []);

    } catch (err) {
        updateConnectionBadge('DISCONNECTED');
    }
}

// -------------------------------------------------------------
// Connection & Master Badges
// -------------------------------------------------------------
function updateConnectionBadge(status) {
    el.statusBadge.className = 'status-pill';
    switch (status) {
        case 'CONNECTED':
            el.statusBadge.classList.add('status-connected');
            el.statusText.textContent = 'Connected';
            break;
        case 'QR_READY':
            el.statusBadge.classList.add('status-qr');
            el.statusText.textContent = 'Scan QR Code';
            break;
        case 'CONNECTING':
            el.statusBadge.classList.add('status-connecting');
            el.statusText.textContent = 'Connecting...';
            break;
        default:
            el.statusBadge.classList.add('status-disconnected');
            el.statusText.textContent = 'Disconnected';
            break;
    }
}

function updateMasterBadge(enabled) {
    if (enabled) {
        el.masterStatusBadge.className = 'badge badge-success';
        el.masterStatusBadge.textContent = 'ACTIVE';
    } else {
        el.masterStatusBadge.className = 'badge badge-muted';
        el.masterStatusBadge.textContent = 'PAUSED';
    }
}

// -------------------------------------------------------------
// Contact Whitelist Rendering & Actions
// -------------------------------------------------------------
function renderContacts() {
    const contacts = Object.entries(appState.contacts);

    // Update Counts in tabs
    const totalCount = contacts.length;
    const whitelistedCount = contacts.filter(([_, c]) => c.enabled).length;
    const disabledCount = totalCount - whitelistedCount;

    el.countAll.textContent = totalCount;
    el.countWhitelisted.textContent = whitelistedCount;
    el.countDisabled.textContent = disabledCount;

    // Filter by Tab and Search
    const filtered = contacts.filter(([jid, c]) => {
        // Tab filter
        if (appState.activeTab === 'whitelisted' && !c.enabled) return false;
        if (appState.activeTab === 'disabled' && c.enabled) return false;

        // Search query
        if (appState.searchQuery) {
            const name = (c.name || '').toLowerCase();
            const phone = (c.phone || jid).toLowerCase();
            return name.includes(appState.searchQuery) || phone.includes(appState.searchQuery);
        }
        return true;
    });

    if (filtered.length === 0) {
        el.contactsList.innerHTML = '';
        el.noContactsMsg.classList.remove('hidden');
        return;
    }

    el.noContactsMsg.classList.add('hidden');
    el.contactsList.innerHTML = filtered.map(([jid, c]) => {
        const initials = getInitials(c.name || c.phone || 'User');
        const hasCustomPrompt = c.customPrompt && c.customPrompt.trim().length > 0;
        const lastMsgSnippet = c.lastMessage ? `"${escapeHtml(c.lastMessage)}"` : 'No message recorded yet';

        return `
            <div class="contact-card ${c.enabled ? 'is-whitelisted' : ''}" data-jid="${escapeHtml(jid)}">
                <div class="contact-left">
                    <div class="contact-avatar ${c.enabled ? 'avatar-active' : ''}">
                        ${initials}
                    </div>
                    <div class="contact-details">
                        <div class="contact-header">
                            <span class="contact-name">${escapeHtml(c.name || 'Unnamed')}</span>
                            <span class="contact-phone">+${escapeHtml(c.phone || jid.split('@')[0])}</span>
                        </div>
                        <div class="contact-preview">${lastMsgSnippet}</div>
                        ${hasCustomPrompt ? `
                            <div class="prompt-tag">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                </svg>
                                Custom Prompt
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="contact-actions">
                    <button class="btn btn-secondary btn-sm" onclick="editContact('${escapeHtml(jid)}')">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                        </svg>
                        Edit
                    </button>
                    <label class="switch" title="Toggle AI Auto-Responder for this contact">
                        <input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleContact('${escapeHtml(jid)}', this.checked)">
                        <span class="slider"></span>
                    </label>
                    <button class="btn-icon btn-danger-outline" onclick="deleteContact('${escapeHtml(jid)}')" title="Delete contact">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Instant Toggle Contact Whitelist Status
async function toggleContact(jid, enabled) {
    try {
        const res = await fetch('/api/contacts/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid, enabled })
        });
        if (!res.ok) throw new Error('Toggle failed');
        if (appState.contacts[jid]) {
            appState.contacts[jid].enabled = enabled;
        }
        renderContacts();
        showToast(enabled ? 'Contact whitelisted for AI responses' : 'Contact disabled from AI responses');
    } catch (err) {
        showToast('Failed to update contact toggle', true);
        fetchStatus();
    }
}

// Delete Contact
async function deleteContact(jid) {
    const contact = appState.contacts[jid];
    const name = contact ? contact.name : jid;
    if (!confirm(`Remove "${name}" from contact list?`)) return;

    try {
        const res = await fetch(`/api/contacts/${encodeURIComponent(jid)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        delete appState.contacts[jid];
        renderContacts();
        showToast(`Contact removed`);
    } catch (err) {
        showToast('Failed to delete contact', true);
    }
}

// Open Contact Modal (Add or Edit)
function openContactModal(jid = null) {
    el.modalJid.value = jid || '';
    if (jid && appState.contacts[jid]) {
        const c = appState.contacts[jid];
        el.modalTitle.textContent = `Edit Contact: ${c.name || c.phone}`;
        el.modalPhone.value = c.phone || jid.split('@')[0];
        el.modalPhone.disabled = true; // Cannot edit phone for existing jid
        el.modalName.value = c.name || '';
        el.modalEnabled.checked = !!c.enabled;
        el.modalEnabledLabel.textContent = c.enabled ? 'Enabled (AI will reply)' : 'Disabled (AI will ignore)';
        el.modalCustomPrompt.value = c.customPrompt || '';
    } else {
        el.modalTitle.textContent = 'Add Contact to Whitelist';
        el.modalPhone.value = '';
        el.modalPhone.disabled = false;
        el.modalName.value = '';
        el.modalEnabled.checked = true;
        el.modalEnabledLabel.textContent = 'Enabled (AI will reply)';
        el.modalCustomPrompt.value = '';
    }
    el.contactModal.classList.remove('hidden');
}

function editContact(jid) {
    openContactModal(jid);
}

function closeContactModal() {
    el.contactModal.classList.add('hidden');
}

async function handleSaveContactModal() {
    const jid = el.modalJid.value;
    const phone = el.modalPhone.value.trim();
    const name = el.modalName.value.trim();
    const enabled = el.modalEnabled.checked;
    const customPrompt = el.modalCustomPrompt.value.trim();

    if (!jid && !phone) {
        alert('Please enter a phone number');
        return;
    }

    try {
        const res = await fetch('/api/contacts/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid, phone, name, enabled, customPrompt })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to save');

        showToast('Contact saved successfully');
        closeContactModal();
        fetchStatus();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// -------------------------------------------------------------
// Settings Actions & Key Pool Testing
// -------------------------------------------------------------
function renderKeyPool(keyStats, count) {
    if (el.keyPoolBadge) {
        el.keyPoolBadge.textContent = `${count} KEYS ACTIVE`;
    }
    if (!el.keyPoolList || keyStats.length === 0) return;

    el.keyPoolList.innerHTML = keyStats.map(k => {
        const isCooling = !!k.isCoolingDown;
        return `
            <div class="key-card ${isCooling ? 'key-cooling' : ''}">
                <div class="key-info">
                    <span class="key-badge">KEY #${k.index}</span>
                    <span class="key-masked">${escapeHtml(k.masked)}</span>
                    <span class="key-stat">Calls: ${k.calls} | Errors: ${k.errors}${isCooling ? ` | Cooldown: ${k.cooldownSeconds}s` : ''}</span>
                </div>
                <div class="key-status-dot ${isCooling ? 'dot-yellow' : 'dot-green'}" title="${isCooling ? `Cooling down (${k.cooldownSeconds}s left)` : 'Key Healthy & Ready'}"></div>
            </div>
        `;
    }).join('');
}

async function handleSaveSettings() {
    const payload = {
        model: el.modelSelect.value,
        temperature: parseFloat(el.tempRange.value),
        maxTokens: parseInt(el.tokensRange.value, 10),
        defaultPrompt: el.defaultPromptInput.value.trim()
    };

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) throw new Error('Save failed');
        showToast('Groq settings saved successfully!');
    } catch (err) {
        showToast('Failed to save settings', true);
    }
}

async function handleTestGroqKey() {
    const model = el.modelSelect.value;

    el.groqTestFeedback.className = 'test-feedback';
    el.groqTestFeedback.textContent = 'Testing Multi-Key Pool with Groq LPU...';

    try {
        const res = await fetch('/api/groq/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        const data = await res.json();
        if (data.success) {
            el.groqTestFeedback.className = 'test-feedback success';
            el.groqTestFeedback.textContent = `✓ Success via Key #${data.keyIndex} (${data.keyUsed}): "${data.reply}"`;
            if (data.keyStats) renderKeyPool(data.keyStats, data.keyStats.length);
        } else {
            throw new Error(data.error || 'Test failed');
        }
    } catch (err) {
        el.groqTestFeedback.className = 'test-feedback error';
        el.groqTestFeedback.textContent = `✗ Error: ${err.message}`;
    }
}

async function savePartialConfig(updates) {
    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
    } catch (err) {
        console.error('Config update error:', err);
    }
}

// -------------------------------------------------------------
// Pairing Code Generator
// -------------------------------------------------------------
async function handleGetPairingCode() {
    const phoneNumber = el.pairingPhoneInput.value.trim();
    if (!phoneNumber) {
        alert('Please enter your phone number with country code (e.g. 919876543210)');
        return;
    }

    el.btnGetPairingCode.disabled = true;
    el.btnGetPairingCode.textContent = 'Requesting...';

    try {
        const res = await fetch('/api/auth/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });
        const data = await res.json();
        if (data.success && data.code) {
            el.pairingCodeValue.textContent = data.code;
            el.pairingCodeDisplay.classList.remove('hidden');
            showToast('Pairing code generated! Check your phone.');
        } else {
            throw new Error(data.error || 'Could not generate code');
        }
    } catch (err) {
        alert(`Pairing Code Error: ${err.message}`);
    } finally {
        el.btnGetPairingCode.disabled = false;
        el.btnGetPairingCode.textContent = 'Get Pairing Code';
    }
}

// -------------------------------------------------------------
// Console Logs Feed
// -------------------------------------------------------------
let lastLogId = null;

function renderLogs(logs) {
    if (!logs || logs.length === 0) return;
    if (logs[0]?.id === lastLogId) return; // No new logs

    lastLogId = logs[0]?.id;
    el.consoleFeed.innerHTML = logs.map(l => {
        return `
            <div class="log-entry">
                <span class="log-time">[${escapeHtml(l.time)}]</span>
                <span class="log-badge ${escapeHtml(l.type)}">${escapeHtml(l.type)}</span>
                <span class="log-text">${escapeHtml(l.message)}</span>
            </div>
        `;
    }).join('');
}

// -------------------------------------------------------------
// Helpers & Toasts
// -------------------------------------------------------------
function getInitials(name) {
    if (!name) return 'WA';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

let toastTimer = null;
function showToast(message, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.style.borderColor = isError ? 'var(--status-danger)' : 'var(--primary)';
    el.toast.classList.remove('hidden');

    toastTimer = setTimeout(() => {
        el.toast.classList.add('hidden');
    }, 3200);
}

// Expose globals for inline event handlers
window.toggleContact = toggleContact;
window.editContact = editContact;
window.deleteContact = deleteContact;
