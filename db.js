/* HIPCO Deals — data layer.
   The screens call a small API (collection().onSnapshot, doc().get/set/update/delete) and never touch the network directly.
   Backend: one Supabase table `kv` (col, id, data jsonb) protected by real logins and row-level security,
   plus a private storage bucket for attachments. Works offline: last data is kept on the phone and
   changes made offline are queued and sent when the connection comes back. */
(function () {
  "use strict";
  const CFG = window.HIPCO_CONFIG || {};
  const BUCKET = CFG.bucket || "deal-files";
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const timeout = (p, ms = 12000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("The connection is slow. Try again."), {code: "unavailable"})), ms))]);
  const isNetwork = e => !navigator.onLine || (e && (e.code === "unavailable" || /fetch|network|timeout|Load failed/i.test(e.message || "")));
  const mapErr = e => {
    if (!e) return e;
    if (e.code === "42501" || /row-level security|permission/i.test(e.message || "")) return Object.assign(new Error("You can view this app but not change it."), {code: "invalid_argument"});
    return e;
  };

  let sb = null, role = LS.get("hipco-role", null), email = LS.get("hipco-email", null);
  function client() {
    if (!sb) sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {auth: {persistSession: true, autoRefreshToken: true, storageKey: "hipco-deals-auth"}});
    return sb;
  }

  /* ---------------------------------------------------------------- live store with offline cache */
  function makeStore() {
    const s = client();
    const cache = {}, listeners = {}, docListeners = {}, subscribed = new Set();
    let outbox = LS.get("hipco-outbox", []), channel = null, flushing = false;
    const statusCbs = new Set();
    const status = () => ({pending: outbox.length, online: navigator.onLine});
    const tellStatus = () => statusCbs.forEach(cb => cb(status()));

    const col = c => { if (!cache[c]) cache[c] = new Map(Object.entries(LS.get("hipco-cache-" + c, {}))); return cache[c]; };
    const persist = c => LS.set("hipco-cache-" + c, Object.fromEntries(col(c)));
    const snap = (id, data) => ({id, exists: data !== undefined, data: () => data, metadata: {fromCache: false, hasPendingWrites: false}});
    function emit(c) {
      const m = col(c), docs = [...m.entries()].map(([id, data]) => snap(id, data));
      (listeners[c] || new Set()).forEach(cb => { try { cb({docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {fromCache: false, hasPendingWrites: outbox.length > 0}}); } catch (e) { console.error(e); } });
      Object.entries(docListeners).forEach(([key, set]) => { const [cc, id] = key.split("/"); if (cc === c) set.forEach(cb => { try { cb(snap(id, m.get(id))); } catch (e) { console.error(e); } }); });
    }
    async function refresh(c) {
      const {data, error} = await timeout(s.from("kv").select("id,data").eq("col", c));
      if (error) throw error;
      const m = new Map(data.map(r => [r.id, r.data]));
      outbox.filter(op => op.col === c).forEach(op => applyLocal(m, op));   // keep offline edits visible
      cache[c] = m; persist(c); emit(c);
    }
    function realtime() {
      if (channel) return;
      channel = s.channel("kv-live").on("postgres_changes", {event: "*", schema: "public", table: "kv"}, p => {
        const row = p.eventType === "DELETE" ? p.old : p.new; if (!row || !subscribed.has(row.col)) return;
        const m = col(row.col);
        if (p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, row.data);
        persist(row.col); emit(row.col);
      }).subscribe();
    }
    function watch(c) {
      if (subscribed.has(c)) { emit(c); return; }
      subscribed.add(c); emit(c);
      refresh(c).catch(e => console.warn("refresh", c, e));
      realtime();
    }
    function applyLocal(m, op) {
      if (op.t === "set") m.set(op.id, op.data);
      else if (op.t === "merge") { const cur = m.get(op.id); if (cur) m.set(op.id, {...cur, ...op.data}); }
      else if (op.t === "del") m.delete(op.id);
    }
    async function exec(op) {
      let r;
      if (op.t === "set") r = await timeout(s.from("kv").upsert({col: op.col, id: op.id, data: op.data}));
      else if (op.t === "merge") {
        r = await timeout(s.rpc("kv_merge", {p_col: op.col, p_id: op.id, p_patch: op.data}));
        if (!r.error && r.data === false) throw Object.assign(new Error("This record no longer exists."), {code: "invalid_argument"});
      }
      else if (op.t === "del") r = await timeout(s.from("kv").delete().eq("col", op.col).eq("id", op.id));
      if (r && r.error) throw mapErr(r.error);
    }
    async function flush() {
      if (flushing || !outbox.length) return; flushing = true;
      try {
        while (outbox.length) {
          try { await exec(outbox[0]); outbox.shift(); LS.set("hipco-outbox", outbox); tellStatus(); }
          catch (e) { if (isNetwork(e)) break; console.warn("dropped change", outbox[0], e); outbox.shift(); LS.set("hipco-outbox", outbox); tellStatus(); }
        }
      } finally { flushing = false; }
    }
    async function write(op) {
      const m = col(op.col);
      if (op.t === "merge" && !m.has(op.id)) throw Object.assign(new Error("This record no longer exists."), {code: "invalid_argument"});
      const before = m.has(op.id) ? m.get(op.id) : undefined;
      applyLocal(m, op); persist(op.col); emit(op.col);
      if (outbox.length) { outbox.push(op); LS.set("hipco-outbox", outbox); tellStatus(); flush(); return; }
      try { await exec(op); }
      catch (e) {
        if (isNetwork(e)) { outbox.push(op); LS.set("hipco-outbox", outbox); tellStatus(); return; }   // saved on the phone, sent later
        if (before === undefined) m.delete(op.id); else m.set(op.id, before);                        // server refused: undo locally
        persist(op.col); emit(op.col); throw mapErr(e);
      }
    }
    const split = path => { const p = path.split("/"); if (p.length !== 2) throw new TypeError("Use collection/id paths"); return p; };
    const db = {
      collection(c) {
        return {
          path: c,
          onSnapshot(cb) { (listeners[c] = listeners[c] || new Set()).add(cb); watch(c); return () => listeners[c].delete(cb); },
          doc(id) { return db.doc(`${c}/${id}`); },
          async get() { await refresh(c).catch(() => {}); const docs = [...col(c).entries()].map(([id, d]) => snap(id, d)); return {docs, size: docs.length, empty: !docs.length}; }
        };
      },
      doc(path) {
        const [c, id] = split(path);
        return {
          id, path,
          async get() { if (!subscribed.has(c)) await refresh(c).catch(() => {}); return snap(id, col(c).get(id)); },
          onSnapshot(cb) { const k = `${c}/${id}`; (docListeners[k] = docListeners[k] || new Set()).add(cb); watch(c); return () => docListeners[k].delete(cb); },
          set: data => write({t: "set", col: c, id, data: JSON.parse(JSON.stringify(data))}),
          update: data => write({t: "merge", col: c, id, data: JSON.parse(JSON.stringify(data))}),
          delete: () => write({t: "del", col: c, id})
        };
      }
    };
    window.addEventListener("online", () => { tellStatus(); flush(); subscribed.forEach(c => refresh(c).catch(() => {})); });
    window.addEventListener("offline", tellStatus);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { flush(); subscribed.forEach(c => refresh(c).catch(() => {})); } });
    setInterval(() => { if (document.visibilityState === "visible") { flush(); subscribed.forEach(c => refresh(c).catch(() => {})); } }, 60000);
    flush();
    return {db, status, onStatus: cb => { statusCbs.add(cb); cb(status()); return () => statusCbs.delete(cb); }};
  }

  /* ---------------------------------------------------------------- files (private bucket, signed links) */
  function makeFiles() {
    const s = client(), urls = new Map();
    const files = {
      url: id => { const u = urls.get(id); return u && u.exp > Date.now() ? u.url : ""; },
      async sign(ids) {
        const need = [...new Set(ids)].filter(id => !files.url(id)); if (!need.length) return;
        try {
          const {data, error} = await timeout(s.storage.from(BUCKET).createSignedUrls(need, 6 * 3600));
          if (error) throw error;
          (data || []).forEach(r => { if (r.signedUrl && r.path) urls.set(r.path, {url: r.signedUrl, exp: Date.now() + 5.5 * 3600 * 1000}); });
        } catch (e) { console.warn("sign", e); }
      },
      async download(id) {
        const {data, error} = await timeout(s.storage.from(BUCKET).download(id), 60000);
        if (error) throw error; return data;
      }
    };
    const assets = {
      async upload(blob, opts = {}) {
        const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, "").slice(0, 32);
        const {error} = await timeout(s.storage.from(BUCKET).upload(id, blob, {contentType: opts.type || blob.type, upsert: false}), 120000);
        if (error) { const e = mapErr(error); if (/size|large/i.test(error.message || "")) e.code = "too_large"; throw e; }
        return {id, url: "", sizeBytes: blob.size, contentType: opts.type || blob.type};
      },
      async delete(id) { const {error} = await timeout(s.storage.from(BUCKET).remove([id])); if (error) throw mapErr(error); return {deleted: true}; }
    };
    return {files, assets};
  }

  const downloads = {
    async save({filename, data}) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener"; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 8000);
      return {status: "saved"};
    }
  };

  /* ---------------------------------------------------------------- public API */
  window.HIPCO = {
    configured: !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase),
    async session() {
      const {data} = await client().auth.getSession();
      return data && data.session ? {email: data.session.user.email, id: data.session.user.id} : null;
    },
    async signIn(mail, password) {
      const {data, error} = await timeout(client().auth.signInWithPassword({email: mail.trim(), password}));
      if (error) throw Object.assign(new Error(/invalid/i.test(error.message) ? "Wrong email or password." : error.message), {code: "auth"});
      return {email: data.user.email, id: data.user.id};
    },
    async signOut() {
      try { await client().auth.signOut(); } catch (e) {}
      ["hipco-role", "hipco-email", "hipco-outbox"].forEach(LS.del);
      Object.keys(localStorage).filter(k => k.startsWith("hipco-cache-")).forEach(LS.del);
    },
    async role(user) {
      try {
        const {data, error} = await timeout(client().from("members").select("role").eq("user_id", user.id).maybeSingle(), 8000);
        if (error) throw error;
        role = data ? data.role : "none"; email = user.email; LS.set("hipco-role", role); LS.set("hipco-email", email);
      } catch (e) { if (!role) throw e; }   // offline: keep the role saved on this phone
      return role;
    },
    push: {   // this phone's notification address, so the server can send it alerts
      async save(sub) {
        const {error} = await timeout(client().from("push_subs").upsert({endpoint: sub.endpoint, sub}));
        if (error) throw error;
      },
      async remove(endpoint) { await timeout(client().from("push_subs").delete().eq("endpoint", endpoint)); }
    },
    connect() {
      const store = makeStore(), {files, assets} = makeFiles();
      return {db: store.db, files, assets: role === "editor" ? assets : null, downloads, onStatus: store.onStatus,
        user: {canEdit: async () => role === "editor", email: () => email}};
    }
  };
})();
