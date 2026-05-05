import { createClient } from '@supabase/supabase-js';

// Storage shim — bridges the app's window.storage API to either Supabase (shared
// data, e.g. roster, weeks, audit log) or localStorage (per-device data, e.g.
// which user is signed in on this device). The app code itself doesn't change.
if (typeof window !== 'undefined' && !window.storage) {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

  let supabase = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      });
    } catch (e) {
      console.error('Failed to initialise Supabase client:', e);
    }
  } else {
    console.warn(
      'Supabase env vars missing (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). ' +
      'Shared data will not persist. Check Vercel environment variables.'
    );
  }

  const LOCAL_PREFIX = '__fitztues_local__:';

  // Per-device fallback (only used for shared:false keys like current_user)
  const local = {
    async get(key) {
      try {
        const v = localStorage.getItem(LOCAL_PREFIX + key);
        return v === null ? null : { value: v };
      } catch (e) { return null; }
    },
    async set(key, value) {
      try { localStorage.setItem(LOCAL_PREFIX + key, value); return { value }; }
      catch (e) { return null; }
    },
    async delete(key) {
      try { localStorage.removeItem(LOCAL_PREFIX + key); return { deleted: true }; }
      catch (e) { return null; }
    },
    async list() {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(LOCAL_PREFIX)) keys.push(k.slice(LOCAL_PREFIX.length));
        }
        return { keys };
      } catch (e) { return { keys: [] }; }
    },
  };

  // Shared store: Supabase
  const remote = {
    async get(key) {
      if (!supabase) return null;
      try {
        const { data, error } = await supabase
          .from('app_storage')
          .select('value')
          .eq('key', key)
          .maybeSingle();
        if (error) { console.error('storage.get error:', error); return null; }
        if (!data) return null;
        return { value: data.value };
      } catch (e) {
        console.error('storage.get exception:', e);
        return null;
      }
    },
    async set(key, value) {
      if (!supabase) return null;
      try {
        const { error } = await supabase
          .from('app_storage')
          .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) { console.error('storage.set error:', error); return null; }
        return { value };
      } catch (e) {
        console.error('storage.set exception:', e);
        return null;
      }
    },
    async delete(key) {
      if (!supabase) return null;
      try {
        const { error } = await supabase
          .from('app_storage')
          .delete()
          .eq('key', key);
        if (error) { console.error('storage.delete error:', error); return null; }
        return { deleted: true };
      } catch (e) {
        console.error('storage.delete exception:', e);
        return null;
      }
    },
    async list() {
      if (!supabase) return { keys: [] };
      try {
        const { data, error } = await supabase
          .from('app_storage')
          .select('key');
        if (error || !data) return { keys: [] };
        return { keys: data.map(r => r.key) };
      } catch (e) {
        return { keys: [] };
      }
    },
  };

  window.storage = {
    async get(key, shared = true) {
      return shared ? remote.get(key) : local.get(key);
    },
    async set(key, value, shared = true) {
      return shared ? remote.set(key, value) : local.set(key, value);
    },
    async delete(key, shared = true) {
      return shared ? remote.delete(key) : local.delete(key);
    },
    async list(prefix, shared = true) {
      return shared ? remote.list() : local.list();
    },
  };
}

import { useState, useEffect, useMemo } from 'react';

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(pin + ':' + salt);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const styles = {
  bg: '#ffffff',
  surface: '#fafafa',
  surfaceStrong: '#f4f4f5',
  ink: '#0a0a0a',
  inkStrong: '#000000',
  inkMuted: '#71717a',
  inkSubtle: '#a1a1aa',
  line: '#e4e4e7',
  lineStrong: '#d4d4d8',
  primary: '#0a0a0a',
  accent: '#dc2626',
  warn: '#dc2626',
  whatsapp: '#25D366',
};

const FONT_SANS = "'Aptos', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, monospace";

const DEFAULT_SETTINGS = { courtSize: 12, cancelHours: 48, shareUrl: '', groupName: 'Fitz Tuesday Crew', farmBuffer: 4 };

// Audit log helpers ─────────────────────────────────────────────────────────
// appendAudit is pure — it returns a new state object with the entry added.
// Callers compose it into their save() call so the audit write is part of
// the same atomic state transition (no race conditions, no double-writes).
let __auditCounter = 0;
function nextAuditId() {
  __auditCounter += 1;
  return `${Date.now().toString(36)}-${__auditCounter.toString(36)}`;
}

function appendAudit(state, entry) {
  const log = Array.isArray(state.audit) ? state.audit : [];
  const fullEntry = {
    id: nextAuditId(),
    ts: Date.now(),
    week: entry.week ?? state.currentWeek?.number ?? null,
    type: entry.type,
    actor: entry.actor ?? null,
    subject: entry.subject ?? null,
    meta: entry.meta || {},
  };
  return { ...state, audit: [...log, fullEntry] };
}

function nameOf(players, id) {
  if (!id) return null;
  if (id === 'system') return 'System';
  const p = players.find(pp => pp.id === id);
  return p ? p.name : 'Unknown';
}

function formatAuditEntry(e, players) {
  const actor = nameOf(players, e.actor);
  const subject = nameOf(players, e.subject);
  switch (e.type) {
    case 'week_opened': {
      const bookerNames = (e.meta.bookers || []).map(id => nameOf(players, id)).filter(Boolean);
      const parts = [];
      if (e.meta.gameAt) parts.push(`game ${fmtDateTime(e.meta.gameAt)}`);
      if (e.meta.deadline) parts.push(`deadline ${fmtDateTime(e.meta.deadline)}`);
      if (bookerNames.length > 0) parts.push(`bookers: ${bookerNames.join(', ')}`);
      return `Week opened by ${actor || 'organiser'}${parts.length ? ' — ' + parts.join(' · ') : ''}`;
    }
    case 'signed_up':
      return `${actor} signed up${e.meta.byOrganiser ? ' (added by organiser)' : ''}`;
    case 'signup_removed':
      return `${actor} removed their signup${e.meta.byOrganiser ? ' (by organiser)' : ''}`;
    case 'late_signup':
      return `${actor} signed up after the deadline${e.meta.byOrganiser ? ' (added by organiser)' : ''} — added to reserves, no +1 eligibility`;
    case 'allocation_ran': {
      const auto = e.meta.auto;
      const mode = auto ? (e.meta.mode === 'on_load' ? 'auto (on app load, deadline had passed)' : 'auto (deadline reached)') : `manual by ${actor || 'organiser'}`;
      return `Allocation ran — ${mode} — ${e.meta.starters || 0} starters, ${e.meta.reserves || 0} reserves`;
    }
    case 'dropped_out': {
      const win = e.meta.window;
      const tag = win === 'late' ? 'late cancel — −2 points' : win === 'early' ? `${e.meta.cancelHours || 48}h+ in advance — no penalty` : 'before allocation — no penalty';
      const fromSlot = e.meta.fromSlot === 'starter' ? 'starter' : e.meta.fromSlot === 'reserve' ? 'reserve' : 'signup';
      const shortFlag = e.meta.leftCourtShort ? ' — no reserve available, court left short' : '';
      return `${actor} dropped out from ${fromSlot} (${tag})${shortFlag}`;
    }
    case 'reserve_promoted':
      return `${subject} auto-promoted from reserves${actor && actor !== subject ? ` (replacing ${actor})` : ''}`;
    case 'removed_by_organiser': {
      const where = e.meta.weekStatus === 'open' ? 'signups' : 'lineup';
      const slot = e.meta.fromSlot;
      const slotText = slot === 'starter' ? ' (was a starter)' : slot === 'reserve' ? ' (was a reserve)' : '';
      const shortFlag = e.meta.leftCourtShort ? ' — court left short, no reserve to promote' : '';
      return `${actor || 'Organiser'} removed ${subject} from ${where}${slotText} — no penalty (organiser correction)${shortFlag}`;
    }
    case 'week_edited': {
      const changes = [];
      if ('oldGameAt' in e.meta || 'newGameAt' in e.meta) {
        changes.push(`game time ${e.meta.oldGameAt ? fmtDateTime(e.meta.oldGameAt) : '—'} → ${e.meta.newGameAt ? fmtDateTime(e.meta.newGameAt) : '—'}`);
      }
      if ('oldDeadline' in e.meta || 'newDeadline' in e.meta) {
        changes.push(`deadline ${e.meta.oldDeadline ? fmtDateTime(e.meta.oldDeadline) : '—'} → ${e.meta.newDeadline ? fmtDateTime(e.meta.newDeadline) : '—'}`);
      }
      return `${actor || 'Organiser'} edited week details${changes.length ? ' — ' + changes.join('; ') : ''}`;
    }
    case 'lineup_shared':
      return `${actor || 'Organiser'} shared lineup to WhatsApp`;
    case 'signups_reopened':
      return `${actor || 'Organiser'} reopened signups (allocation cleared)`;
    case 'week_wrapped': {
      const m = e.meta;
      return `Week wrapped up by ${actor || 'organiser'} — ${m.played || 0} played, ${m.lateCancels || 0} late cancels, ${m.reservesBumped || 0} reserves bumped`;
    }
    case 'name_changed': {
      const oldN = e.meta.oldName || '?';
      const newN = e.meta.newName || '?';
      const self = e.actor && e.subject && e.actor === e.subject;
      return self
        ? `${newN} changed their display name (was "${oldN}")`
        : `${actor || 'Organiser'} changed ${oldN}'s display name to "${newN}"`;
    }
    case 'bulk_add': {
      const m = e.meta;
      const parts = [`${m.added || 0} player${m.added === 1 ? '' : 's'} added`];
      if (m.skippedExisting) parts.push(`${m.skippedExisting} skipped (already in roster)`);
      if (m.dupesInInput) parts.push(`${m.dupesInInput} duplicate line${m.dupesInInput === 1 ? '' : 's'} ignored`);
      if (m.withTempPin) parts.push('shared temporary PIN set');
      return `${actor || 'Organiser'} bulk added players — ${parts.join(', ')}`;
    }
    default:
      return `${e.type}${actor ? ' · ' + actor : ''}`;
  }
}

function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function deadlineRel(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms < 0) return 'closed';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function whatsappUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function buildSignupMessage({ week, players, settings }) {
  const groupName = settings.groupName || 'Padel';
  const lines = [`${groupName} — signups are open.`, ''];
  lines.push(`Week ${week.number}`);
  if (week.gameAt) lines.push(`Game: ${fmtDateTime(week.gameAt)}`);
  if (week.deadline) lines.push(`Signups close: ${fmtDateTime(week.deadline)}`);

  const bookerCount = (week.bookers || []).filter(id => players?.find(p => p.id === id)).length;
  if (bookerCount > 0 && players) {
    const names = week.bookers.map(id => players.find(p => p.id === id)?.name).filter(Boolean);
    if (names.length > 0) {
      lines.push('');
      lines.push(`Booked by ${names.join(', ')} — auto-entered. Thanks!`);
    }
  }

  lines.push('');
  const remaining = Math.max(0, settings.courtSize - bookerCount);
  if (bookerCount > 0) {
    lines.push(`${remaining} starter spot${remaining === 1 ? '' : 's'} left, reserves welcome.`);
  } else {
    lines.push(`${settings.courtSize} spots, reserves welcome.`);
  }
  lines.push('');
  lines.push(settings.shareUrl ? `Sign up: ${settings.shareUrl}` : 'Sign up: [paste app link]');
  return lines.join('\n');
}

function buildLineupMessage({ week, players, settings }) {
  const sorted = (slot) => Object.entries(week.signups)
    .filter(([, info]) => info.slot === slot)
    .map(([id]) => players.find(p => p.id === id))
    .filter(Boolean);
  const starters = sorted('starter');
  const reserves = sorted('reserve');
  const groupName = settings.groupName || 'Padel';
  const lines = [`${groupName} — Week ${week.number} lineup`];
  if (week.gameAt) lines.push(fmtDateTime(week.gameAt));
  lines.push('');
  lines.push('Starters:');
  starters.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  if (reserves.length > 0) {
    lines.push('');
    lines.push('Reserves:');
    reserves.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  }
  lines.push('');
  lines.push("Can't make it? Drop out in the app — first reserve auto-promotes.");
  if (settings.shareUrl) lines.push(settings.shareUrl);
  return lines.join('\n');
}

export default function PadelApp() {
  const [appData, setAppData] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [view, setView] = useState('week');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [dialog, setDialog] = useState(null);

  // In-app replacements for window.confirm / window.alert (some mobile webviews block those)
  function showConfirm(opts) {
    return new Promise(resolve => {
      setDialog({
        type: 'confirm',
        title: opts.title,
        body: opts.body,
        confirmLabel: opts.confirmLabel || 'Confirm',
        danger: !!opts.danger,
        onResolve: (ok) => { setDialog(null); resolve(ok); },
      });
    });
  }
  function showAlert(opts) {
    return new Promise(resolve => {
      setDialog({
        type: 'alert',
        title: opts.title,
        body: opts.body,
        onResolve: () => { setDialog(null); resolve(); },
      });
    });
  }

  useEffect(() => {
    // Aptos via CDN, Inter as reliable fallback
    const aptos = document.createElement('link');
    aptos.href = 'https://fonts.cdnfonts.com/css/aptos';
    aptos.rel = 'stylesheet';
    document.head.appendChild(aptos);

    const google = document.createElement('link');
    google.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap';
    google.rel = 'stylesheet';
    document.head.appendChild(google);

    return () => {
      try { document.head.removeChild(aptos); } catch (e) {}
      try { document.head.removeChild(google); } catch (e) {}
    };
  }, []);

  useEffect(() => { loadData(); }, []);

  // Schedule auto-allocation at the deadline. Re-runs when the week or deadline changes;
  // cleanup cancels any pending timer if the user signs up/out etc. before the deadline.
  useEffect(() => {
    if (!appData?.currentWeek) return;
    const w = appData.currentWeek;
    if (w.status !== 'open' || !w.deadline) return;
    const ms = w.deadline - Date.now();
    if (ms <= 0) return; // already past — handled in loadData
    const t = setTimeout(() => {
      if (!appData.currentWeek || appData.currentWeek.status !== 'open') return;
      if (Object.keys(appData.currentWeek.signups).length === 0) return;
      const allocated = performAllocation(appData.currentWeek, appData.players, appData.settings);
      if (allocated) {
        const starters = Object.values(allocated.signups).filter(s => s.slot === 'starter').length;
        const reserves = Object.values(allocated.signups).filter(s => s.slot === 'reserve').length;
        let next = { ...appData, currentWeek: allocated };
        next = appendAudit(next, {
          type: 'allocation_ran',
          actor: 'system',
          week: allocated.number,
          meta: { auto: true, mode: 'on_deadline', starters, reserves },
        });
        save(next);
      }
    }, ms);
    return () => clearTimeout(t);
  }, [appData]);

  async function loadData() {
    try {
      let app = null, user = null;
      try { const r = await window.storage.get('app_data', true); if (r) app = JSON.parse(r.value); } catch (e) {}
      try { const r = await window.storage.get('current_user', false); if (r) user = r.value; } catch (e) {}

      if (!app) {
        app = { players: [], currentWeek: null, history: [], settings: { ...DEFAULT_SETTINGS }, weekCounter: 0, setupComplete: false, audit: [] };
      } else {
        app.settings = { ...DEFAULT_SETTINGS, ...(app.settings || {}) };
        if (!Array.isArray(app.audit)) app.audit = [];
        if (app.currentWeek?.signups) {
          Object.entries(app.currentWeek.signups).forEach(([, info]) => {
            if (!('originalSlot' in info)) info.originalSlot = info.slot;
          });
        }
      }

      // Auto-allocate if a deadline has passed and the week is still open
      const w = app.currentWeek;
      if (w && w.status === 'open' && w.deadline && Date.now() >= w.deadline && Object.keys(w.signups).length > 0) {
        const allocated = performAllocation(w, app.players, app.settings);
        if (allocated) {
          const starters = Object.values(allocated.signups).filter(s => s.slot === 'starter').length;
          const reserves = Object.values(allocated.signups).filter(s => s.slot === 'reserve').length;
          app = { ...app, currentWeek: allocated };
          app = appendAudit(app, {
            type: 'allocation_ran',
            actor: 'system',
            week: allocated.number,
            meta: { auto: true, mode: 'on_load', starters, reserves },
          });
          try { await window.storage.set('app_data', JSON.stringify(app), true); } catch (e) {}
        }
      }

      setAppData(app);
      if (user && app.players.find(p => p.id === user)) setCurrentUserId(user);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }

  async function save(newData) {
    setAppData(newData);
    try { await window.storage.set('app_data', JSON.stringify(newData), true); }
    catch (e) { console.error('save', e); }
  }

  async function setUser(id) {
    setCurrentUserId(id);
    try { await window.storage.set('current_user', id, false); } catch (e) {}
  }

  async function clearUser() {
    setCurrentUserId(null);
    try { await window.storage.delete('current_user', false); } catch (e) {}
  }

  async function createFirstOrganiser({ name, pin }) {
    const id = newId();
    const pinHash = await hashPin(pin, id);
    const player = { id, name, points: 0, createdAt: Date.now(), pinHash, isOrganiser: true, claimed: true };
    const settings = { ...DEFAULT_SETTINGS, shareUrl: typeof window !== 'undefined' ? window.location.href : '' };
    await save({ ...appData, players: [player], setupComplete: true, settings });
    setUser(id);
    setModal(null);
  }

  async function addPlayer({ name, pin, asOrganiser }) {
    const id = newId();
    const pinHash = pin ? await hashPin(pin, id) : null;
    const player = { id, name, points: 0, createdAt: Date.now(), pinHash, isOrganiser: !!asOrganiser, claimed: !!pin };
    await save({ ...appData, players: [...appData.players, player] });
    setModal(null);
  }

  async function bulkAddPlayers({ rawText, sharedPin }) {
    // Parse names: one per line, trim, dedupe within input, drop blanks
    const lines = (rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const seen = new Set();
    const newNames = [];
    const dupesInInput = [];
    lines.forEach(n => {
      const key = n.toLowerCase();
      if (seen.has(key)) { dupesInInput.push(n); return; }
      seen.add(key);
      newNames.push(n);
    });

    // Drop names that already exist in the roster (case-insensitive)
    const existing = new Set(appData.players.map(p => p.name.toLowerCase()));
    const skippedExisting = [];
    const toAdd = [];
    newNames.forEach(n => {
      if (existing.has(n.toLowerCase())) skippedExisting.push(n);
      else toAdd.push(n);
    });

    if (toAdd.length === 0) {
      await showAlert({
        title: 'Nothing to add',
        body: skippedExisting.length > 0
          ? `All ${skippedExisting.length} names are already in the roster.`
          : 'No valid names found. Paste one name per line.',
      });
      return;
    }

    // Hash the shared PIN once if provided
    const usePin = sharedPin && /^\d{4}$/.test(sharedPin) ? sharedPin : null;

    // Build the new player objects
    const newPlayers = [];
    for (const name of toAdd) {
      const id = newId();
      const pinHash = usePin ? await hashPin(usePin, id) : null;
      newPlayers.push({
        id,
        name,
        points: 0,
        createdAt: Date.now(),
        pinHash,
        isOrganiser: false,
        claimed: false, // they still need to claim with the temp PIN and set their own
      });
    }

    let next = { ...appData, players: [...appData.players, ...newPlayers] };
    next = appendAudit(next, {
      type: 'bulk_add',
      actor: currentUserId,
      meta: {
        added: toAdd.length,
        skippedExisting: skippedExisting.length,
        dupesInInput: dupesInInput.length,
        withTempPin: !!usePin,
      },
    });
    await save(next);

    // Confirm to the user
    const summary = [`${toAdd.length} player${toAdd.length === 1 ? '' : 's'} added.`];
    if (skippedExisting.length) summary.push(`${skippedExisting.length} skipped (already in roster).`);
    if (dupesInInput.length) summary.push(`${dupesInInput.length} duplicate line${dupesInInput.length === 1 ? '' : 's'} ignored.`);
    if (usePin) summary.push(`Temporary PIN: ${usePin} — share privately with the group. Each player should change it on first sign-in.`);
    else summary.push('No temporary PIN set — each player will set their own when they first claim their name.');

    await showAlert({ title: 'Bulk add complete', body: summary.join(' ') });
    setModal(null);
  }

  async function claimPlayer({ id, pin }) {
    const pinHash = await hashPin(pin, id);
    const players = appData.players.map(p => p.id === id ? { ...p, pinHash, claimed: true } : p);
    await save({ ...appData, players });
    setUser(id);
    setModal(null);
  }

  async function authenticateUser({ id, pin }) {
    const player = appData.players.find(p => p.id === id);
    if (!player) return { ok: false, error: 'Player not found' };
    if (!player.claimed) return { ok: false, error: 'Not claimed yet' };
    const hash = await hashPin(pin, id);
    if (hash !== player.pinHash) return { ok: false, error: 'Wrong PIN' };
    setUser(id);
    return { ok: true };
  }

  async function removePlayer(id) {
    const player = appData.players.find(p => p.id === id);
    const ok = await showConfirm({
      title: `Remove ${player?.name || 'this player'}?`,
      body: 'They will be deleted from the roster and any active week.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const players = appData.players.filter(p => p.id !== id);
    let currentWeek = appData.currentWeek;
    if (currentWeek) {
      const newSignups = { ...currentWeek.signups };
      delete newSignups[id];
      currentWeek = { ...currentWeek, signups: newSignups };
    }
    save({ ...appData, players, currentWeek });
    if (currentUserId === id) clearUser();
  }

  async function resetPlayerPin(id) {
    const player = appData.players.find(p => p.id === id);
    const ok = await showConfirm({
      title: `Reset ${player?.name || 'this player'}'s PIN?`,
      body: "They'll set a new PIN on next sign-in.",
      confirmLabel: 'Reset PIN',
    });
    if (!ok) return;
    const players = appData.players.map(p => p.id === id ? { ...p, pinHash: null, claimed: false } : p);
    await save({ ...appData, players });
  }

  async function toggleOrganiser(id) {
    const target = appData.players.find(p => p.id === id);
    if (!target) return;
    const organiserCount = appData.players.filter(p => p.isOrganiser).length;
    if (target.isOrganiser && organiserCount <= 1) {
      await showAlert({ title: "Can't remove organiser", body: 'You need at least one organiser. Promote someone else first.' });
      return;
    }
    const players = appData.players.map(p => p.id === id ? { ...p, isOrganiser: !p.isOrganiser } : p);
    save({ ...appData, players });
  }

  async function renamePlayer(id, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) {
      await showAlert({ title: 'Name required', body: 'Display name cannot be empty.' });
      return false;
    }
    if (trimmed.length > 30) {
      await showAlert({ title: 'Too long', body: 'Display name should be 30 characters or fewer.' });
      return false;
    }
    const target = appData.players.find(p => p.id === id);
    if (!target) return false;
    if (target.name === trimmed) return true; // no change, succeed silently
    // Optional duplicate check — friendly warning, not a block
    const dup = appData.players.find(p => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) {
      const ok = await showConfirm({
        title: 'Same name as someone else',
        body: `${dup.name} already uses that name in the roster. Continue anyway?`,
        confirmLabel: 'Use it anyway',
      });
      if (!ok) return false;
    }
    const oldName = target.name;
    const players = appData.players.map(p => p.id === id ? { ...p, name: trimmed } : p);
    let next = { ...appData, players };
    next = appendAudit(next, {
      type: 'name_changed',
      actor: currentUserId,
      subject: id,
      meta: { oldName, newName: trimmed },
    });
    save(next);
    return true;
  }

  async function startNewWeek({ deadline, gameAt, bookers = [] }) {
    if (appData.players.length < 4) {
      await showAlert({ title: 'Not enough players', body: 'Add at least 4 players first (Roster tab → + Add).' });
      return;
    }
    // Auto-sign-up the bookers (signupTime=0 means always pre-deadline, eligible)
    const signups = {};
    let order = 0;
    bookers.forEach(id => {
      if (appData.players.find(p => p.id === id)) {
        order += 1;
        signups[id] = { slot: null, originalSlot: null, outcome: null, isBooker: true, signupCount: order, signupTime: 0 };
      }
    });
    const week = {
      number: (appData.weekCounter || 0) + 1,
      status: 'open',
      startedAt: Date.now(),
      deadline: deadline || null,
      gameAt: gameAt || null,
      bookers: bookers.filter(id => appData.players.find(p => p.id === id)),
      signups,
    };
    let next = { ...appData, currentWeek: week, weekCounter: week.number };
    next = appendAudit(next, {
      type: 'week_opened',
      actor: currentUserId,
      week: week.number,
      meta: { gameAt: week.gameAt, deadline: week.deadline, bookers: week.bookers },
    });
    save(next);
    setModal(null);
  }

  function toggleSignup(playerId) {
    if (!appData.currentWeek) return;
    if (appData.currentWeek.status !== 'open') return;
    const signups = { ...appData.currentWeek.signups };
    const wasSignedUp = !!signups[playerId];
    if (wasSignedUp) {
      delete signups[playerId];
    } else {
      const isBooker = (appData.currentWeek.bookers || []).includes(playerId);
      const signupCount = Object.keys(signups).length + 1;
      signups[playerId] = {
        slot: null,
        originalSlot: null,
        outcome: null,
        signupCount,
        signupTime: Date.now(),
        ...(isBooker && { isBooker: true }),
      };
    }
    let next = { ...appData, currentWeek: { ...appData.currentWeek, signups } };
    next = appendAudit(next, {
      type: wasSignedUp ? 'signup_removed' : 'signed_up',
      actor: playerId,
      meta: { byOrganiser: currentUserId !== playerId },
    });
    save(next);
  }

  // Pure allocation — used by manual run and by auto-allocation at deadline
  function performAllocation(week, players, settings) {
    const ids = Object.keys(week.signups);
    if (ids.length === 0) return null;
    const courtSize = settings.courtSize;
    const bookerIds = (week.bookers || []).filter(id => week.signups[id]);

    const nonBookerOrdered = ids
      .filter(id => !bookerIds.includes(id))
      .map(id => {
        const p = players.find(pp => pp.id === id);
        return { id, points: p ? p.points : 0, r: Math.random() };
      })
      .sort((a, b) => b.points - a.points || a.r - b.r)
      .map(x => x.id);

    const ordered = [...bookerIds, ...nonBookerOrdered];
    const newSignups = {};
    ordered.forEach((id, i) => {
      const slot = i < courtSize ? 'starter' : 'reserve';
      newSignups[id] = {
        ...week.signups[id],
        slot,
        originalSlot: slot,
        outcome: null,
      };
    });
    return { ...week, status: 'allocated', signups: newSignups, allocatedAt: Date.now(), lineupShared: false };
  }

  async function runAllocation() {
    const week = appData.currentWeek;
    if (!week) return;
    if (Object.keys(week.signups).length === 0) {
      await showAlert({ title: 'No signups yet', body: 'Wait for at least one person to sign up before running allocation.' });
      return;
    }
    const allocated = performAllocation(week, appData.players, appData.settings);
    if (allocated) {
      const starters = Object.values(allocated.signups).filter(s => s.slot === 'starter').length;
      const reserves = Object.values(allocated.signups).filter(s => s.slot === 'reserve').length;
      let next = { ...appData, currentWeek: allocated };
      next = appendAudit(next, {
        type: 'allocation_ran',
        actor: currentUserId,
        week: allocated.number,
        meta: { auto: false, starters, reserves },
      });
      save(next);
    }
  }

  // Late signup after auto-allocation: joins as a reserve at the bottom, no +1 eligibility
  function joinLateAsReserve(playerId) {
    const week = appData.currentWeek;
    if (!week || week.status !== 'allocated') return;
    if (week.signups[playerId]) return;
    const newSignup = {
      slot: 'reserve',
      originalSlot: 'reserve',
      outcome: null,
      signupCount: Object.keys(week.signups).length + 1,
      signupTime: Date.now(),
    };
    const signups = { ...week.signups, [playerId]: newSignup };
    let next = { ...appData, currentWeek: { ...week, signups } };
    next = appendAudit(next, {
      type: 'late_signup',
      actor: playerId,
      meta: { byOrganiser: currentUserId !== playerId },
    });
    save(next);
  }

  // Edit the current week's metadata (game time, deadline). Doesn't touch signups or status.
  function editCurrentWeek({ deadline, gameAt }) {
    if (!appData.currentWeek) return;
    const oldGameAt = appData.currentWeek.gameAt || null;
    const oldDeadline = appData.currentWeek.deadline || null;
    const newGameAt = gameAt || null;
    const newDeadline = deadline || null;
    const week = { ...appData.currentWeek, deadline: newDeadline, gameAt: newGameAt };
    let next = { ...appData, currentWeek: week };
    if (oldGameAt !== newGameAt || oldDeadline !== newDeadline) {
      const meta = {};
      if (oldGameAt !== newGameAt) { meta.oldGameAt = oldGameAt; meta.newGameAt = newGameAt; }
      if (oldDeadline !== newDeadline) { meta.oldDeadline = oldDeadline; meta.newDeadline = newDeadline; }
      next = appendAudit(next, { type: 'week_edited', actor: currentUserId, meta });
    }
    save(next);
    setModal(null);
  }

  function markLineupShared() {
    if (!appData.currentWeek) return;
    const wasShared = !!appData.currentWeek.lineupShared;
    let next = { ...appData, currentWeek: { ...appData.currentWeek, lineupShared: true } };
    if (!wasShared) {
      next = appendAudit(next, { type: 'lineup_shared', actor: currentUserId });
    }
    save(next);
  }

  async function reopenSignups() {
    const ok = await showConfirm({
      title: 'Reopen signups?',
      body: 'This clears the current allocation. Everyone goes back to the unallocated signup pool.',
      confirmLabel: 'Reopen',
    });
    if (!ok) return;
    const week = appData.currentWeek;
    const newSignups = {};
    Object.keys(week.signups).forEach(id => { newSignups[id] = { slot: null, originalSlot: null, outcome: null }; });
    let next = { ...appData, currentWeek: { ...week, status: 'open', signups: newSignups, allocatedAt: null } };
    next = appendAudit(next, { type: 'signups_reopened', actor: currentUserId });
    save(next);
  }

  // Organiser-only correction: removes a player from the current week with NO penalty,
  // distinct from the player's own drop-out flow (which DOES apply cancel-window penalties).
  // Use case: organiser added wrong person via the manual signup pill list, wants to undo.
  // Auto-promotes a reserve if removing a starter from an allocated lineup.
  async function removePlayerByOrganiser(playerId) {
    const week = appData.currentWeek;
    if (!week) return;
    const signup = week.signups[playerId];
    if (!signup) return;
    const player = appData.players.find(p => p.id === playerId);
    if (!player) return;

    const wasStarter = signup.slot === 'starter';
    const isOpen = week.status === 'open';
    const isAllocated = week.status === 'allocated';

    let bodyText;
    if (isOpen) {
      bodyText = `${player.name} will be removed from this week's signups. No penalty applied — use this if you added them by mistake.`;
    } else if (isAllocated) {
      bodyText = `${player.name} will be removed from the lineup. No penalty applied (this is an organiser correction, not a regular drop-out).${wasStarter ? ' The top-priority reserve will be auto-promoted if one is available.' : ''}\n\nFor a normal drop-out by the player themselves, ask them to use the "I can't make it" button in their own signed-in view.`;
    } else {
      return;
    }

    const ok = await showConfirm({
      title: `Remove ${player.name} (organiser correction)?`,
      body: bodyText,
      confirmLabel: 'Remove',
    });
    if (!ok) return;

    const newSignups = { ...week.signups };
    delete newSignups[playerId]; // clean removal — no 'cancelled' status, no outcome

    let promotedId = null;
    if (isAllocated && wasStarter) {
      const candidates = Object.entries(newSignups)
        .filter(([id, info]) => info.slot === 'reserve')
        .map(([id, info]) => ({ id, info, points: appData.players.find(p => p.id === id)?.points || 0 }))
        .sort((a, b) => b.points - a.points);
      if (candidates.length > 0) {
        const promoted = candidates[0];
        newSignups[promoted.id] = { ...promoted.info, slot: 'starter', promoted: true };
        promotedId = promoted.id;
      }
    }

    let next = { ...appData, currentWeek: { ...week, signups: newSignups } };
    next = appendAudit(next, {
      type: 'removed_by_organiser',
      actor: currentUserId,
      subject: playerId,
      meta: { fromSlot: signup.slot, weekStatus: week.status, leftCourtShort: isAllocated && wasStarter && !promotedId },
    });
    if (promotedId) {
      next = appendAudit(next, {
        type: 'reserve_promoted',
        actor: playerId, // who they replaced
        subject: promotedId,
      });
    }
    save(next);
  }

  async function dropOutSelf(playerId) {
    const week = appData.currentWeek;
    if (!week || week.status !== 'allocated') return;
    const myInfo = week.signups[playerId];
    if (!myInfo) return;
    if (myInfo.slot !== 'starter' && myInfo.slot !== 'reserve') return;

    const isStarter = myInfo.slot === 'starter';
    const cancelMs = (appData.settings.cancelHours || 48) * 3600 * 1000;
    const isLate = week.gameAt ? (Date.now() > week.gameAt - cancelMs) : false;
    const dropper = appData.players.find(p => p.id === playerId);
    const droppedName = dropper?.name;

    // Check whether a reserve is available to take over (only relevant for starters)
    const reserveCandidates = Object.entries(week.signups)
      .filter(([id, info]) => info.slot === 'reserve' && id !== playerId)
      .map(([id, info]) => ({ id, info, points: appData.players.find(p => p.id === id)?.points || 0 }))
      .sort((a, b) => b.points - a.points);
    const hasReserve = reserveCandidates.length > 0;

    // Build the confirmation body — different depending on slot, lateness,
    // reserve availability, and whether the dropper is an organiser
    let body;
    let confirmLabel = 'Drop out';
    if (myInfo.slot === 'reserve') {
      body = "You're on the reserve list. Dropping out just removes you — no penalty.";
    } else if (hasReserve) {
      body = isLate
        ? `You're a starter and the game is within ${appData.settings.cancelHours || 48} hours — this counts as a late cancel (−2 points). The first reserve will be promoted.`
        : "You're a starter. The first reserve will be auto-promoted to take your place.";
    } else {
      // No reserves available — escalate the language but keep the tone neutral
      const lateBit = isLate
        ? `This counts as a late cancel (−2 points) since the game is within ${appData.settings.cancelHours || 48} hours.\n\n`
        : '';
      const action = dropper?.isOrganiser
        ? "After you drop out, you'll be prompted to share a sub-request to WhatsApp."
        : 'If you can, message the WhatsApp group to ask for a sub.';
      body = `There are no reserves to take your place, so the court will be one short.\n\n${lateBit}${action}`;
      confirmLabel = 'Drop out anyway';
    }

    const ok = await showConfirm({
      title: `Drop out of week ${week.number}?`,
      body,
      confirmLabel,
      danger: isStarter && (isLate || !hasReserve),
    });
    if (!ok) return;

    const newSignups = { ...week.signups };

    if (myInfo.slot === 'reserve') {
      newSignups[playerId] = { ...myInfo, slot: 'cancelled', outcome: 'no_play' };
      let next = { ...appData, currentWeek: { ...week, signups: newSignups } };
      next = appendAudit(next, {
        type: 'dropped_out',
        actor: playerId,
        meta: { fromSlot: 'reserve', window: 'reserve' },
      });
      save(next);
      return;
    }

    // Starter dropping out
    newSignups[playerId] = {
      ...myInfo,
      slot: 'cancelled',
      outcome: isLate ? 'cancelled_late' : 'cancelled_early',
    };

    let promotedName = null;
    let promotedId = null;
    if (hasReserve) {
      const promoted = reserveCandidates[0];
      newSignups[promoted.id] = { ...promoted.info, slot: 'starter', promoted: true };
      promotedName = appData.players.find(p => p.id === promoted.id)?.name;
      promotedId = promoted.id;
    }

    let next = { ...appData, currentWeek: { ...week, signups: newSignups } };
    next = appendAudit(next, {
      type: 'dropped_out',
      actor: playerId,
      meta: {
        fromSlot: 'starter',
        window: isLate ? 'late' : 'early',
        cancelHours: appData.settings.cancelHours || 48,
        leftCourtShort: !hasReserve,
      },
    });
    if (promotedId) {
      next = appendAudit(next, {
        type: 'reserve_promoted',
        actor: playerId, // who they replaced
        subject: promotedId,
      });
    }
    save(next);

    // Post-drop UX: different paths depending on whether the slot got filled
    if (promotedName) {
      // Standard auto-promotion path — only organisers get the WhatsApp share prompt
      if (dropper?.isOrganiser) {
        const share = await showConfirm({
          title: 'Lineup updated',
          body: `${droppedName} is out, ${promotedName} is in. Share update on WhatsApp?`,
          confirmLabel: 'Share to WhatsApp',
        });
        if (share) {
          const msg = `Lineup change for week ${week.number}:\n${droppedName} → out\n${promotedName} → in${appData.settings.shareUrl ? '\n\n' + appData.settings.shareUrl : ''}`;
          window.open(whatsappUrl(msg), '_blank');
        }
      }
    } else {
      // No reserve available — court is now short. Different action paths.
      if (dropper?.isOrganiser) {
        const share = await showConfirm({
          title: 'Send a sub-request?',
          body: `${droppedName} is out and there are no reserves. Send a sub-request to the WhatsApp group?`,
          confirmLabel: 'Send sub-request',
        });
        if (share) {
          const gameTime = week.gameAt ? ` at ${fmtDateTime(week.gameAt)}` : '';
          const msg = `${appData.settings.groupName || 'Padel'} — looking for a sub for week ${week.number}${gameTime}.\n\nWe're a player short. If you can make it, sign up via the app: ${appData.settings.shareUrl || '[paste app link]'}`;
          window.open(whatsappUrl(msg), '_blank');
        }
      } else {
        await showAlert({
          title: 'A sub is needed',
          body: 'There were no reserves to take your place. If you can, message the WhatsApp group to ask for someone to fill in.',
        });
      }
    }
  }

  function commitWrapUp(outcomes) {
    const week = appData.currentWeek;
    const newSignups = {};
    Object.entries(week.signups).forEach(([id, info]) => {
      newSignups[id] = { ...info, outcome: outcomes[id] || info.outcome };
    });
    const courtSize = appData.settings.courtSize || 12;
    const farmCutoff = courtSize + (appData.settings.farmBuffer ?? 4);
    const updatedPlayers = appData.players.map(p => {
      const info = newSignups[p.id];
      if (!info) return p;
      const o = info.outcome;
      let newPoints = p.points;
      if (o === 'played') newPoints = info.originalSlot === 'reserve' ? p.points + 1 : 0;
      else if (o === 'cancelled_late' || o === 'no_show') newPoints = p.points - 2;
      else if (o === 'no_play') {
        // Eligibility for the +1 bumped bonus:
        // - If the week had a deadline, signups in before the deadline are eligible.
        // - Otherwise fall back to the position-based farm-buffer rule.
        let eligible;
        if (week.deadline) {
          eligible = (info.signupTime ?? 0) <= week.deadline;
        } else {
          const sc = info.signupCount || 1;
          eligible = sc <= farmCutoff;
        }
        newPoints = eligible ? p.points + 1 : p.points;
      }
      return { ...p, points: newPoints };
    });
    const completedWeek = { ...week, status: 'completed', signups: newSignups, completedAt: Date.now() };

    // Summarise outcomes for the audit entry
    const outcomeCounts = { played: 0, lateCancels: 0, reservesBumped: 0 };
    Object.values(newSignups).forEach(info => {
      if (info.outcome === 'played') outcomeCounts.played += 1;
      if (info.outcome === 'cancelled_late' || info.outcome === 'no_show') outcomeCounts.lateCancels += 1;
      if (info.outcome === 'no_play') outcomeCounts.reservesBumped += 1;
    });

    let next = {
      ...appData,
      players: updatedPlayers,
      currentWeek: null,
      history: [completedWeek, ...appData.history],
    };
    next = appendAudit(next, {
      type: 'week_wrapped',
      actor: currentUserId,
      week: week.number,
      meta: outcomeCounts,
    });
    save(next);
    setModal(null);
  }

  async function resetPoints() {
    const ok = await showConfirm({
      title: 'Reset all points to 0?',
      body: 'Players, history and the active week stay. Only the priority points are cleared.',
      confirmLabel: 'Reset points',
    });
    if (!ok) return;
    const players = appData.players.map(p => ({ ...p, points: 0 }));
    save({ ...appData, players });
  }

  async function startFresh() {
    const ok = await showConfirm({
      title: 'Start fresh?',
      body: 'Clears history, resets all points to 0, and restarts week numbering at 1. Players, PINs and settings stay. Useful after testing or for a new season.',
      confirmLabel: 'Start fresh',
      danger: true,
    });
    if (!ok) return;
    const players = appData.players.map(p => ({ ...p, points: 0 }));
    save({
      ...appData,
      players,
      history: [],
      currentWeek: null,
      weekCounter: 0,
      audit: [],
    });
  }

  async function resetAll() {
    const ok = await showConfirm({
      title: 'Reset everything?',
      body: 'This erases ALL players, PINs, weeks, history, and settings. There is no undo.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!ok) return;
    const reallyOk = await showConfirm({
      title: 'Are you absolutely sure?',
      body: 'Last chance. Tapping below will permanently wipe the app for everyone in the group. Everyone will need to set their PIN again, all priority points will be lost, and history cannot be recovered.',
      confirmLabel: 'Yes, erase everything',
      danger: true,
    });
    if (!reallyOk) return;
    save({ players: [], currentWeek: null, history: [], settings: { ...DEFAULT_SETTINGS }, weekCounter: 0, setupComplete: false, audit: [] });
    clearUser();
  }

  function saveSettings(newSettings) {
    save({ ...appData, settings: { ...appData.settings, ...newSettings } });
    setModal(null);
  }


  const sortedRoster = useMemo(() => {
    if (!appData) return [];
    return [...appData.players].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }, [appData]);

  const currentUser = useMemo(() => {
    if (!appData || !currentUserId) return null;
    return appData.players.find(p => p.id === currentUserId);
  }, [appData, currentUserId]);

  const isOrganiser = !!currentUser?.isOrganiser;

  if (loading) {
    return <div style={{ background: styles.bg, fontFamily: FONT_SANS }} className="min-h-screen flex items-center justify-center">
      <div style={{ color: styles.inkMuted, fontSize: 13, letterSpacing: '0.05em' }}>Loading…</div>
    </div>;
  }

  return (
    <div style={{ background: styles.bg, color: styles.ink, fontFamily: FONT_SANS, minHeight: '100vh', WebkitFontSmoothing: 'antialiased' }}>
      <div className="max-w-2xl mx-auto px-5 pb-32">
        <header className="pt-10 pb-6 border-b" style={{ borderColor: styles.line }}>
          <div className="flex items-start justify-between">
            <div>
              <div style={{ fontFamily: FONT_MONO, color: styles.inkSubtle, fontSize: 10, letterSpacing: '0.2em' }} className="uppercase mb-2">
                Court Allocation
              </div>
              <h1 style={{ fontWeight: 800, fontSize: 32, lineHeight: 1, letterSpacing: '-0.03em', color: styles.inkStrong }}>
                {appData.settings.groupName || 'Court allocation'}
              </h1>
            </div>
            <div className="flex gap-1.5 mt-1">
              {isOrganiser && (
                <IconButton onClick={() => setModal({ type: 'settings' })} aria-label="Settings">⚙</IconButton>
              )}
              <IconButton onClick={() => setModal({ type: 'help' })} aria-label="Help">?</IconButton>
            </div>
          </div>

          {currentUser ? (
            <div className="mt-6 flex flex-wrap gap-2 items-center">
              <button
                onClick={() => setModal({ type: 'switchUser' })}
                style={{ borderColor: styles.line }}
                className="border rounded-md px-3 py-1.5 inline-flex items-center gap-2 text-sm hover:bg-zinc-50 transition-colors"
              >
                <span style={{ background: styles.ink }} className="w-1.5 h-1.5 rounded-full" />
                <span style={{ color: styles.inkMuted }}>Signed in as</span>
                <span style={{ fontWeight: 600 }}>{currentUser.name}</span>
                {isOrganiser && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: '0.15em', color: styles.inkSubtle }} className="uppercase pl-1 border-l ml-1" data-border>organiser</span>
                )}
              </button>
              <button
                onClick={clearUser}
                style={{ color: styles.inkMuted }}
                className="text-xs hover:underline"
              >
                Sign out
              </button>
            </div>
          ) : appData.setupComplete ? (
            <button
              onClick={() => setModal({ type: 'switchUser' })}
              style={{ background: styles.ink, color: styles.bg }}
              className="mt-6 px-5 py-2 rounded-md text-sm font-medium"
            >
              Sign in
            </button>
          ) : null}
        </header>

        {!appData.setupComplete && (
          <FirstTimeSetup onCreate={createFirstOrganiser} />
        )}

        {appData.setupComplete && (
          <>
            <nav className="flex gap-6 mt-8 mb-8 border-b" style={{ borderColor: styles.line }}>
              {[['week', 'This week'], ['roster', 'Roster'], ['history', 'History'], ['audit', 'Audit']].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setView(k)}
                  style={{
                    color: view === k ? styles.ink : styles.inkMuted,
                    borderColor: view === k ? styles.ink : 'transparent',
                    fontWeight: view === k ? 600 : 500,
                  }}
                  className="border-b-2 pb-3 text-sm transition-colors"
                >
                  {label}
                </button>
              ))}
            </nav>

            {view === 'week' && (
              <WeekView
                appData={appData}
                currentUser={currentUser}
                isOrganiser={isOrganiser}
                onStartWeek={() => setModal({ type: 'startWeek' })}
                onEditWeek={() => setModal({ type: 'editWeek' })}
                onToggleSignup={toggleSignup}
                onAllocate={runAllocation}
                onReopen={reopenSignups}
                onWrapUp={() => setModal({ type: 'wrapUp' })}
                onPromptLogin={() => setModal({ type: 'switchUser' })}
                onDropOut={dropOutSelf}
                onJoinLate={joinLateAsReserve}
                onMarkLineupShared={markLineupShared}
                onRemovePlayer={removePlayerByOrganiser}
              />
            )}

            {view === 'roster' && (
              <RosterView
                roster={sortedRoster}
                currentUserId={currentUserId}
                isOrganiser={isOrganiser}
                onAdd={() => setModal({ type: 'addPlayer' })}
                onBulkAdd={() => setModal({ type: 'bulkAdd' })}
                onRename={(playerId) => setModal({ type: 'renamePlayer', playerId })}
                onRemove={removePlayer}
                onResetPin={resetPlayerPin}
                onToggleOrganiser={toggleOrganiser}
                onResetPoints={resetPoints}
                onStartFresh={startFresh}
                onReset={resetAll}
              />
            )}

            {view === 'history' && (
              <HistoryView history={appData.history} players={appData.players} />
            )}

            {view === 'audit' && (
              <AuditView audit={appData.audit || []} players={appData.players} currentWeekNumber={appData.currentWeek?.number} />
            )}
          </>
        )}
      </div>

      {modal?.type === 'switchUser' && (
        <SwitchUserModal roster={sortedRoster} currentUserId={currentUserId} onClose={() => setModal(null)} onAuthenticate={authenticateUser} onClaim={claimPlayer} />
      )}
      {modal?.type === 'addPlayer' && (
        <AddPlayerModal onClose={() => setModal(null)} onAdd={addPlayer} />
      )}
      {modal?.type === 'bulkAdd' && (
        <BulkAddModal onClose={() => setModal(null)} onAdd={bulkAddPlayers} existingCount={appData.players.length} />
      )}
      {modal?.type === 'renamePlayer' && (
        <RenamePlayerModal
          player={appData.players.find(p => p.id === modal.playerId)}
          onClose={() => setModal(null)}
          onSave={async (name) => {
            const ok = await renamePlayer(modal.playerId, name);
            if (ok) setModal(null);
          }}
        />
      )}
      {modal?.type === 'startWeek' && (
        <StartWeekModal weekNumber={(appData.weekCounter || 0) + 1} players={sortedRoster} onClose={() => setModal(null)} onStart={startNewWeek} />
      )}
      {modal?.type === 'editWeek' && appData.currentWeek && (
        <EditWeekModal week={appData.currentWeek} onClose={() => setModal(null)} onSave={editCurrentWeek} />
      )}
      {modal?.type === 'wrapUp' && appData.currentWeek && (
        <WrapUpModal week={appData.currentWeek} players={appData.players} onClose={() => setModal(null)} onCommit={commitWrapUp} />
      )}
      {modal?.type === 'settings' && (
        <SettingsModal settings={appData.settings} onClose={() => setModal(null)} onSave={saveSettings} />
      )}
      {modal?.type === 'help' && <HelpModal cancelHours={appData.settings.cancelHours || 48} courtSize={appData.settings.courtSize || 12} farmBuffer={appData.settings.farmBuffer ?? 4} onClose={() => setModal(null)} />}

      {dialog && <Dialog {...dialog} />}
    </div>
  );
}

function newId() { return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

function IconButton({ children, onClick, ...rest }) {
  return (
    <button
      onClick={onClick}
      style={{ borderColor: styles.line, color: styles.inkMuted }}
      className="border rounded-md w-8 h-8 flex items-center justify-center hover:bg-zinc-50 text-sm transition-colors"
      {...rest}
    >
      {children}
    </button>
  );
}

function FirstTimeSetup({ onCreate }) {
  const [step, setStep] = useState('intro');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState('');

  function submit() {
    setError('');
    if (!name.trim()) return setError('Name is required');
    if (!/^\d{4}$/.test(pin)) return setError('PIN must be exactly 4 digits');
    if (pin !== pin2) return setError("PINs don't match");
    onCreate({ name: name.trim(), pin });
  }

  if (step === 'intro') {
    return (
      <div style={{ borderColor: styles.line, background: styles.surface }} className="border rounded-lg p-8 mt-8">
        <div style={{ fontWeight: 700, fontSize: 22, color: styles.inkStrong, letterSpacing: '-0.02em' }} className="mb-3">
          Set up your group
        </div>
        <p style={{ color: styles.inkMuted }} className="mb-6 text-sm leading-relaxed max-w-md">
          You'll be the first <strong style={{ color: styles.ink }}>organiser</strong> — you can add players, open weekly signups, run allocations, and share to WhatsApp. Each player picks their own 4-digit PIN.
        </p>
        <button onClick={() => setStep('form')} style={{ background: styles.ink, color: styles.bg }} className="px-5 py-2.5 rounded-md text-sm font-medium">
          Get started
        </button>
      </div>
    );
  }

  return (
    <div style={{ borderColor: styles.line, background: styles.surface }} className="border rounded-lg p-6 mt-8">
      <div style={{ fontWeight: 700, fontSize: 20, color: styles.inkStrong }} className="mb-5">Your details</div>
      <Label>Your name</Label>
      <TextInput autoFocus value={name} onChange={setName} placeholder="e.g. Eoin" />
      <Label>Set a 4-digit PIN</Label>
      <PinInput value={pin} onChange={setPin} />
      <Label>Confirm PIN</Label>
      <PinInput value={pin2} onChange={setPin2} onEnter={submit} />
      {error && <ErrorText>{error}</ErrorText>}
      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium mt-2">
        Create group
      </button>
    </div>
  );
}

function Label({ children }) {
  return <label style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.15em', color: styles.inkSubtle }} className="uppercase block mb-1.5 mt-3 first:mt-0">{children}</label>;
}

function TextInput({ value, onChange, placeholder, autoFocus, type = 'text' }) {
  return (
    <input
      type={type}
      autoFocus={autoFocus}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
      className="w-full border rounded-md px-3 py-2.5 mb-3 text-sm focus:outline-none focus:border-zinc-900 transition-colors"
    />
  );
}

function PinInput({ value, onChange, onEnter, placeholder }) {
  return (
    <input
      type="password"
      inputMode="numeric"
      maxLength={4}
      value={value}
      onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
      onKeyDown={e => e.key === 'Enter' && onEnter && onEnter()}
      placeholder={placeholder || '••••'}
      style={{ borderColor: styles.line, background: styles.bg, fontFamily: FONT_MONO, letterSpacing: '0.5em', color: styles.ink }}
      className="w-full border rounded-md px-3 py-2.5 mb-3 text-base text-center focus:outline-none focus:border-zinc-900 transition-colors"
    />
  );
}

function ErrorText({ children }) {
  return <div style={{ color: styles.warn }} className="text-sm mb-3">{children}</div>;
}

function SwitchUserModal({ roster, currentUserId, onClose, onAuthenticate, onClaim }) {
  const [step, setStep] = useState('pick');
  const [selectedId, setSelectedId] = useState(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState('');
  const selected = roster.find(p => p.id === selectedId);

  function pickPlayer(p) {
    setSelectedId(p.id); setError(''); setPin(''); setPin2('');
    if (!p.claimed) setStep('claim'); else setStep('pin');
  }

  async function tryAuth() {
    setError('');
    if (!/^\d{4}$/.test(pin)) return setError('Enter 4 digits');
    const res = await onAuthenticate({ id: selectedId, pin });
    if (!res.ok) setError(res.error); else onClose();
  }

  async function tryClaim() {
    setError('');
    if (!/^\d{4}$/.test(pin)) return setError('PIN must be 4 digits');
    if (pin !== pin2) return setError("PINs don't match");
    await onClaim({ id: selectedId, pin });
  }

  return (
    <Modal onClose={onClose} title={step === 'pick' ? 'Sign in' : selected?.name} wide={step === 'pick'}>
      {step === 'pick' && (
        <div className="space-y-1 max-h-96 overflow-y-auto -mx-1 px-1">
          {roster.map(p => (
            <button
              key={p.id}
              onClick={() => pickPlayer(p)}
              style={{
                background: currentUserId === p.id ? styles.ink : styles.bg,
                color: currentUserId === p.id ? styles.bg : styles.ink,
                borderColor: currentUserId === p.id ? styles.ink : styles.line,
              }}
              className="w-full border rounded-md px-3 py-2.5 text-left flex justify-between items-center hover:border-zinc-400 transition-colors"
            >
              <span className="flex items-center gap-2 flex-wrap">
                <span style={{ fontWeight: 500, fontSize: 14 }}>{p.name}</span>
                {p.isOrganiser && <Tag muted={currentUserId === p.id}>organiser</Tag>}
                {!p.claimed && <Tag muted>unclaimed</Tag>}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, opacity: 0.7 }}>{p.points >= 0 ? '+' : ''}{p.points}</span>
            </button>
          ))}
        </div>
      )}
      {step === 'pin' && (
        <div>
          <p style={{ color: styles.inkMuted }} className="text-sm mb-4">Enter your 4-digit PIN.</p>
          <PinInput value={pin} onChange={setPin} onEnter={tryAuth} />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <button onClick={() => setStep('pick')} style={{ borderColor: styles.line }} className="flex-1 border rounded-md py-2.5 text-sm hover:bg-zinc-50">Back</button>
            <button onClick={tryAuth} style={{ background: styles.ink, color: styles.bg }} className="flex-1 rounded-md py-2.5 text-sm font-medium">Sign in</button>
          </div>
        </div>
      )}
      {step === 'claim' && (
        <div>
          <p style={{ color: styles.inkMuted }} className="text-sm mb-4">This account hasn't been claimed yet. Set a 4-digit PIN to claim it.</p>
          <PinInput value={pin} onChange={setPin} placeholder="New PIN" />
          <PinInput value={pin2} onChange={setPin2} onEnter={tryClaim} placeholder="Confirm PIN" />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <button onClick={() => setStep('pick')} style={{ borderColor: styles.line }} className="flex-1 border rounded-md py-2.5 text-sm hover:bg-zinc-50">Back</button>
            <button onClick={tryClaim} style={{ background: styles.ink, color: styles.bg }} className="flex-1 rounded-md py-2.5 text-sm font-medium">Claim</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Tag({ children, muted }) {
  return (
    <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: '0.15em', color: muted ? styles.inkSubtle : styles.inkMuted }} className="uppercase">
      {children}
    </span>
  );
}

function BulkAddModal({ onClose, onAdd, existingCount }) {
  const [text, setText] = useState('');
  const [setSharedPin, setSetSharedPin] = useState(true);
  const [pin, setPin] = useState('1234');
  const [error, setError] = useState('');

  const lineCount = text.split('\n').map(l => l.trim()).filter(Boolean).length;

  function submit() {
    setError('');
    if (lineCount === 0) return setError('Paste at least one name (one per line).');
    if (setSharedPin && !/^\d{4}$/.test(pin)) return setError('Temporary PIN must be exactly 4 digits.');
    onAdd({ rawText: text, sharedPin: setSharedPin ? pin : null });
  }

  return (
    <Modal onClose={onClose} title="Bulk add players" wide>
      <p style={{ color: styles.inkMuted }} className="text-sm mb-4 leading-relaxed">
        Paste a list of names, one per line. Existing names in the roster will be skipped automatically.
        {existingCount > 0 && <> Currently <strong style={{ color: styles.ink }}>{existingCount}</strong> {existingCount === 1 ? 'player' : 'players'} in roster.</>}
      </p>

      <Label>Names — one per line</Label>
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        rows={12}
        placeholder={'Eoin Corrigan\nTom Murphy\nSarah Lefevre\n…'}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink, fontFamily: FONT_MONO, fontSize: 13 }}
        className="w-full border rounded-md px-3 py-2.5 mb-1 leading-relaxed resize-none"
      />
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: styles.inkMuted }} className="text-right mb-3">
        {lineCount} {lineCount === 1 ? 'name' : 'names'} detected
      </div>

      <Checkbox
        checked={setSharedPin}
        onChange={setSetSharedPin}
        label="Set a shared temporary PIN"
        sub="Same PIN for everyone you add. Share it privately in the WhatsApp group. Each player should change theirs on first sign-in."
      />
      {setSharedPin && (
        <input
          type="text" inputMode="numeric" maxLength={4}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="4-digit PIN"
          style={{ borderColor: styles.line, background: styles.bg, fontFamily: FONT_MONO, letterSpacing: '0.5em' }}
          className="w-full border rounded-md px-3 py-2.5 mb-3 text-base text-center"
        />
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium mt-2">
        Add {lineCount > 0 ? `${lineCount} ` : ''}player{lineCount === 1 ? '' : 's'}
      </button>
    </Modal>
  );
}

function RenamePlayerModal({ player, onClose, onSave }) {
  const [name, setName] = useState(player?.name || '');
  if (!player) return null;
  return (
    <Modal onClose={onClose} title="Change display name">
      <p style={{ color: styles.inkMuted }} className="text-sm mb-4 leading-relaxed">
        How {player.name === name ? 'this' : 'this'} name appears in signups, history, and audit log. Up to 30 characters.
      </p>
      <Label>Display name</Label>
      <TextInput autoFocus value={name} onChange={setName} placeholder="Display name" />
      <div className="flex gap-2 mt-2">
        <button onClick={onClose} style={{ background: styles.bg, color: styles.ink, borderColor: styles.line }} className="flex-1 border py-3 rounded-md font-medium">Cancel</button>
        <button onClick={() => onSave(name)} style={{ background: styles.ink, color: styles.bg }} className="flex-1 py-3 rounded-md font-medium">Save</button>
      </div>
    </Modal>
  );
}

function AddPlayerModal({ onClose, onAdd }) {
  const [name, setName] = useState('');
  const [setPinNow, setSetPinNow] = useState(false);
  const [pin, setPin] = useState('');
  const [asOrganiser, setAsOrganiser] = useState(false);
  const [error, setError] = useState('');

  function submit() {
    setError('');
    if (!name.trim()) return setError('Name required');
    if (setPinNow && !/^\d{4}$/.test(pin)) return setError('PIN must be 4 digits');
    onAdd({ name: name.trim(), pin: setPinNow ? pin : null, asOrganiser });
  }

  return (
    <Modal onClose={onClose} title="Add player">
      <Label>Name</Label>
      <TextInput autoFocus value={name} onChange={setName} placeholder="Player name" />

      <Checkbox checked={setPinNow} onChange={setSetPinNow} label="Set a temporary PIN" sub="Share it with them. Otherwise they'll set their own when they first sign in." />
      {setPinNow && (
        <input
          type="text" inputMode="numeric" maxLength={4}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="4-digit PIN"
          style={{ borderColor: styles.line, background: styles.bg, fontFamily: FONT_MONO, letterSpacing: '0.5em' }}
          className="w-full border rounded-md px-3 py-2.5 mb-3 text-base text-center"
        />
      )}

      <Checkbox checked={asOrganiser} onChange={setAsOrganiser} label="Make organiser" sub="Can add players, run allocations, and manage weeks." />

      {error && <ErrorText>{error}</ErrorText>}
      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium mt-2">Add player</button>
    </Modal>
  );
}

function Checkbox({ checked, onChange, label, sub }) {
  return (
    <label className="flex items-start gap-2.5 mb-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-1 accent-zinc-900" />
      <div>
        <div className="text-sm font-medium" style={{ color: styles.ink }}>{label}</div>
        {sub && <div style={{ color: styles.inkMuted }} className="text-xs mt-0.5">{sub}</div>}
      </div>
    </label>
  );
}

function StartWeekModal({ weekNumber, players = [], onClose, onStart }) {
  const [deadline, setDeadline] = useState('');
  const [gameAt, setGameAt] = useState('');
  const [bookers, setBookers] = useState([]);

  function toggleBooker(id) {
    setBookers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function submit() {
    onStart({
      deadline: deadline ? new Date(deadline).getTime() : null,
      gameAt: gameAt ? new Date(gameAt).getTime() : null,
      bookers,
    });
  }

  return (
    <Modal onClose={onClose} title={`Open week ${weekNumber}`} wide>
      <p style={{ color: styles.inkMuted }} className="text-sm mb-4 leading-relaxed">
        Set the game date — used in the WhatsApp share message and drives the cancellation cutoff.
      </p>
      <Label>Game day & time</Label>
      <input
        type="datetime-local"
        value={gameAt}
        onChange={e => setGameAt(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-1 text-sm"
      />
      <Label>Signup deadline (optional)</Label>
      <input
        type="datetime-local"
        value={deadline}
        onChange={e => setDeadline(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-3 text-sm"
      />

      <Label>Court bookers (optional)</Label>
      <p style={{ color: styles.inkMuted }} className="text-xs mb-2 leading-relaxed">
        Whoever booked the court(s) gets a guaranteed starter spot — a thank-you for doing the legwork. Tap to toggle.
      </p>
      {players.length === 0 ? (
        <p style={{ color: styles.inkMuted }} className="text-xs italic mb-4">No players in the roster yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-4 max-h-48 overflow-y-auto">
          {players.map(p => {
            const selected = bookers.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleBooker(p.id)}
                style={{
                  background: selected ? styles.ink : styles.bg,
                  color: selected ? styles.bg : styles.ink,
                  borderColor: selected ? styles.ink : styles.line,
                }}
                className="border rounded-md px-2.5 py-1 text-xs"
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}

      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium">
        Open signups{bookers.length > 0 ? ` (${bookers.length} booker${bookers.length > 1 ? 's' : ''} pre-entered)` : ''}
      </button>
    </Modal>
  );
}

function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditWeekModal({ week, onClose, onSave }) {
  const [gameAt, setGameAt] = useState(toLocalInput(week.gameAt));
  const [deadline, setDeadline] = useState(toLocalInput(week.deadline));

  function submit() {
    onSave({
      gameAt: gameAt ? new Date(gameAt).getTime() : null,
      deadline: deadline ? new Date(deadline).getTime() : null,
    });
  }

  return (
    <Modal onClose={onClose} title={`Edit week ${week.number}`}>
      <p style={{ color: styles.inkMuted }} className="text-sm mb-4 leading-relaxed">
        Change the game time or signup deadline. {week.status === 'open' && 'If you set a deadline that has already passed, allocation will run on the next save.'}
      </p>
      <Label>Game day & time</Label>
      <input
        type="datetime-local"
        value={gameAt}
        onChange={e => setGameAt(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-3 text-sm"
      />
      <Label>Signup deadline</Label>
      <input
        type="datetime-local"
        value={deadline}
        onChange={e => setDeadline(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-4 text-sm"
      />
      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium">
        Save changes
      </button>
    </Modal>
  );
}
function WrapUpModal({ week, players, onClose, onCommit }) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    Object.entries(week.signups).forEach(([id, info]) => {
      if (info.outcome) d[id] = info.outcome;
      else if (info.slot === 'starter') d[id] = 'played';
      else if (info.slot === 'reserve') d[id] = 'no_play';
      else if (info.slot === 'cancelled') d[id] = info.outcome || 'cancelled_early';
    });
    return d;
  });

  return (
    <Modal onClose={onClose} title={`Wrap up week ${week.number}`} wide>
      <p style={{ color: styles.inkMuted }} className="text-sm mb-4">Confirm what happened. Points apply when you save.</p>
      <div className="space-y-2 max-h-96 overflow-y-auto -mx-1 px-1">
        {Object.entries(week.signups).map(([id, info]) => {
          const player = players.find(p => p.id === id);
          if (!player) return null;
          const outcome = draft[id];
          const isCancelled = info.slot === 'cancelled';
          const isStarter = info.slot === 'starter';

          let options;
          const playedHint = info.originalSlot === 'reserve' ? '+1' : '0';
          if (isStarter) {
            options = [['played', 'Played', playedHint], ['cancelled_early', 'Cancelled 48h+', '±0'], ['cancelled_late', 'Late cancel', '−2'], ['no_show', 'No-show', '−2']];
          } else if (isCancelled) {
            if (info.originalSlot === 'reserve') {
              options = [['no_play', 'Dropped out', '+1']];
            } else {
              options = [['cancelled_early', 'Cancelled 48h+', '±0'], ['cancelled_late', 'Late cancel', '−2'], ['no_show', 'No-show', '−2']];
            }
          } else {
            options = [['no_play', "Didn't play", '+1'], ['played', 'Subbed in', '+1']];
          }

          return (
            <div key={id} style={{ borderColor: styles.line, background: styles.surface }} className="border rounded-md p-3">
              <div className="flex justify-between items-center mb-2">
                <span style={{ fontWeight: 600, fontSize: 14, color: styles.ink }} className="flex items-center gap-2">
                  <span>{player.name}</span>
                  {info.promoted && <Tag>promoted</Tag>}
                </span>
                <Tag>{isCancelled ? 'dropped out' : info.slot}</Tag>
              </div>
              <div className="flex gap-1 flex-wrap">
                {options.map(([val, label, hint]) => (
                  <button
                    key={val}
                    onClick={() => setDraft({ ...draft, [id]: val })}
                    style={{
                      background: outcome === val ? styles.ink : styles.bg,
                      color: outcome === val ? styles.bg : styles.ink,
                      borderColor: outcome === val ? styles.ink : styles.line,
                    }}
                    className="border rounded-md px-2.5 py-1 text-xs hover:border-zinc-500 transition-colors"
                  >
                    {label} <span style={{ opacity: 0.6 }}>{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => onCommit(draft)} style={{ background: styles.ink, color: styles.bg }} className="w-full mt-4 py-3 rounded-md font-medium">
        Save & finish week
      </button>
    </Modal>
  );
}

function SettingsModal({ settings, onClose, onSave }) {
  const [groupName, setGroupName] = useState(settings.groupName || 'Fitz Tuesday Crew');
  const [shareUrl, setShareUrl] = useState(settings.shareUrl || '');
  const [courtSize, setCourtSize] = useState(settings.courtSize || 12);
  const [cancelHours, setCancelHours] = useState(settings.cancelHours || 48);
  const [farmBuffer, setFarmBuffer] = useState(settings.farmBuffer ?? 4);

  function submit() {
    onSave({
      groupName: groupName.trim() || 'Court allocation',
      shareUrl: shareUrl.trim(),
      courtSize: parseInt(courtSize) || 12,
      cancelHours: parseInt(cancelHours) || 48,
      farmBuffer: Math.max(0, parseInt(farmBuffer) || 0),
    });
  }

  return (
    <Modal onClose={onClose} title="Settings">
      <Label>Group name</Label>
      <TextInput value={groupName} onChange={setGroupName} placeholder="e.g. Fitz Tuesday Crew" />
      <p style={{ color: styles.inkMuted }} className="text-xs mb-3 -mt-1 leading-relaxed">
        Shown as the heading and used in WhatsApp messages.
      </p>
      <Label>App link (used in WhatsApp shares)</Label>
      <TextInput value={shareUrl} onChange={setShareUrl} placeholder="https://..." />
      <p style={{ color: styles.inkMuted }} className="text-xs mb-3 -mt-1 leading-relaxed">
        Pasted into WhatsApp messages so people can open the app.
      </p>
      <Label>Court size</Label>
      <input
        type="number" min="2" max="40"
        value={courtSize}
        onChange={e => setCourtSize(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-3 text-sm"
      />
      <Label>Cancellation cutoff (hours before game)</Label>
      <input
        type="number" min="0" max="168"
        value={cancelHours}
        onChange={e => setCancelHours(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-1 text-sm"
      />
      <p style={{ color: styles.inkMuted }} className="text-xs mb-4 leading-relaxed">
        Drops within this window count as a "late cancel" (−2 points). Default 48h.
      </p>
      <Label>Bonus-eligible reserve depth</Label>
      <input
        type="number" min="0" max="20"
        value={farmBuffer}
        onChange={e => setFarmBuffer(e.target.value)}
        style={{ borderColor: styles.line, background: styles.bg, color: styles.ink }}
        className="w-full border rounded-md px-3 py-2.5 mb-1 text-sm"
      />
      <p style={{ color: styles.inkMuted }} className="text-xs mb-4 leading-relaxed">
        Only the first {parseInt(courtSize) + (parseInt(farmBuffer) || 0)} signups (12 starters + {farmBuffer} reserves) earn the +1 bonus if bumped. Anyone who joins later when the lineup is clearly full gets nothing — stops queue-stuffing for free points.
      </p>
      <button onClick={submit} style={{ background: styles.ink, color: styles.bg }} className="w-full py-3 rounded-md font-medium">
        Save settings
      </button>
    </Modal>
  );
}

function HelpModal({ cancelHours, courtSize, farmBuffer, onClose }) {
  const farmCutoff = (courtSize || 12) + (farmBuffer ?? 4);
  return (
    <Modal onClose={onClose} title="How it works" wide>
      <div className="space-y-5 text-sm" style={{ color: styles.ink }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: styles.inkStrong }} className="mb-2">Priority points</div>
          <div style={{ borderColor: styles.line }} className="border rounded-md divide-y" data-divide>
            <PointRow label="Signed up before deadline, didn't play" value="+1" />
            <PointRow label="Signed up after deadline, didn't play" value="±0" />
            <PointRow label="Played as starter" value="reset to 0" />
            <PointRow label="Played as a reserve (subbed in / promoted)" value="+1" />
            <PointRow label={`Cancelled ${cancelHours}h+ in advance`} value="±0" />
            <PointRow label="Late cancel / no-show" value="−2" warn />
          </div>
          <p style={{ color: styles.inkMuted }} className="text-xs mt-2 leading-relaxed">Higher points get first pick. Ties broken at random. Allocation runs automatically at the signup deadline. After that, late additions can still join the reserve list to fill last-minute gaps, but they don't earn the +1 bump if bumped — committing on time is what gets rewarded. If no deadline is set, the fallback is the first {farmCutoff} signups.</p>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: styles.inkStrong }} className="mb-1.5">Roles</div>
          <p style={{ color: styles.inkMuted }} className="leading-relaxed"><strong style={{ color: styles.ink }}>Organisers</strong> open weeks, set the game date, run allocations, manage players, and send WhatsApp messages to the group. Anyone can sign themselves up and drop themselves out.</p>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: styles.inkStrong }} className="mb-1.5">Court bookers</div>
          <p style={{ color: styles.inkMuted }} className="leading-relaxed">Whoever booked the court(s) gets a guaranteed starter spot for that week. The organiser ticks them off when opening signups. Bookers are auto-entered, jumping the points queue — a thank-you for doing the legwork.</p>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: styles.inkStrong }} className="mb-1.5">Drop-outs & auto-promotion</div>
          <p style={{ color: styles.inkMuted }} className="leading-relaxed">Tap "I can't make it" on the week page after allocation. The top-priority reserve is auto-promoted instantly. If an organiser drops out, they're prompted to share the update on WhatsApp.</p>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: styles.inkStrong }} className="mb-1.5">PINs</div>
          <p style={{ color: styles.inkMuted }} className="leading-relaxed">Each player picks a 4-digit PIN on first sign-in. Forgot it? Any organiser can reset it from the Roster tab.</p>
        </div>
      </div>
    </Modal>
  );
}

function PointRow({ label, value, warn }) {
  return (
    <div className="flex justify-between items-center px-3 py-2" style={{ borderColor: styles.line }}>
      <span style={{ color: styles.ink }}>{label}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: warn ? styles.warn : styles.ink, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

function WeekView({ appData, currentUser, isOrganiser, onStartWeek, onEditWeek, onToggleSignup, onAllocate, onReopen, onWrapUp, onPromptLogin, onDropOut, onJoinLate, onMarkLineupShared, onRemovePlayer }) {
  const week = appData.currentWeek;
  const settings = appData.settings;

  if (!week) {
    return (
      <div style={{ borderColor: styles.line }} className="border rounded-lg p-10 text-center">
        <div style={{ fontWeight: 700, fontSize: 18, color: styles.inkStrong, letterSpacing: '-0.01em' }} className="mb-2">No active week</div>
        {isOrganiser ? (
          <>
            <p style={{ color: styles.inkMuted }} className="mb-6 text-sm">
              Open signups for week {(appData.weekCounter || 0) + 1} when you're ready.
            </p>
            <button onClick={onStartWeek} style={{ background: styles.ink, color: styles.bg }} className="px-5 py-2.5 rounded-md text-sm font-medium">
              Open signups
            </button>
          </>
        ) : (
          <p style={{ color: styles.inkMuted }} className="text-sm">Waiting for an organiser to open the next week.</p>
        )}
      </div>
    );
  }

  const signupIds = Object.keys(week.signups);
  const myInfo = currentUser ? week.signups[currentUser.id] : null;
  const meSignedUp = !!myInfo && myInfo.slot !== 'cancelled';
  const courtSize = settings.courtSize;

  const shareSignup = () => window.open(whatsappUrl(buildSignupMessage({ week, players: appData.players, settings })), '_blank');
  const shareLineup = () => {
    window.open(whatsappUrl(buildLineupMessage({ week, players: appData.players, settings })), '_blank');
    if (onMarkLineupShared) onMarkLineupShared();
  };

  if (week.status === 'open') {
    const bookerSet = new Set(week.bookers || []);
    const signedUpPlayers = signupIds
      .map(id => appData.players.find(p => p.id === id))
      .filter(Boolean)
      .sort((a, b) => {
        const aB = bookerSet.has(a.id) ? 1 : 0;
        const bB = bookerSet.has(b.id) ? 1 : 0;
        if (aB !== bB) return bB - aB;
        return b.points - a.points;
      });

    return (
      <div>
        <WeekHeader
          eyebrow={`Week ${week.number} · Signups open`}
          number={signupIds.length}
          total={courtSize}
          subRight={signupIds.length > courtSize ? `+${signupIds.length - courtSize} reserve` : `${courtSize - signupIds.length} to fill`}
          gameAt={week.gameAt}
          deadline={week.deadline}
        />

        {isOrganiser && (
          <button onClick={onEditWeek} style={{ color: styles.inkMuted, borderColor: styles.line, background: styles.bg }} className="border rounded-md px-3 py-1.5 text-xs mb-3 hover:bg-zinc-50">
            Edit week details
          </button>
        )}

        {isOrganiser && (
          <button onClick={shareSignup} style={{ background: styles.whatsapp, color: 'white' }} className="w-full rounded-md p-2.5 mb-3 flex items-center justify-center gap-2 font-medium text-sm">
            <WhatsAppIcon /> Share signup link to WhatsApp
          </button>
        )}

        {currentUser ? (
          <button
            onClick={() => onToggleSignup(currentUser.id)}
            style={{
              background: meSignedUp ? styles.bg : styles.ink,
              color: meSignedUp ? styles.ink : styles.bg,
              borderColor: meSignedUp ? styles.line : styles.ink,
            }}
            className="w-full border rounded-md p-4 mb-6 text-left transition-colors"
          >
            <div style={{ fontWeight: 600, fontSize: 16 }}>
              {meSignedUp ? "You're in — tap to drop out" : "Tap to sign up"}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, opacity: 0.7 }} className="mt-0.5">
              Your priority: {currentUser.points >= 0 ? '+' : ''}{currentUser.points}
            </div>
          </button>
        ) : (
          <button onClick={onPromptLogin} style={{ background: styles.ink, color: styles.bg }} className="w-full rounded-md p-3.5 mb-6 text-center font-medium text-sm">
            Sign in to sign up
          </button>
        )}

        <SectionLabel>Signed up · {signupIds.length}</SectionLabel>
        <div className="space-y-1">
          {signupIds.length === 0 && (
            <div style={{ color: styles.inkMuted }} className="text-sm py-3 text-center">No one yet.</div>
          )}
          {signedUpPlayers.map((p, i) => (
            <PlayerRow
              key={p.id}
              player={p}
              index={i}
              highlight={i < courtSize}
              subtle={i >= courtSize}
              isMe={p.id === currentUser?.id}
              isBooker={bookerSet.has(p.id)}
              onRemove={isOrganiser && p.id !== currentUser?.id ? () => onRemovePlayer(p.id) : null}
            />
          ))}
        </div>

        {isOrganiser && (() => {
          const notSignedUp = appData.players
            .filter(p => !signupIds.includes(p.id))
            .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
          if (notSignedUp.length === 0) return null;
          return (
            <div className="mt-6">
              <SectionLabel>Add players manually · organiser only</SectionLabel>
              <p style={{ color: styles.inkMuted }} className="text-xs mb-2 leading-relaxed">
                Tap to add a player who hasn't signed up themselves (e.g. someone who confirmed via WhatsApp). They'll be marked as signed up at the moment you tap.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {notSignedUp.map(p => (
                  <button
                    key={p.id}
                    onClick={() => onToggleSignup(p.id)}
                    style={{ background: styles.bg, borderColor: styles.line, color: styles.ink }}
                    className="border rounded-md px-2.5 py-1 text-xs hover:bg-zinc-50 transition-colors"
                  >
                    + {p.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {isOrganiser && (
          <button
            onClick={onAllocate}
            disabled={signupIds.length === 0}
            style={{
              background: signupIds.length === 0 ? styles.surfaceStrong : styles.ink,
              color: signupIds.length === 0 ? styles.inkSubtle : styles.bg,
            }}
            className="w-full mt-6 py-3 rounded-md text-sm font-medium"
          >
            Run allocation
          </button>
        )}
      </div>
    );
  }

  const starters = signupIds.filter(id => week.signups[id].slot === 'starter');
  const reserves = signupIds.filter(id => week.signups[id].slot === 'reserve');
  const cancelled = signupIds.filter(id => week.signups[id].slot === 'cancelled');
  const meIsStarter = myInfo && myInfo.slot === 'starter';
  const meIsReserve = myInfo && myInfo.slot === 'reserve';

  return (
    <div>
      <WeekHeader
        eyebrow={`Week ${week.number} · Allocated`}
        number={starters.length}
        label="starters"
        gameAt={week.gameAt}
      />

      {isOrganiser && (
        <button onClick={onEditWeek} style={{ color: styles.inkMuted, borderColor: styles.line, background: styles.bg }} className="border rounded-md px-3 py-1.5 text-xs mb-3 hover:bg-zinc-50">
          Edit week details
        </button>
      )}

      {/* Escalated: court is short — someone dropped and no reserve was available */}
      {starters.length < courtSize && (
        <div style={{ background: '#fef3c7', borderColor: '#f59e0b' }} className="border rounded-md p-3.5 mb-3">
          <div style={{ fontWeight: 600, fontSize: 14, color: '#92400e' }} className="mb-1">
            Court short — {starters.length} of {courtSize}
          </div>
          <p style={{ color: '#92400e' }} className="text-xs mb-3 leading-relaxed">
            A starter dropped out and no reserves were available. A sub is needed.
          </p>
          {isOrganiser && (
            <button
              onClick={() => {
                const gameTime = week.gameAt ? ` at ${fmtDateTime(week.gameAt)}` : '';
                const shortBy = courtSize - starters.length;
                const playerWord = shortBy === 1 ? 'a player' : `${shortBy} players`;
                const msg = `${appData.settings.groupName || 'Padel'} — looking for a sub for week ${week.number}${gameTime}.\n\nWe're ${playerWord} short. If you can make it, sign up via the app: ${appData.settings.shareUrl || '[paste app link]'}`;
                window.open(whatsappUrl(msg), '_blank');
              }}
              style={{ background: styles.whatsapp, color: 'white' }}
              className="w-full rounded-md py-2 text-sm font-medium flex items-center justify-center gap-2"
            >
              <WhatsAppIcon /> Send sub-request
            </button>
          )}
        </div>
      )}

      {/* Proactive: full court but zero reserves on standby */}
      {starters.length === courtSize && reserves.length === 0 && (
        <div style={{ background: '#fffbeb', borderColor: '#fcd34d' }} className="border rounded-md p-3 mb-3">
          <div style={{ fontWeight: 600, fontSize: 13, color: '#92400e' }} className="mb-0.5">
            No reserves on standby
          </div>
          <p style={{ color: '#92400e' }} className="text-xs leading-relaxed">
            Late drop-outs cannot be auto-covered. If a starter pulls out, the court will be short unless a sub is found.
          </p>
        </div>
      )}

      {isOrganiser && !week.lineupShared && (
        <div style={{ background: '#f0fdf4', borderColor: '#86efac' }} className="border rounded-md p-3.5 mb-3">
          <div style={{ fontWeight: 600, fontSize: 14, color: '#14532d' }} className="mb-1">Lineup ready</div>
          <p style={{ color: '#166534' }} className="text-xs mb-3 leading-relaxed">
            Allocation has run. The group hasn't been notified yet — share the lineup to WhatsApp now?
          </p>
          <div className="flex gap-2">
            <button onClick={shareLineup} style={{ background: styles.whatsapp, color: 'white' }} className="flex-1 rounded-md py-2 text-sm font-medium flex items-center justify-center gap-2">
              <WhatsAppIcon /> Share now
            </button>
            <button onClick={onMarkLineupShared} style={{ borderColor: '#86efac', color: '#166534', background: 'transparent' }} className="border rounded-md px-4 py-2 text-sm">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {isOrganiser && (
        <button onClick={shareLineup} style={{ background: styles.whatsapp, color: 'white' }} className="w-full rounded-md p-2.5 mb-3 flex items-center justify-center gap-2 font-medium text-sm">
          <WhatsAppIcon /> Share lineup to WhatsApp
        </button>
      )}

      {currentUser && (meIsStarter || meIsReserve) && (
        <button
          onClick={() => onDropOut(currentUser.id)}
          style={{ background: styles.bg, borderColor: styles.accent, color: styles.accent }}
          className="w-full border rounded-md p-2.5 mb-6 font-medium text-sm hover:bg-red-50 transition-colors"
        >
          I can't make it — drop me out
        </button>
      )}

      {currentUser && !myInfo && (
        <button
          onClick={() => onJoinLate(currentUser.id)}
          style={{ background: styles.bg, borderColor: styles.line, color: styles.ink }}
          className="w-full border rounded-md p-2.5 mb-6 font-medium text-sm hover:bg-zinc-50 transition-colors"
        >
          Add me to the reserve list
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: styles.inkMuted, fontWeight: 400 }} className="mt-1">
            Signups closed — late additions don't earn the +1 bump
          </div>
        </button>
      )}

      <SectionLabel>Starters · {starters.length}</SectionLabel>
      <div className="space-y-1 mb-6">
        {starters.map(id => {
          const p = appData.players.find(pp => pp.id === id);
          const info = week.signups[id];
          return p && <PlayerRow key={id} player={p} highlight isMe={p.id === currentUser?.id} promoted={info.promoted} isBooker={info.isBooker} onRemove={isOrganiser && p.id !== currentUser?.id ? () => onRemovePlayer(p.id) : null} />;
        })}
      </div>

      {reserves.length > 0 && (
        <>
          <SectionLabel>Reserves · {reserves.length}</SectionLabel>
          <div className="space-y-1 mb-6">
            {reserves.map((id, i) => {
              const p = appData.players.find(pp => pp.id === id);
              const info = week.signups[id];
              return p && <PlayerRow key={id} player={p} subtle isMe={p.id === currentUser?.id} reserveIndex={i + 1} isBooker={info.isBooker} onRemove={isOrganiser && p.id !== currentUser?.id ? () => onRemovePlayer(p.id) : null} />;
            })}
          </div>
        </>
      )}

      {cancelled.length > 0 && (
        <>
          <SectionLabel>Dropped out · {cancelled.length}</SectionLabel>
          <div className="space-y-1 mb-6">
            {cancelled.map(id => {
              const p = appData.players.find(pp => pp.id === id);
              const info = week.signups[id];
              return p && (
                <div key={id} style={{ borderColor: styles.line, opacity: 0.55 }} className="border rounded-md px-3 py-2 flex items-center justify-between">
                  <span style={{ fontSize: 14, textDecoration: 'line-through' }}>{p.name}</span>
                  <Tag muted>{info.outcome === 'cancelled_late' ? 'late' : 'dropped'}</Tag>
                </div>
              );
            })}
          </div>
        </>
      )}

      {isOrganiser && (() => {
        const allSignedUpIds = Object.keys(week.signups);
        const notSignedUp = appData.players
          .filter(p => !allSignedUpIds.includes(p.id))
          .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
        if (notSignedUp.length === 0) return null;
        return (
          <div className="mb-6">
            <SectionLabel>Add late reserve · organiser only</SectionLabel>
            <p style={{ color: styles.inkMuted }} className="text-xs mb-2 leading-relaxed">
              Tap to add someone to the reserve list. They won't earn the +1 bump if bumped — late signups don't qualify.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {notSignedUp.map(p => (
                <button
                  key={p.id}
                  onClick={() => onJoinLate(p.id)}
                  style={{ background: styles.bg, borderColor: styles.line, color: styles.ink }}
                  className="border rounded-md px-2.5 py-1 text-xs hover:bg-zinc-50 transition-colors"
                >
                  + {p.name}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {isOrganiser && (
        <div className="flex gap-2 mt-6">
          <button onClick={onReopen} style={{ borderColor: styles.line, color: styles.inkMuted }} className="flex-1 border rounded-md py-2.5 text-sm hover:bg-zinc-50">
            Reopen signups
          </button>
          <button onClick={onWrapUp} style={{ background: styles.ink, color: styles.bg }} className="flex-1 rounded-md py-2.5 text-sm font-medium">
            Wrap up week
          </button>
        </div>
      )}
    </div>
  );
}

function WeekHeader({ eyebrow, number, total, label, subRight, gameAt, deadline }) {
  return (
    <div style={{ borderColor: styles.line }} className="border rounded-lg p-5 mb-3">
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.2em', color: styles.inkMuted }} className="uppercase mb-2">
        {eyebrow}
      </div>
      <div className="flex items-baseline justify-between">
        <div style={{ fontWeight: 800, fontSize: 36, lineHeight: 1, letterSpacing: '-0.03em', color: styles.inkStrong }}>
          {number}
          {total !== undefined && <span style={{ color: styles.inkSubtle, fontWeight: 500 }}> / {total}</span>}
          {label && <span style={{ fontSize: 16, fontWeight: 500, color: styles.inkMuted, marginLeft: 8 }}>{label}</span>}
        </div>
        {subRight && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkMuted }}>
            {subRight}
          </div>
        )}
      </div>
      {(gameAt || deadline) && (
        <div className="mt-3 pt-3 border-t space-y-0.5" style={{ borderColor: styles.line, fontFamily: FONT_MONO, fontSize: 11, color: styles.inkMuted }}>
          {gameAt && <div>Game: {fmtDateTime(gameAt)}</div>}
          {deadline && <div>Signups close: {fmtDateTime(deadline)}{deadlineRel(deadline) && <span style={{ color: styles.ink, marginLeft: 6 }}>· {deadlineRel(deadline)}</span>}</div>}
        </div>
      )}
    </div>
  );
}

function PlayerRow({ player, index, highlight, subtle, isMe, promoted, reserveIndex, isBooker, onRemove }) {
  return (
    <div
      style={{
        background: highlight ? styles.surface : styles.bg,
        borderColor: styles.line,
        opacity: subtle ? 0.65 : 1,
      }}
      className="border rounded-md px-3 py-2 flex items-center justify-between"
    >
      <div className="flex items-center gap-3 min-w-0">
        {typeof index === 'number' && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkSubtle, width: 18 }}>
            {String(index + 1).padStart(2, '0')}
          </span>
        )}
        {typeof reserveIndex === 'number' && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkSubtle, width: 18 }}>
            R{reserveIndex}
          </span>
        )}
        <span style={{ fontSize: 14, fontWeight: isMe ? 700 : 500, color: styles.ink }} className="truncate">
          {player.name}
          {isMe && <span style={{ color: styles.inkMuted, fontSize: 11, fontWeight: 400, marginLeft: 6 }}>· you</span>}
          {isBooker && <span style={{ color: styles.inkMuted, fontSize: 11, fontWeight: 400, marginLeft: 6 }}>· booked</span>}
          {promoted && <span style={{ color: styles.inkMuted, fontSize: 11, fontWeight: 400, marginLeft: 6 }}>· promoted</span>}
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: player.points > 0 ? styles.ink : (player.points < 0 ? styles.warn : styles.inkSubtle), fontWeight: 500 }}>
          {player.points >= 0 ? '+' : ''}{player.points}
        </span>
        {onRemove && (
          <button
            onClick={onRemove}
            aria-label={`Remove ${player.name}`}
            title="Remove (organiser correction, no penalty)"
            style={{ color: styles.inkMuted, borderColor: styles.line, background: styles.bg, lineHeight: 1 }}
            className="border rounded-md w-6 h-6 flex items-center justify-center text-sm hover:bg-zinc-100 hover:text-red-600 hover:border-red-300 transition-colors"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.2em', color: styles.inkMuted }} className="uppercase mb-2 mt-1">
      {children}
    </div>
  );
}

function RosterView({ roster, currentUserId, isOrganiser, onAdd, onBulkAdd, onRename, onRemove, onResetPin, onToggleOrganiser, onResetPoints, onStartFresh, onReset }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <SectionLabel>Roster · sorted by priority</SectionLabel>
        {isOrganiser && (
          <div className="flex gap-1.5">
            <button onClick={onBulkAdd} style={{ background: styles.bg, color: styles.ink, borderColor: styles.line }} className="border px-3 py-1.5 rounded-md text-xs font-medium">Bulk add</button>
            <button onClick={onAdd} style={{ background: styles.ink, color: styles.bg }} className="px-3 py-1.5 rounded-md text-xs font-medium">+ Add</button>
          </div>
        )}
      </div>
      {roster.length === 0 ? (
        <div style={{ color: styles.inkMuted }} className="text-sm text-center py-8">No players yet.</div>
      ) : (
        <div className="space-y-1">
          {roster.map((p, i) => (
            <div
              key={p.id}
              style={{ borderColor: styles.line, background: p.id === currentUserId ? styles.surface : styles.bg }}
              className="border rounded-md px-3 py-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkSubtle, width: 18 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 600, color: styles.ink }} className="flex items-center gap-2 flex-wrap">
                      <span>{p.name}</span>
                      {p.id === currentUserId && <span style={{ color: styles.inkMuted, fontSize: 11, fontWeight: 400 }}>· you</span>}
                      {p.isOrganiser && <Tag>organiser</Tag>}
                      {!p.claimed && <Tag muted>unclaimed</Tag>}
                    </div>
                  </div>
                </div>
                <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: p.points > 0 ? styles.ink : (p.points < 0 ? styles.warn : styles.inkSubtle), fontWeight: 500 }}>
                  {p.points >= 0 ? '+' : ''}{p.points}
                </span>
              </div>
              {(isOrganiser || p.id === currentUserId) && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  <SmallButton onClick={() => onRename(p.id)}>{p.id === currentUserId ? 'Rename me' : 'Rename'}</SmallButton>
                  {isOrganiser && (
                    <>
                      <SmallButton onClick={() => onToggleOrganiser(p.id)}>{p.isOrganiser ? 'Remove organiser' : 'Make organiser'}</SmallButton>
                      {p.claimed && <SmallButton onClick={() => onResetPin(p.id)}>Reset PIN</SmallButton>}
                      <SmallButton onClick={() => onRemove(p.id)} warn>Remove</SmallButton>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {isOrganiser && (
        <div style={{ borderColor: styles.line }} className="mt-10 pt-6 border-t">
          <SectionLabel>Reset & cleanup</SectionLabel>
          <div className="space-y-3">
            <div>
              <SmallButton onClick={onResetPoints}>Reset points</SmallButton>
              <p style={{ color: styles.inkMuted, fontSize: 11 }} className="mt-1.5 leading-relaxed">All players go back to 0. History and the active week are kept. Useful for an even start.</p>
            </div>
            <div>
              <SmallButton onClick={onStartFresh}>Start fresh</SmallButton>
              <p style={{ color: styles.inkMuted, fontSize: 11 }} className="mt-1.5 leading-relaxed">Clears history, zeros points, restarts week numbering. Players, PINs and settings stay. Use this after testing or for a new season.</p>
            </div>
            <div>
              <SmallButton onClick={onReset} warn>Reset everything</SmallButton>
              <p style={{ color: styles.inkMuted, fontSize: 11 }} className="mt-1.5 leading-relaxed">Wipes the lot — players, PINs, history, settings. Cannot be undone.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SmallButton({ children, onClick, warn }) {
  return (
    <button
      onClick={onClick}
      style={{ borderColor: styles.line, color: warn ? styles.warn : styles.inkMuted, background: styles.bg }}
      className="border rounded-md px-2.5 py-1 text-xs hover:border-zinc-400 transition-colors"
    >
      {children}
    </button>
  );
}

function AuditView({ audit, players, currentWeekNumber }) {
  // Group entries by week number. Entries with no week (rare) go in a "general" bucket.
  const groups = useMemo(() => {
    const m = new Map();
    audit.forEach(e => {
      const k = e.week == null ? '__general' : e.week;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    });
    // Sort each group ascending by ts (chronological story within a week)
    m.forEach(arr => arr.sort((a, b) => a.ts - b.ts));
    // Convert to array, sort week groups: current week first, then descending by week number
    const arr = Array.from(m.entries()).map(([week, entries]) => ({ week, entries }));
    arr.sort((a, b) => {
      if (a.week === '__general') return 1;
      if (b.week === '__general') return -1;
      return b.week - a.week;
    });
    return arr;
  }, [audit]);

  const [expanded, setExpanded] = useState(() => new Set(currentWeekNumber != null ? [currentWeekNumber] : []));

  function toggle(week) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(week)) next.delete(week); else next.add(week);
      return next;
    });
  }

  if (audit.length === 0) {
    return (
      <div style={{ color: styles.inkMuted }} className="text-sm py-8">
        <p className="text-center mb-1">No audit entries yet.</p>
        <p className="text-center text-xs leading-relaxed max-w-xs mx-auto">Activity is logged from the moment this version was installed — open a week, sign up, run an allocation, and entries will appear here.</p>
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: styles.inkMuted }} className="text-xs mb-4 leading-relaxed">
        Every action that affects a week — signups, drop-outs, allocations, edits — is logged here with who did it and when. Visible to everyone in the group for transparency.
      </p>

      <div className="space-y-3">
        {groups.map(({ week, entries }) => {
          const isCurrent = week !== '__general' && week === currentWeekNumber;
          const isOpen = expanded.has(week);
          const label = week === '__general' ? 'General activity' : `Week ${week}`;
          return (
            <div key={week} style={{ borderColor: styles.line }} className="border rounded-md overflow-hidden">
              <button
                onClick={() => toggle(week)}
                style={{ background: styles.surface, color: styles.ink }}
                className="w-full px-3 py-2.5 flex items-center justify-between text-left hover:bg-zinc-100 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkSubtle }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
                  {isCurrent && (
                    <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: styles.inkMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      · current
                    </span>
                  )}
                </div>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: styles.inkSubtle }}>
                  {entries.length} {entries.length === 1 ? 'event' : 'events'}
                </span>
              </button>

              {isOpen && (
                <div style={{ background: styles.bg }} className="divide-y" data-divide>
                  {entries.map(e => (
                    <AuditRow key={e.id} entry={e} players={players} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AuditRow({ entry, players }) {
  const text = formatAuditEntry(entry, players);
  return (
    <div style={{ borderColor: styles.line }} className="px-3 py-2.5 flex items-start gap-3">
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: styles.inkSubtle, minWidth: 80, paddingTop: 1 }}>
        {fmtAuditTime(entry.ts)}
      </div>
      <div style={{ fontSize: 13, color: styles.ink, lineHeight: 1.45 }} className="flex-1">
        {text}
      </div>
    </div>
  );
}

function fmtAuditTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function HistoryView({ history, players }) {
  if (history.length === 0) {
    return <div style={{ color: styles.inkMuted }} className="text-sm text-center py-8">No completed weeks yet.</div>;
  }
  return (
    <div className="space-y-3">
      {history.map(week => {
        const starters = Object.entries(week.signups).filter(([, info]) => info.slot === 'starter');
        const reserves = Object.entries(week.signups).filter(([, info]) => info.slot === 'reserve');
        const cancelled = Object.entries(week.signups).filter(([, info]) => info.slot === 'cancelled');
        return (
          <div key={week.number} style={{ borderColor: styles.line }} className="border rounded-lg p-5">
            <div className="flex justify-between items-baseline mb-3">
              <div style={{ fontWeight: 700, fontSize: 18, color: styles.inkStrong, letterSpacing: '-0.01em' }}>Week {week.number}</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: styles.inkSubtle, letterSpacing: '0.1em' }} className="uppercase">
                {new Date(week.completedAt).toLocaleDateString()}
              </div>
            </div>
            <div className="space-y-3">
              {starters.length > 0 && <HistoryGroup label="Starters" entries={starters} players={players} />}
              {reserves.length > 0 && <HistoryGroup label="Reserves" entries={reserves} players={players} />}
              {cancelled.length > 0 && <HistoryGroup label="Dropped out" entries={cancelled} players={players} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryGroup({ label, entries, players }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="space-y-0.5">
        {entries.map(([id, info]) => {
          const p = players.find(pp => pp.id === id);
          if (!p) return null;
          const outcomeMap = {
            played: ['Played', styles.ink],
            cancelled_early: ['Cancelled early', styles.inkMuted],
            cancelled_late: ['Late cancel', styles.warn],
            no_show: ['No-show', styles.warn],
            no_play: ['Bumped', styles.inkMuted],
          };
          const [otext, ocolor] = outcomeMap[info.outcome] || ['—', styles.inkMuted];
          return (
            <div key={id} className="flex justify-between items-center py-1 text-sm">
              <span style={{ color: styles.ink }} className="flex items-center gap-2">
                <span>{p.name}</span>
                {info.promoted && <Tag>promoted</Tag>}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: ocolor, letterSpacing: '0.05em' }} className="uppercase">
                {otext}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Modal({ children, onClose, title, wide }) {
  return (
    <div onClick={onClose} style={{ background: 'rgba(10, 10, 10, 0.4)' }} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: styles.bg, borderColor: styles.line, fontFamily: FONT_SANS }}
        className={`border rounded-lg p-5 w-full ${wide ? 'max-w-lg' : 'max-w-sm'} max-h-[85vh] overflow-y-auto`}
      >
        <div className="flex justify-between items-center mb-4">
          <div style={{ fontWeight: 700, fontSize: 17, color: styles.inkStrong, letterSpacing: '-0.01em' }}>{title}</div>
          <button onClick={onClose} style={{ color: styles.inkMuted }} className="text-2xl leading-none hover:text-zinc-900">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Dialog({ type, title, body, confirmLabel, danger, onResolve }) {
  return (
    <div
      onClick={() => onResolve(false)}
      style={{ background: 'rgba(10, 10, 10, 0.55)', fontFamily: FONT_SANS }}
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4"
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: styles.bg, borderColor: styles.line }}
        className="border rounded-lg p-5 w-full max-w-sm"
      >
        <div style={{ fontWeight: 700, fontSize: 17, color: styles.inkStrong, letterSpacing: '-0.01em' }} className="mb-2">
          {title}
        </div>
        {body && (
          <p style={{ color: styles.inkMuted }} className="text-sm leading-relaxed mb-5">
            {body}
          </p>
        )}
        <div className="flex gap-2">
          {type === 'confirm' && (
            <button
              onClick={() => onResolve(false)}
              style={{ borderColor: styles.line, color: styles.ink, background: styles.bg }}
              className="flex-1 border rounded-md py-2.5 text-sm hover:bg-zinc-50 transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() => onResolve(true)}
            style={{ background: danger ? styles.warn : styles.ink, color: 'white' }}
            className="flex-1 rounded-md py-2.5 text-sm font-medium"
          >
            {type === 'alert' ? 'OK' : (confirmLabel || 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
