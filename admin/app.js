(function () {
  "use strict";
  var cfg = window.CREEK_OFFICE_CONFIG || {};
  var els = {};
  var db = null;
  var localDevelopment = false, backendOrigin = null;
  var membership = null, care = null, officeContent = null, signups = null, intakeTasks = null, communications = null, weeklyEmail = null, attention = null, week = null, followups = null, reminderCalendar = null;
  var session = null;
  var role = null;
  var authEpoch = 0, loadEpoch = 0, documentEpoch = 0, editorEpoch = 0;
  var MAX_FILE_BYTES = 52428800;
  var AUTH_STORAGE_KEY = "creek-office-auth", signedOut = false, manualSignInPending = false;
  var documentExpiryTimer;
  var peopleReady = false, workspaceReady = false, readinessOK = false, refreshing = false;
  var draft = null, readinessEpoch = 0;
  var REQUIRED_REVISION = "20260907174301";
  var state = { events: [], people: [], documents: [], activity: [] };
  var titles = { dashboard: "Overview", week: "This week", followups: "My follow-ups", calendar: "Staff calendar", announcements: "Announcements", committees: "Committee contacts", slides: "Sunday slides", prayers: "Prayer requests", people: "People & membership", history: "Member history", care: "Guests & care", signups: "Guest register", intake: "Intake actions", communications: "Communications", "weekly-email": "Weekly email", attention: "Needs attention", documents: "Documents", activity: "Activity" };
  var contentViews = ["announcements", "committees", "slides", "prayers"];
  var privateViews = ["week", "history", "care", "signups", "intake", "communications", "weekly-email", "attention", "followups"].concat(contentViews);

  function deadline(request) {
    var timer;
    return Promise.race([Promise.resolve(request), new Promise(function (_resolve, reject) { timer = window.setTimeout(function () { reject(Object.assign(new Error("The request timed out."), {code:"OFFICE_TIMEOUT"})); }, 12000); })]).finally(function () { window.clearTimeout(timer); });
  }
  function draftWrite(item, epoch, request, phase) {
    var deadlineFinished = false;
    item.unresolvedWrites = (item.unresolvedWrites || 0) + 1; item.writeRevision = (item.writeRevision || 0) + 1;
    function settled() {
      if (!current(epoch) || draft !== item) return;
      item.unresolvedWrites--; item.writeRevision++;
      // A deadline ends our wait, not the underlying request. A late settlement
      // only asks for a fresh read; it never continues the abandoned save pipeline.
      if (deadlineFinished) {
        item.requiresRefresh = true; item.settlementNeedsRead = true;
        if (phase === "upload" && !item.uploadVerified) item.uploadUncertain = true;
        el("editor-error").textContent = "A previous save request settled. Refresh workspace again to check the saved record before continuing.";
        syncEditor();
      }
    }
    var tracked = Promise.resolve(request).then(function (value) { settled(); return value; }, function (error) { settled(); throw error; });
    return deadline(tracked).finally(function () { deadlineFinished = true; });
  }
  function hidden(node, value) { if (node) { node.hidden = value; node.classList.toggle("hidden", value); } }
  function loopback(address) { return ["http:", "https:"].includes(address.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(address.hostname) && !!address.port && !address.username && !address.password; }
  function documentUrl(value) {
    var address = new URL(value);
    if (address.username || address.password || (address.protocol !== "https:" && !(localDevelopment && address.protocol === "http:" && address.origin === backendOrigin))) throw new Error("The document link could not be opened securely.");
    return address;
  }
  function el(id) { return document.getElementById(id); }
  function show(id) { ["setup", "login", "loading", "workspace"].forEach(function (name) { el(name).classList.toggle("hidden", name !== id); }); }
  function safe(value) { var node = document.createElement("span"); node.textContent = value == null ? "" : String(value); return node.innerHTML.replace(/"/g, "&quot;"); }
  function dateLabel(value) { if (!value) return ""; return new Date(value + (value.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  function notice(message, bad) { els.notice.textContent = message; els.notice.classList.remove("hidden"); els.notice.style.borderColor = bad ? "#9b3f2c" : "#3C5A45"; window.clearTimeout(notice.timer); notice.timer = window.setTimeout(function () { els.notice.classList.add("hidden"); }, 4500); }
  function fail(error) { notice(error.message || "The request could not be confirmed. Refresh before trying again.", true); }
  function hasEditRole() { return role === "admin" || role === "editor"; }
  function canEdit() { return workspaceReady && readinessOK && hasEditRole(); }
  function syncMembershipSheet() {
    var link = el("people-sheet-link"), box = el("people-sheet-tools");
    if (!link || !box) return;
    var target = session && canEdit() && window.CreekMembership && window.CreekMembership.sheetLink ? window.CreekMembership.sheetLink(cfg.membershipSheetUrl) : null;
    hidden(box, !target);
    if (target) link.href = target; else link.removeAttribute("href");
  }
  function current(epoch) { return epoch === authEpoch && !!session && !!role; }
  function requireCurrent(epoch) { if (!current(epoch)) throw new Error("Your session changed. Sign in again before saving."); }
  function editorSnapshot() { return Array.from(el("editor-fields").querySelectorAll("input,select,textarea")).map(function (node) { return [node.name, node.type === "file" ? Array.from(node.files || []).map(function (file) { return [file.name, file.type, file.size, file.lastModified]; }) : node.type === "checkbox" ? node.checked : node.value]; }).map(function (value) { return JSON.stringify(value); }).join("|"); }
  function editorNeedsWarning() { return !!draft && (draft.busy || draft.unresolvedWrites || draft.settlementNeedsRead || draft.requiresRefresh || draft.conflict || editorSnapshot() !== draft.initial); }
  function warnEditorUnload(event) { if (editorNeedsWarning()) { event.preventDefault(); event.returnValue = true; } }
  function syncEditorUnload() { window[editorNeedsWarning() ? "addEventListener" : "removeEventListener"]("beforeunload", warnEditorUnload); }
  function clearEditor(force) {
    var closing = draft, version = editorEpoch;
    if (draft && (draft.busy || draft.unresolvedWrites || draft.settlementNeedsRead) && force !== true) return false;
    if (draft && force !== true && (draft.requiresRefresh || draft.conflict || editorSnapshot() !== draft.initial) && !window.confirm("Close this draft and discard unsaved changes? If a save was uncertain, refresh and check the saved records before adding it again.")) return false;
    if (force !== true && (draft !== closing || editorEpoch !== version || (draft && (draft.busy || draft.unresolvedWrites || draft.settlementNeedsRead)))) return false;
    draft = null; editorEpoch++; syncEditorUnload();
    if (el("editor").open) el("editor").close();
    el("editor-fields").replaceChildren(); el("editor-form").reset();
    el("editor-form").dataset.id = ""; el("editor-form").dataset.kind = "";
    if (el("event-delete")) el("event-delete").hidden = true; if (el("editor-refresh")) el("editor-refresh").hidden = true;
    el("editor-title").textContent = ""; el("editor-kicker").textContent = ""; el("editor-error").textContent = ""; el("save").disabled = false; return true;
  }
  function clearPrivate() {
    window.clearTimeout(documentExpiryTimer);
    if (membership) membership.clear(); if (care) care.clear();
    if (officeContent) officeContent.clear(); if (signups) signups.clear(); if (intakeTasks) intakeTasks.clear(); if (communications) communications.clear(); if (weeklyEmail) weeklyEmail.clear(); if (attention) attention.clear(); if (week) week.clear();
    if (followups) followups.clear(); if (reminderCalendar) reminderCalendar.clear();
    el("dashboard-followup-list").replaceChildren(); el("dashboard-followup-status").textContent = ""; el("followup-badge").textContent = ""; el("followup-badge").removeAttribute("aria-label");
    loadEpoch++; documentEpoch++; peopleReady = false; state = { events: [], people: [], documents: [], activity: [] };
    workspaceReady = false; readinessOK = false; refreshing = false; readinessEpoch++;
    syncMembershipSheet(); renderCareSummary(null); renderIntakeSummary(null);
    clearEditor(true); if (el("document-dialog").open) el("document-dialog").close(); el("document-result").replaceChildren();
    ["dashboard-events", "events-list", "people-list", "documents-list", "activity-list", "user-label", "role-label"].forEach(function (id) { el(id).replaceChildren(); });
    ["event-count", "people-count", "document-count", "signup-count"].forEach(function (id) { el(id).textContent = "—"; });
    ["event-search", "people-search", "document-search", "event-filter", "people-filter", "document-filter", "email", "password"].forEach(function (id) { el(id).value = ""; });
    window.clearTimeout(notice.timer); els.notice.textContent = ""; els.notice.classList.add("hidden");
    if (el("event-status-filter")) el("event-status-filter").value = "active";
    document.querySelector("aside").classList.remove("open"); el("menu").setAttribute("aria-expanded", "false");
  }
  // Keep database work outside the auth callback's lock. Invalidate immediately
  // so a pending response cannot restore the previous account's private data.
  function queueSession(next) {
    // Supabase saves a successful password session before emitting SIGNED_IN.
    // During an explicit sign-in, defer storage cleanup until its result is
    // known. Auth notifications still cannot unlock a signed-out workspace.
    if (next && signedOut) { if (!manualSignInPending) clearAuthStorage(); return; }
    if (next && session && next.user.id === session.user.id && role) {
      session = next; el("user-label").textContent = next.user.email;
      window.setTimeout(function () { if (session === next) loadAll(authEpoch); }, 0); return;
    }
    var epoch = ++authEpoch; session = next; role = null; clearPrivate();
    el("login-error").textContent = ""; show(next ? "loading" : "login");
    if (next) window.setTimeout(function () { useSession(next, epoch).catch(function (error) { if (epoch === authEpoch) { queueSession(null); el("login-error").textContent = error.message || "Could not load the workspace. Please sign in again."; } }); }, 0);
  }

  async function start() {
    els.notice = el("notice");
    if (typeof cfg.supabaseUrl !== "string" || typeof cfg.publishableKey !== "string" || !cfg.supabaseUrl || !cfg.publishableKey || cfg.supabaseUrl.indexOf("YOUR_PROJECT") !== -1) { show("setup"); return; }
    var validUrl = false, validKey = cfg.publishableKey.trim() === cfg.publishableKey && /^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.publishableKey);
    try {
      var endpoint = new URL(cfg.supabaseUrl), page = new URL(window.location.href);
      localDevelopment = cfg.localDevelopment === true && loopback(endpoint) && loopback(page);
      validUrl = !endpoint.username && !endpoint.password && endpoint.pathname === "/" && !endpoint.search && !endpoint.hash
        && !page.username && !page.password && ["/admin/", "/admin/index.html"].includes(page.pathname)
        && (localDevelopment || (page.protocol === "https:" && endpoint.protocol === "https:" && !endpoint.port && /^[a-z0-9-]+\.supabase\.co$/.test(endpoint.hostname)));
      if (cfg.localDevelopment === true && !localDevelopment) validUrl = false;
      // Legacy anon tokens are only supported by the explicit loopback rehearsal.
      if (!validKey && localDevelopment && cfg.publishableKey.split(".").length === 3) {
        try { var encoded = cfg.publishableKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); validKey = JSON.parse(atob(encoded)).role === "anon"; } catch (_) { validKey = false; }
      }
      if (validUrl) backendOrigin = endpoint.origin;
    } catch (_) {}
    if (!validKey || !validUrl) { show("setup"); el("setup").querySelector("p:last-child").textContent = "Use the church project's HTTPS URL and public publishable key. Secret and service-role keys must never be placed in a browser configuration."; return; }
    if (!window.supabase || !window.supabase.createClient) { show("setup"); el("setup").querySelector("p:last-child").textContent = "The secure client could not load. Check the network connection and pinned client file."; return; }
    db = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: { storage: window.sessionStorage, storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    bind();
    var moduleOptions = { db: db, getContext: function () { return { epoch: authEpoch, userId: session && session.user.id, role: role, canEdit: canEdit(), workspaceReady: workspaceReady }; }, isCurrent: current, ensureReady: ensureReady, refresh: function () { return loadAll(authEpoch); }, notice: notice, people: function () { return state.people; }, peopleReady: function () { return peopleReady; }, documents: function () { return state.documents; } };
    if (window.CreekMembership && el("history-view")) membership = window.CreekMembership.create(Object.assign({}, moduleOptions, { root: el("history-view"), sheetUrl: cfg.membershipSheetUrl || "", documentUrl: documentUrl }));
    if (window.CreekCare && el("care-view")) care = window.CreekCare.create(Object.assign({}, moduleOptions, { root: el("care-view"), onSummary: renderCareSummary }));
    if (window.CreekOfficeContent) officeContent = window.CreekOfficeContent.create(Object.assign({}, moduleOptions, {
      roots: { announcements: el("announcements-view"), committees: el("committees-view"), slides: el("slides-view"), prayers: el("prayers-view") },
      openDocument: openDocument,
      uploadDocument: function () { location.hash = "documents"; openUpload("ministry"); }
    }));
    if (window.CreekSignups && el("signups-view")) signups = window.CreekSignups.create(Object.assign({}, moduleOptions, {
      root: el("signups-view"), onCount: function (count) { el("signup-count").textContent = count === null ? "—" : String(count); },
      intakeTask: function(id) { return intakeTasks ? intakeTasks.taskForSource("guest_followup",id) : null; },
      openIntakeTask: function(id) { if(!canEdit()||!intakeTasks)return;var task=intakeTasks.taskForSource("guest_followup",id);if(!task)return;location.hash="intake";route();intakeTasks.openTask(task.id); }
    }));
    if (window.CreekIntakeTasks && el("intake-view")) intakeTasks = window.CreekIntakeTasks.create(Object.assign({}, moduleOptions, {
      root: el("intake-view"), onSummary: renderIntakeSummary,
      sourceLabel: function(kind,id) { return kind === "guest_followup" && signups ? signups.labelFor(id) : kind === "prayer_care" && officeContent ? officeContent.labelFor("prayers",id) : ""; },
      openSource: function(kind,id) {
        if (!canEdit()) return;
        if (kind === "guest_followup" && signups) { location.hash="signups"; route(); signups.open(id); }
        if (kind === "prayer_care" && officeContent) { location.hash="prayers"; route(); officeContent.openRecord("prayers",id); }
      }
    }));
    document.querySelectorAll("button[data-intake-filter]").forEach(function(button){button.onclick=function(){if(!canEdit() || button.disabled || !intakeTasks)return;location.hash="intake";route();intakeTasks.showFilter(button.dataset.intakeFilter);};});
    if (window.CreekCommunications && el("communications-view")) communications = window.CreekCommunications.create(Object.assign({}, moduleOptions, { root: el("communications-view") }));
    if (window.CreekWeeklyEmail && el("weekly-email-view")) weeklyEmail = window.CreekWeeklyEmail.create(Object.assign({}, moduleOptions, { root: el("weekly-email-view") }));
    if (window.CreekFollowups) followups = window.CreekFollowups.create(Object.assign({}, moduleOptions, { root: el("followups-module"), onSummary: renderFollowupSummary }));
    if (window.CreekAttention && el("attention-view")) attention = window.CreekAttention.create(Object.assign({}, moduleOptions, {
      root:el("attention-view"), onSummary:renderAttentionSummary,
      getSources:function(date){return {care:care&&care.attentionSnapshot?care.attentionSnapshot(date):null,leaders:followups&&followups.attentionSnapshot?followups.attentionSnapshot(date):null};},
      openSource:function(item,date){
        if(!canEdit())return false;
        if(item.source_type==="intake"&&intakeTasks&&intakeTasks.openTask(item.source_id)===true){location.hash="intake";route();return true;}
        if(item.source_type==="registration"&&signups&&signups.open(item.source_id)===true){location.hash="signups";route();return true;}
        if(["care_plan","care_coverage"].includes(item.source_type)&&care&&care.openFromAttention&&care.openFromAttention(item,date)){location.hash="care";route();return true;}
        if(item.source_type==="leader"&&followups&&followups.openFromAttention&&followups.openFromAttention(item.source_id)){location.hash="followups";route();return true;}
        return false;
      }
    }));
    if (window.CreekWeek && el("week-view")) week = window.CreekWeek.create(Object.assign({}, moduleOptions, {
      root: el("week-view"), getSources: function () {
        var available = !!session && canEdit() && workspaceReady && !refreshing;
        return { content: available && officeContent && officeContent.weekSnapshot ? officeContent.weekSnapshot() : null,
          events: { available: available, items: available ? state.events.filter(function (row) { return !row.is_archived; }).map(function (row) {
            return { id: row.id, title: row.title, starts_at: row.starts_at, ends_at: row.ends_at || null, updated_at: row.updated_at || null };
          }) : [] } };
      }, onOpen: function (view, id) {
        if (!canEdit() || !workspaceReady || refreshing || typeof id !== "string") return false;
        var opened = false;
        if (["announcements", "slides", "committees"].includes(view) && officeContent) opened = officeContent.openRecord(view, id) === true;
        if (view === "calendar") { var item = state.events.find(function (row) { return row.id === id && !row.is_archived; }); if (item) opened = openEvent(item) === true; }
        if (opened) { location.hash = view; route(); }
        return opened;
      }
    }));
    if (window.CreekReminderCalendar) reminderCalendar = window.CreekReminderCalendar.create({ button: el("weekly-reminder"), allowed: function () { return !!session && canEdit(); } });
    // Refresh these queues without replacing unsaved editors elsewhere.
    function refreshPersonalQueues() {
      if (!session || !role || refreshing || (draft && draft.busy) || document.visibilityState !== "visible") return;
      loadAll(authEpoch);
    }
    window.setInterval(refreshPersonalQueues, 60000);
    document.addEventListener("visibilitychange", refreshPersonalQueues);
    db.auth.onAuthStateChange(function (_event, nextSession) { queueSession(nextSession); });
    var initialEpoch = authEpoch, result = await db.auth.getSession();
    if (initialEpoch !== authEpoch) return;
    if (result.error) { queueSession(null); el("login-error").textContent = result.error.message; return; }
    queueSession(result.data.session);
  }

  function bind() {
    els.notice = el("notice");
    el("login-form").addEventListener("submit", login);
    el("logout").addEventListener("click", logout);
    el("menu").addEventListener("click", function () { var open = document.querySelector("aside").classList.toggle("open"); el("menu").setAttribute("aria-expanded", String(open)); if (open) document.querySelector("aside nav a").focus(); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape" && document.querySelector("aside").classList.contains("open")) { document.querySelector("aside").classList.remove("open"); el("menu").setAttribute("aria-expanded", "false"); el("menu").focus(); } });
    window.addEventListener("hashchange", route);
    document.querySelectorAll("aside nav a").forEach(function (link) { link.addEventListener("click", function () { document.querySelector("aside").classList.remove("open"); el("menu").setAttribute("aria-expanded", "false"); }); });
    el("primary-action").addEventListener("click", primaryAction);
    document.querySelectorAll("[data-care-queue]").forEach(function (button) { button.addEventListener("click", function () {
      var queue = button.dataset.careQueue;
      if (button.disabled || !session || !canEdit() || !care || typeof care.openQueue !== "function" || !["due", "unassigned", "coverage"].includes(queue)) return;
      if (care.openQueue(queue)) { location.hash = "care"; route(); }
    }); });
    if (el("people-sheet-link")) el("people-sheet-link").addEventListener("click", function (event) {
      var target = window.CreekMembership && window.CreekMembership.sheetLink ? window.CreekMembership.sheetLink(cfg.membershipSheetUrl) : null;
      if (!session || !canEdit() || !target || event.currentTarget.getAttribute("href") !== target) event.preventDefault();
    });
    document.querySelectorAll("[data-close-editor]").forEach(function (button) { button.addEventListener("click", clearEditor); });
    el("editor").addEventListener("cancel", function (event) { event.preventDefault(); clearEditor(); });
    el("close-document").addEventListener("click", function () { el("document-dialog").close(); });
    el("document-dialog").addEventListener("close", function () { documentEpoch++; window.clearTimeout(documentExpiryTimer); el("document-result").replaceChildren(); });
    ["event-search", "event-filter", "people-search", "people-filter", "document-search", "document-filter"].forEach(function (id) { el(id).addEventListener("input", render); });
    el("editor-form").addEventListener("submit", saveEditor);
    el("editor-fields").addEventListener("input", function (event) {
      if (["first_name", "last_name", "membership_number", "legacy_member_id"].includes(event.target.name)) renderPersonReview();
      syncEditorUnload();
    });
    el("editor-fields").addEventListener("change", syncEditorUnload);
    if (el("workspace-refresh")) el("workspace-refresh").addEventListener("click", function () { loadAll(authEpoch); });
    if (el("editor-refresh")) el("editor-refresh").addEventListener("click", function () { loadAll(authEpoch); });
    if (el("event-delete")) el("event-delete").addEventListener("click", archiveEvent);
    if (el("event-status-filter")) el("event-status-filter").addEventListener("input", render);
  }

  async function login(event) {
    event.preventDefault(); if (el("login-submit").disabled) return; el("login-error").textContent = "";
    el("login-submit").disabled = true;
    manualSignInPending = true;
    try {
    var result = await db.auth.signInWithPassword({ email: el("email").value.trim(), password: el("password").value });
    if (result.error) el("login-error").textContent = result.error.message;
    else if (result.data && result.data.session) { signedOut = false; queueSession(result.data.session); await db.auth.startAutoRefresh(); }
    } catch (error) { el("login-error").textContent = error.message || "Sign-in is unavailable. Please try again."; }
    finally { manualSignInPending = false; if (signedOut) clearAuthStorage(); el("password").value = ""; el("login-submit").disabled = false; }
  }

  function clearAuthStorage() {
    [AUTH_STORAGE_KEY, AUTH_STORAGE_KEY + "-code-verifier", AUTH_STORAGE_KEY + "-user"].forEach(function (key) { try { window.sessionStorage.removeItem(key); } catch (_) {} });
  }
  async function logout() {
    signedOut = true;
    queueSession(null);
    el("login-submit").disabled = true;
    try { await db.auth.stopAutoRefresh(); var result = await db.auth.signOut({ scope: "local" }); if (result.error) throw result.error; }
    catch (error) { el("login-error").textContent = "The server could not confirm sign-out. This tab's saved session and workspace have been cleared."; }
    finally { clearAuthStorage(); el("login-submit").disabled = false; }
  }
  function health(message, setup) {
    var box = el("workspace-health"), text = el("workspace-health-message"), help = el("workspace-setup-help");
    if (box) { box.hidden = !message; box.classList.toggle("hidden", !message); }
    if (text) text.textContent = message || "";
    hidden(help, !setup);
    ["workspace-refresh", "editor-refresh"].forEach(function (id) { if (el(id)) el(id).disabled = refreshing || !!(draft && draft.busy); });
  }
  function freezeOtherDialogs(blocked) {
    document.querySelectorAll("dialog[open]").forEach(function (dialog) {
      if (dialog.id === "editor" || dialog.id === "document-dialog") return;
      dialog.querySelectorAll("input,select,textarea,button[type=submit]").forEach(function (node) {
        if (blocked && !node.hasAttribute("data-office-frozen")) { node.dataset.officeFrozen = String(node.disabled); node.disabled = true; }
        else if (!blocked && node.hasAttribute("data-office-frozen")) { node.disabled = node.dataset.officeFrozen === "true"; delete node.dataset.officeFrozen; }
      });
    });
  }
  function syncEditor() {
    if (!draft) return;
    syncEditorUnload();
    renderPersonReview();
    var frozen = draft.busy || draft.requiresRefresh || draft.conflict || !canEdit();
    el("editor-fields").querySelectorAll("input,select,textarea").forEach(function (node) { node.disabled = frozen || !!draft.unresolvedWrites || (node.type === "file" && !!draft.file); });
    el("editor-fields").querySelectorAll("[data-review-person]").forEach(function (node) { node.disabled = frozen || !!draft.unresolvedWrites; });
    el("save").disabled = frozen;
    document.querySelectorAll("[data-close-editor]").forEach(function (node) { node.disabled = draft.busy || !!draft.unresolvedWrites || !!draft.settlementNeedsRead; });
    if (el("event-delete")) { hidden(el("event-delete"), draft.kind !== "event" || draft.isNew); el("event-delete").textContent = draft.archived ? "Restore event" : "Archive event"; el("event-delete").disabled = frozen || !!draft.unresolvedWrites || !!draft.settlementNeedsRead; }
    if (el("editor-refresh")) { hidden(el("editor-refresh"), !(draft.requiresRefresh || draft.conflict || !workspaceReady)); el("editor-refresh").disabled = refreshing || draft.busy; }
  }
  function blockWorkspace(message, setup) {
    el("workspace").dataset.connection = "blocked";
    workspaceReady = false; peopleReady = false; state = { events: [], people: [], documents: [], activity: [] };
    documentEpoch++; window.clearTimeout(documentExpiryTimer); el("document-result").replaceChildren();
    ["dashboard-events", "events-list", "people-list", "documents-list", "activity-list", "dashboard-followup-list"].forEach(function (id) { el(id).replaceChildren(); });
    ["event-count", "people-count", "document-count", "signup-count"].forEach(function (id) { el(id).textContent = "—"; });
    el("followup-badge").textContent = ""; el("followup-badge").removeAttribute("aria-label"); el("dashboard-followup-status").textContent = "Follow-ups are unavailable until the workspace refreshes.";
    el("primary-action").disabled = true;
    privateViews.forEach(function (name) { var view = el(name + "-view"); if (view) view.classList.add("hidden"); });
    syncMembershipSheet(); renderCareSummary(null); renderIntakeSummary(null); if(attention)attention.clear(); if(week)week.clear(); if(weeklyEmail)weeklyEmail.pause(); renderAttentionSummary(null); freezeOtherDialogs(true); syncEditor(); health(message, setup);
  }
  function connectionDiagnostic(phase,error) {
    var labels={role:"staff access",readiness:"workspace setup",records:"office records"};
    var reason=error&&error.code==="OFFICE_TIMEOUT"?"request timed out":error&&(error.code==="42501"||error.status===403)?"access could not be confirmed":error&&["PGRST202","PGRST204","42P01","42703","42883","OFFICE_SETUP"].includes(error.code)?"setup needs review":"connection unavailable";
    return " Connection check: "+labels[phase]+" · "+reason+".";
  }
  function authFailure(error) { return error && (error.status === 401 || ["PGRST301", "PGRST302", "PGRST303"].includes(error.code)); }
  async function verifyReadiness(epoch) {
    if (epoch !== authEpoch || !session) return false;
    var request = ++readinessEpoch, userId = session.user.id, phase = "role";
    try {
      var staff = await deadline(db.from("staff_roles").select("role").eq("user_id", userId).maybeSingle());
      if (epoch !== authEpoch || request !== readinessEpoch) return false;
      if (staff.error) throw staff.error;
      if (!staff.data || !["admin", "editor", "viewer"].includes(staff.data.role)) {
        queueSession(null); el("login-error").textContent = "This account no longer has approved Creek Office access."; return false;
      }
      if (role && role !== staff.data.role) {
        // A real role change invalidates module drafts and all previously loaded private data.
        clearPrivate(); request = readinessEpoch;
      }
      role = staff.data.role; el("role-label").textContent = role;
      phase="readiness"; var result = await deadline(db.rpc("office_readiness"));
      if (epoch !== authEpoch || request !== readinessEpoch || !session || session.user.id !== userId) return false;
      if (result.error) throw result.error;
      var ready = result.data;
      if (!ready || ready.staff_role !== role || String(ready.schema_revision || "") < REQUIRED_REVISION || !Array.isArray(ready.supported_modules) || (hasEditRole() ? ["events", "contacts", "documents", "activity", "membership", "care", "office_content", "app_signups", "leader_followups"] : ["events", "contacts", "documents", "activity"]).some(function (name) { return !ready.supported_modules.includes(name); })) {
        throw { code: "OFFICE_SETUP" };
      }
      readinessOK = true; return true;
    } catch (error) {
      if (epoch !== authEpoch || request !== readinessEpoch) return false;
      readinessOK = false;
      if (authFailure(error)) { queueSession(null); el("login-error").textContent = "Your session could not be verified. Sign in again."; return false; }
      var setup = ["PGRST202", "PGRST204", "42P01", "42703", "42883", "OFFICE_SETUP"].includes(error.code) || typeof db.rpc !== "function";
      blockWorkspace(setup ? "Office setup is incomplete or out of date. Editing is paused until the required database update is installed. Your open draft stays in this tab." : "The office connection could not be verified. Editing is paused. Refresh to reconnect; your open draft stays in this tab."+connectionDiagnostic(phase,error), setup);
      return false;
    }
  }
  async function ensureReady(epoch) {
    epoch = epoch === undefined ? authEpoch : epoch;
    if (!current(epoch) || !workspaceReady) return false;
    var okay = await verifyReadiness(epoch);
    return okay && current(epoch) && canEdit();
  }
  async function useSession(next, epoch) {
    if (epoch !== authEpoch) return;
    el("user-label").textContent = next.user.email; show("workspace");
    await loadAll(epoch); if (current(epoch)) route();
  }

  async function fetchRecords(table, column, ascending, epoch, request) {
    var all = [], seen = new Set(), total = null;
    for (var offset = 0;;) {
      if (!current(epoch) || request !== loadEpoch) return { error: { code: "STALE_READ" } };
      var query = db.from(table).select("*", { count: "exact" }).order(column, { ascending: ascending }).order("id", { ascending: true });
      var paged = typeof query.range === "function";
      var result = await deadline(paged ? query.range(offset, offset + 999) : query);
      if (!current(epoch) || request !== loadEpoch) return { error: { code: "STALE_READ" } };
      if (result && result.error) return result;
      if (!result || !Array.isArray(result.data) || !Number.isSafeInteger(result.count) || result.count < 0 || (total !== null && result.count !== total)) throw new Error("Incomplete record response");
      total = result.count;
      result.data.forEach(function (row) {
        if (!row || typeof row.id !== "string" || !row.id.trim() || seen.has(row.id)) throw new Error("Incomplete record response");
        seen.add(row.id);
      });
      all = all.concat(result.data);
      if (all.length > total) throw new Error("Incomplete record response");
      if (all.length === total) return { data: all };
      if (!result.data.length || !paged) throw new Error("Incomplete record response");
      offset += result.data.length;
    }
  }
  async function loadAll(epoch) {
    epoch = epoch === undefined ? authEpoch : epoch;
    if (epoch !== authEpoch || !session || refreshing || (draft && draft.busy)) return;
    var request = ++loadEpoch; refreshing = true; if(attention)attention.beginRefresh(); var weekRefresh = week ? week.beginRefresh() : null;
    health("Checking the office connection and refreshing records…", false);
    try {
      if (!await verifyReadiness(epoch)) return;
      request = loadEpoch;
      var readDraft = { item: draft, revision: draft ? draft.writeRevision || 0 : 0 };
      var results = await Promise.all([
        fetchRecords("events", "starts_at", true, epoch, request), fetchRecords("contacts", "last_name", true, epoch, request),
        fetchRecords("documents", "updated_at", false, epoch, request), deadline(db.from("audit_log").select("*").order("created_at", { ascending: false }).limit(100))
      ]);
      if (!current(epoch) || request !== loadEpoch) return;
      var failed = results.find(function (result) { return result.error || !Array.isArray(result.data); });
      if (failed) throw failed.error || new Error("Incomplete record response");
      var invalid = results.slice(0, 3).some(function (result) { return result.data.some(function (row) { return !row.id || !Number.isInteger(row.version) || row.version < 1; }); });
      if (invalid) throw { code: "OFFICE_SETUP" };
      ["events", "people", "documents", "activity"].forEach(function (name, index) { state[name] = results[index].data; });
      workspaceReady = true; peopleReady = true; el("workspace").dataset.connection = "ready";
      if (week) weekRefresh = week.beginRefresh();
      await reconcileDraft(epoch, readDraft);
      if (!current(epoch) || request !== loadEpoch) return;
      freezeOtherDialogs(false);
      if (canEdit()) await Promise.all([membership ? membership.load(epoch) : null, care ? care.load(epoch) : null, officeContent ? officeContent.load(epoch) : null, signups ? signups.load(epoch) : null, intakeTasks ? intakeTasks.load(epoch) : null, communications ? communications.load(epoch) : null, weeklyEmail ? weeklyEmail.load(epoch) : null, followups ? followups.load(epoch) : null]);
      if (!current(epoch) || request !== loadEpoch) return;
      if(canEdit()&&attention)await attention.load(epoch);
      if(!current(epoch)||request!==loadEpoch)return;
      health("", false); route(); syncEditor();
    } catch (error) {
      if (epoch !== authEpoch) return;
      if (authFailure(error)) { queueSession(null); el("login-error").textContent = "Your session could not be verified. Sign in again."; return; }
      var setup = ["OFFICE_SETUP", "42P01", "42703", "PGRST204"].includes(error.code);
      blockWorkspace(setup ? "Office setup is incomplete or out of date. Editing is paused until the required database update is installed." : "Some office records could not be refreshed. Editing is paused and stale lists have been cleared. Your draft is preserved; refresh to try again."+connectionDiagnostic("records",error), setup);
    } finally { if (epoch === authEpoch) { refreshing = false; if(week && request === loadEpoch && workspaceReady && canEdit())week.endRefresh(weekRefresh); syncEditor(); ["workspace-refresh", "editor-refresh"].forEach(function (id) { if (el(id)) el(id).disabled = !!(draft && draft.busy); }); } }
  }

  function route() {
    if (!session || !role) return;
    var view = (location.hash || "#dashboard").slice(1);
    if (!titles[view] || (privateViews.includes(view) && !canEdit())) view = "dashboard";
    document.querySelectorAll("[data-private-module]").forEach(function (node) { node.classList.toggle("hidden", !canEdit()); });
    document.querySelectorAll(".view").forEach(function (node) { node.classList.toggle("hidden", node.id !== view + "-view"); });
    document.querySelectorAll("aside nav a").forEach(function (node) { node.classList.toggle("active", node.dataset.view === view); });
    el("page-title").textContent = titles[view];
    var labels = { calendar: "Add staff event", people: "Add person", documents: "Upload document", announcements: "Add announcement", committees: "Add contact", slides: "Add Sunday slides", prayers: "Add prayer request" };
    el("primary-action").disabled = !canEdit();
    el("primary-action").textContent = labels[view] || "Add";
    el("primary-action").classList.toggle("hidden", !labels[view] || !canEdit());
    render();
  }

  function render() {
    syncMembershipSheet();
    if (!session || !role || !workspaceReady) return;
    var now = new Date();
    var future = state.events.filter(function (item) { return !item.is_archived && new Date(item.ends_at || item.starts_at) >= now; });
    el("event-count").textContent = future.length;
    el("people-count").textContent = state.people.length;
    el("document-count").textContent = state.documents.length;
    el("dashboard-events").innerHTML = future.slice(0, 5).map(eventRow).join("");
    var eventTerm = el("event-search").value.toLowerCase(), eventTag = el("event-filter").value, eventStatus = el("event-status-filter") ? el("event-status-filter").value : "active";
    el("events-list").innerHTML = state.events.filter(function (item) { return (eventStatus === "all" || !!item.is_archived === (eventStatus === "archived")) && (!eventTag || item.tag === eventTag) && (!eventTerm || [item.title, item.location, item.description].join(" ").toLowerCase().includes(eventTerm)); }).map(eventRow).join("");
    var peopleTerm = el("people-search").value.toLowerCase(), peopleStatus = el("people-filter").value;
    el("people-list").innerHTML = state.people.filter(function (item) { return (!peopleStatus || item.status === peopleStatus) && (!peopleTerm || [item.first_name, item.last_name, item.middle_name, item.preferred_name, item.former_names, item.membership_number, item.legacy_member_id, item.household_name, item.email, item.phone].join(" ").toLowerCase().includes(peopleTerm)); }).map(personRow).join("");
    var docTerm = el("document-search").value.toLowerCase(), docCategory = el("document-filter").value;
    el("documents-list").innerHTML = state.documents.filter(function (item) { return (!docCategory || item.category === docCategory) && (!docTerm || [item.title, item.file_name, item.description].join(" ").toLowerCase().includes(docTerm)); }).map(documentRow).join("");
    el("activity-list").innerHTML = state.activity.map(activityRow).join("");
    bindRowActions();
    if (membership) membership.render(); if (care) care.render();
    if (officeContent) officeContent.render(); if (signups) signups.render(); if (intakeTasks) intakeTasks.render(); if (communications) communications.render(); if (weeklyEmail) weeklyEmail.render(); if(attention)attention.render(); if(week)week.render(); if (followups) followups.render();
  }

  function renderAttentionSummary(summary) {
    var node=el("attention-count"),status=el("attention-dashboard-status");if(!node||!status)return;
    var valid=!!session&&canEdit()&&summary&&Number.isSafeInteger(summary.known)&&summary.known>=0&&Number.isSafeInteger(summary.unavailable)&&summary.unavailable>=0&&summary.unavailable<=3&&(summary.count===null&&summary.unavailable>0||Number.isSafeInteger(summary.count)&&summary.count===summary.known&&summary.unavailable===0);
    node.textContent=valid&&summary.count!==null?String(summary.count):"—";
    status.textContent=!valid?"Refresh the Office to check intake, member care and your leader follow-ups.":summary.unavailable?summary.known+" known items; "+summary.unavailable+" source queues unavailable. Open the queue to review the gaps.":summary.count?"Open each source to review its owner, due date or notification issue.":"No attention items in these three queues. Other operating checks remain separate.";
  }
  function renderCareSummary(summary) {
    var status = el("dashboard-care-status");
    if (!status) return;
    var valid = !!session && canEdit() && summary && ["duePlans", "overduePlans", "unassignedPlans", "coverageGaps"].every(function (key) { return Number.isSafeInteger(summary[key]) && summary[key] >= 0; }) && summary.overduePlans <= summary.duePlans;
    [["care-due-count", "duePlans"], ["care-unassigned-count", "unassignedPlans"], ["care-gaps-count", "coverageGaps"]].forEach(function (item) { el(item[0]).textContent = valid ? String(summary[item[1]]) : "—"; });
    document.querySelectorAll("[data-care-queue]").forEach(function (button) { button.disabled = !valid || !care || typeof care.openQueue !== "function"; });
    status.textContent = !session || !canEdit() ? "" : !valid ? "Care counts are unavailable. Open Guests & care to refresh." : "Based on loaded office records · " + summary.overduePlans + " overdue. Deacon and Sunday school plans count separately.";
  }

  function renderIntakeSummary(summary) {
    var status=el("dashboard-intake-status");if(!status)return;
    var valid=!!session && canEdit() && summary && ["new","due","open"].every(function(k){return Number.isSafeInteger(summary[k]) && summary[k]>=0;}) && summary.new<=summary.open && summary.due<=summary.open;
    el("intake-new-count").textContent=valid?String(summary.new):"—";el("intake-due-count").textContent=valid?String(summary.due):"—";
    document.querySelectorAll("button[data-intake-filter]").forEach(function(button){button.disabled=!valid || !intakeTasks;});
    status.textContent=!session || !canEdit()?"":valid?summary.open+" open actions in the loaded records. Assignment and email status are shown separately.":"Intake actions are unavailable until their reviewed service is ready. Other Office tools remain separate.";
  }

  function renderFollowupSummary(summary) {
    var list = el("dashboard-followup-list"), status = el("dashboard-followup-status"), badge = el("followup-badge");
    list.replaceChildren(); badge.textContent = ""; badge.removeAttribute("aria-label");
    if (!session || !canEdit()) { status.textContent = ""; return; }
    if (!summary || typeof summary.due !== "number" || typeof summary.overdue !== "number") { status.textContent = "Your follow-ups are unavailable. Open My follow-ups to refresh."; return; }
    var due = summary.due + summary.overdue;
    badge.textContent = due ? String(due) : "";
    if (due) badge.setAttribute("aria-label", due + " personal follow-up" + (due === 1 ? "" : "s") + " due");
    status.textContent = due ? due + " leader" + (due === 1 ? " is" : "s are") + " ready for your attention · " + summary.overdue + " overdue." : "No personal follow-ups are due today. Review your upcoming check-ins or add a leader.";
    (summary.items || []).slice(0, 3).forEach(function (item) {
      var row = document.createElement("a"); row.href = "#followups"; row.className = "personal-dashboard-row";
      var name = document.createElement("strong"), date = document.createElement("span");
      name.textContent = item.display_name || (item.plan && item.plan.display_name) || "Leader follow-up";
      date.textContent = item.due_on ? "Due " + dateLabel(item.due_on) : "View follow-up";
      row.onclick = function () { if (followups && followups.showView) followups.showView(item.state === "upcoming" ? "upcoming" : "due"); };
      row.append(name, date); list.appendChild(row);
    });
  }

  function eventRow(item) {
    var start = new Date(item.starts_at);
    return '<article class="row"><time datetime="' + safe(item.starts_at) + '">' + safe(start.toLocaleDateString("en-US", { month: "short", day: "numeric" })) + '</time><div><b>' + safe(item.title) + (item.is_archived ? ' · Archived' : '') + '</b><small>' + safe(start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })) + (item.location ? " · " + safe(item.location) : "") + '</small></div>' + (canEdit() ? '<div class="row-actions"><button data-edit-event="' + item.id + '">Edit</button><button data-delete-event="' + item.id + '">' + (item.is_archived ? "Restore" : "Archive") + '</button></div>' : "") + '</article>';
  }
  function personRow(item) { return '<tr><td><b>' + safe(item.last_name + ", " + item.first_name) + '</b>' + (item.membership_number ? '<small class="membership-person-extra">Member #'+safe(item.membership_number)+'</small>' : '') + (item.needs_review ? '<small class="membership-person-extra">Needs source review</small>' : '') + '</td><td><span class="tag">' + safe(item.status) + '</span></td><td>' + safe(item.household_name || "—") + '</td><td>' + dateLabel(item.updated_at.slice(0, 10)) + '</td><td class="person-actions">' + (canEdit() ? '<button class="quiet" data-edit-person="' + item.id + '">Edit</button> <button class="quiet" data-person-history="'+safe(item.id)+'">History</button>' + (care ? ' <button class="quiet" data-person-care="'+safe(item.id)+'" aria-label="Care for '+safe([item.first_name,item.last_name].filter(Boolean).join(" "))+'">Care</button>' : '') : "") + '</td></tr>'; }
  function documentRow(item) { return '<tr><td><b>' + safe(item.title) + '</b><small>' + safe(item.file_name) + '</small></td><td><span class="tag">' + safe(item.category) + '</span></td><td>' + dateLabel(item.updated_at.slice(0, 10)) + '</td><td><button class="quiet" data-open-document="' + item.id + '">Open</button>' + (canEdit() ? ' <button class="quiet" data-edit-document="' + safe(item.id) + '">Edit details</button>' : '') + '</td></tr>'; }
  function activityRow(item) { return '<article class="row"><time>' + safe(new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })) + '</time><div><b>' + safe(item.action) + " " + safe(item.entity_type) + '</b><small>Record ' + safe(item.entity_id || "") + '</small></div></article>'; }

  function bindRowActions() {
    document.querySelectorAll("[data-edit-event]").forEach(function (b) { b.onclick = function () { openEvent(state.events.find(function (x) { return x.id === b.dataset.editEvent; })); }; });
    document.querySelectorAll("[data-delete-event]").forEach(function (b) { b.onclick = function () { var item = state.events.find(function (row) { return row.id === b.dataset.deleteEvent; }); if (item) { openEvent(item); archiveEvent(); } }; });
    document.querySelectorAll("[data-edit-person]").forEach(function (b) { b.onclick = function () { openPerson(state.people.find(function (x) { return x.id === b.dataset.editPerson; })); }; });
    document.querySelectorAll("[data-person-history]").forEach(function (b) { b.onclick = function () { if (membership) membership.selectPerson(b.dataset.personHistory); }; });
    document.querySelectorAll("[data-person-care]").forEach(function (b) { b.onclick = function () {
      if (!care || !canEdit() || !peopleReady || !state.people.some(function (person) { return person.id === b.dataset.personCare; })) return;
      if (care.selectPerson(b.dataset.personCare)) { location.hash = "care"; route(); }
    }; });
    document.querySelectorAll("[data-edit-document]").forEach(function (b) { b.onclick = function () { openDocumentEditor(state.documents.find(function (row) { return row.id === b.dataset.editDocument; })); }; });
    document.querySelectorAll("[data-open-document]").forEach(function (b) { b.onclick = function () { openDocument(b.dataset.openDocument); }; });
  }

  function primaryAction() { var view = (location.hash || "#dashboard").slice(1); if (view === "calendar") openEvent(); if (view === "people") openPerson(); if (view === "documents") openUpload(); if (officeContent && contentViews.includes(view)) officeContent.open(view); }
  function openEditor(kind, title, fields, id) { if (!session || !canEdit() || (draft && draft.busy)) return false; if (!clearEditor()) return false; var list = state[kind === "event" ? "events" : kind === "person" ? "people" : "documents"], existing = id ? list.find(function (row) { return row.id === id; }) : null; if (id && !existing) return false; draft = { kind: kind, id: id || crypto.randomUUID(), isNew: !id, version: existing ? existing.version : 0, archived: !!(existing && existing.is_archived), busy: false, requiresRefresh: false, conflict: false }; el("editor-kicker").textContent = kind; el("editor-title").textContent = title; el("editor-fields").innerHTML = fields; el("editor-error").textContent = ""; el("editor-form").dataset.kind = kind; el("editor-form").dataset.id = id || ""; el("editor").showModal(); draft.initial = editorSnapshot(); syncEditor(); return true; }
  function input(name, label, type, value, wide) { return '<label class="' + (wide ? "wide" : "") + '">' + label + '<input name="' + name + '" type="' + type + '" value="' + safe(value || "") + '" ' + (["title", "first_name", "starts_at"].indexOf(name) > -1 ? "required" : "") + '></label>'; }
  function select(name, label, options, value) { return '<label>' + label + '<select name="' + name + '">' + options.map(function (x) { return '<option value="' + x + '" ' + (x === value ? "selected" : "") + '>' + x + '</option>'; }).join("") + '</select></label>'; }
  function textArea(name, label, value) { return '<label class="wide">' + label + '<textarea name="' + name + '">' + safe(value || "") + '</textarea></label>'; }
  function localDateTime(value) { if (!value) return ""; var d = new Date(value); var offset = d.getTimezoneOffset(); return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16); }
  function openEvent(item) { item = item || {}; return openEditor("event", item.id ? "Edit event" : "Add event", '<div class="form-grid">' + input("title", "Title", "text", item.title) + select("tag", "Type", ["Weekly", "Monthly", "Special"], item.tag || "Special") + input("starts_at", "Starts", "datetime-local", localDateTime(item.starts_at)) + input("ends_at", "Ends", "datetime-local", localDateTime(item.ends_at)) + input("location", "Location", "text", item.location, true) + textArea("description", "Details", item.description) + '</div>', item.id); }
  function openPerson(item) {
    item = item || {};
    var hasLedgerDetails = ["former_names", "membership_number", "legacy_member_id", "birth_date_text", "received_date_text", "how_received", "baptism_date_text", "dismissal_date_text", "reason_for_decrease"].some(function (name) { return !!item[name]; });
    openEditor("person", item.id ? "Edit person" : "Add person",
      '<p class="membership-note">Start with the details you know. Keep one record per person so their history and care stay together.</p>' +
      (item.id ? '' : '<section id="person-review" class="person-review hidden" aria-labelledby="person-review-title" hidden></section>') +
      '<fieldset class="person-form-section"><legend>Person &amp; household</legend><div class="form-grid">' +
      input("first_name", "First name", "text", item.first_name) + input("last_name", "Last name", "text", item.last_name) +
      input("middle_name", "Middle name", "text", item.middle_name) + input("preferred_name", "Preferred name", "text", item.preferred_name) +
      select("status", "Status", ["active", "inactive", "visitor"], item.status || "active") + input("household_name", "Household", "text", item.household_name) +
      '</div><p class="membership-note person-field-help">Set status to inactive to archive a person; their history is retained.</p></fieldset>' +
      '<fieldset class="person-form-section"><legend>Contact details</legend><div class="form-grid">' +
      input("email", "Email", "email", item.email) + input("phone", "Phone", "tel", item.phone) + input("address", "Address", "text", item.address, true) + '</div></fieldset>' +
      '<details class="person-ledger"' + (hasLedgerDetails ? ' open' : '') + '><summary>Historical ledger details <span>Optional</span></summary>' +
      '<p class="membership-note">Copy dates and wording as recorded, including approximate dates. Preserve anything uncertain rather than guessing.</p><div class="form-grid">' +
      input("former_names", "Former names / spelling variants", "text", item.former_names, true) +
      input("membership_number", "Membership number", "text", item.membership_number) + input("legacy_member_id", "Existing ledger MemberID", "text", item.legacy_member_id) +
      input("birth_date_text", "Birth date as recorded", "text", item.birth_date_text) + input("received_date_text", "Date received as recorded", "text", item.received_date_text) +
      input("how_received", "How received", "text", item.how_received) + input("baptism_date_text", "Baptism date as recorded", "text", item.baptism_date_text) +
      input("dismissal_date_text", "Dismissal date as recorded", "text", item.dismissal_date_text) + input("reason_for_decrease", "Reason for removal from active roll", "text", item.reason_for_decrease) + '</div></details>' +
      '<fieldset class="person-form-section"><legend>Review &amp; notes</legend><div class="form-grid">' +
      select("needs_review", "Source verification", ["Verified", "Needs review"], (!item.id || item.needs_review) ? "Needs review" : "Verified") +
      textArea("notes", "Administrative notes (visible to all approved staff roles)", item.notes) + '</div></fieldset>', item.id);
  }

  function openUpload(category) { openEditor("document", "Upload document", '<div class="form-grid">' + input("title", "Title", "text", "") + select("category", "Category", ["policy", "spreadsheet", "form", "minutes", "ministry", "other"], category || "policy") + '<label class="wide">File<input name="file" type="file" required aria-describedby="upload-help"><span id="upload-help">Maximum file size: 50 MB.</span></label>' + textArea("description", "Description", "") + '</div>'); }

  function openDocumentEditor(item) {
    if (!item) return;
    openEditor("document", "Edit document details", '<p class="membership-note">This changes the description and category. The original uploaded file stays in place.</p><div class="form-grid">' + input("title", "Title", "text", item.title) + select("category", "Category", ["policy", "spreadsheet", "form", "minutes", "ministry", "other"], item.category) + textArea("description", "Description", item.description) + '</div>', item.id);
  }
  function tableFor(kind) { return kind === "event" ? "events" : kind === "person" ? "contacts" : "documents"; }
  function valuesMatch(row, payload) { return Object.keys(payload || {}).every(function (key) { return ((key === "starts_at" || key === "ends_at") && row[key] && payload[key] && Date.parse(row[key]) === Date.parse(payload[key])) || row[key] === payload[key] || (row[key] == null && payload[key] == null); }); }
  function textValue(form, key) { return String(form.get(key) || "").trim(); }
  // Unicode Format (Cf), including zero-width spaces/joiners and direction marks,
  // cannot supply a required field's content. This check never rewrites its value.
  function hasTextContent(value) { return String(value || "").replace(/[\s\p{Cf}]/gu, "").length > 0; }
  // Ignore Cf only for similar-record comparison; stored names and IDs keep them.
  function identityText(value) { return String(value || "").normalize("NFC").replace(/\p{Cf}/gu, "").trim().replace(/\s+/g, " ").toLowerCase(); }
  function personReview(row) {
    var identity = [row.first_name, row.last_name, row.membership_number, row.legacy_member_id].map(identityText);
    var matches = state.people.filter(function (person) {
      return (identity[0] && identity[1] && identity[0] === identityText(person.first_name) && identity[1] === identityText(person.last_name)) ||
        (identity[2] && identity[2] === identityText(person.membership_number)) ||
        (identity[3] && identity[3] === identityText(person.legacy_member_id));
    });
    return { matches: matches, key: JSON.stringify([identity, matches.map(function (person) {
      return [person.id, person.first_name, person.last_name, person.membership_number, person.legacy_member_id, person.household_name, person.status].map(function (value) { return String(value || ""); });
    }).sort(function (a, b) { return a[0].localeCompare(b[0]); })]) };
  }
  function renderPersonReview() {
    var box = el("person-review");
    if (!box || !draft || draft.kind !== "person" || !draft.isNew) return;
    if (!peopleReady || !canEdit()) { box.replaceChildren(); hidden(box, true); return; }
    var form = el("editor-form").elements, row = {};
    ["first_name", "last_name", "membership_number", "legacy_member_id"].forEach(function (key) { row[key] = form[key] ? form[key].value : ""; });
    var review = personReview(row);
    if (draft.personReviewKey !== review.key) { draft.personReviewKey = review.key; draft.personReviewAccepted = false; }
    if (!review.matches.length) { box.replaceChildren(); hidden(box, true); return; }
    hidden(box, false);
    // Do not replace the checkbox while staff are interacting with an unchanged review.
    if (box.dataset.reviewKey === review.key && box.childElementCount) return;
    box.dataset.reviewKey = review.key;
    box.innerHTML = '<h3 id="person-review-title">Could this person already be here?</h3><p>' + review.matches.length + ' existing ' + (review.matches.length === 1 ? 'record shares' : 'records share') + ' this name or member identifier. A match is a reason to check, not proof that they are the same person.</p><ul class="person-review-list">' + review.matches.map(function (person) {
      return '<li><div><strong>' + safe([person.first_name, person.last_name].filter(Boolean).join(" ")) + '</strong><small>' + safe(person.status || "") + (person.membership_number ? ' · Member #'+safe(person.membership_number) : '') + (person.household_name ? ' · '+safe(person.household_name) : '') + '</small></div><button class="quiet" type="button" data-review-person="' + safe(person.id) + '">Review record</button></li>';
    }).join('') + '</ul><label class="person-review-confirm"><input type="checkbox" name="person_match_reviewed"><span>I checked these records. This is a different person.</span></label><p class="membership-note">If it is the same person, use their existing record. Names or numbers alone do not establish identity.</p>';
    var reviewDraft = draft, reviewAuth = authEpoch, reviewEditor = editorEpoch;
    function currentReview(node) {
      return draft === reviewDraft && authEpoch === reviewAuth && editorEpoch === reviewEditor && canEdit() && peopleReady &&
        !draft.busy && !draft.requiresRefresh && !draft.conflict && draft.personReviewKey === review.key &&
        box === el("person-review") && box.isConnected && box.contains(node);
    }
    var checkbox = box.querySelector("input"); checkbox.checked = !!draft.personReviewAccepted;
    checkbox.onchange = function () { if (currentReview(checkbox)) draft.personReviewAccepted = checkbox.checked; };
    box.querySelectorAll("[data-review-person]").forEach(function (button) { button.onclick = function () {
      if (!currentReview(button)) return;
      var person = state.people.find(function (item) { return item.id === button.dataset.reviewPerson; });
      if (person) openPerson(person);
    }; });
  }
  function payloadFor(form, item) {
    var row;
    if (item.kind === "event") {
      var starts = new Date(form.get("starts_at")), ends = form.get("ends_at") ? new Date(form.get("ends_at")) : null;
      if (!hasTextContent(textValue(form, "title"))) throw new Error("Enter a title.");
      if (isNaN(starts) || (ends && (isNaN(ends) || ends < starts))) throw new Error("Choose a valid start time and an end time after it.");
      row = { title: textValue(form, "title"), tag: form.get("tag"), starts_at: starts.toISOString(), ends_at: ends ? ends.toISOString() : null, location: textValue(form, "location") || null, description: textValue(form, "description") || null };
    } else if (item.kind === "person") {
      if (!hasTextContent(textValue(form, "first_name"))) throw new Error("Enter a first name.");
      row = { first_name: textValue(form, "first_name"), last_name: textValue(form, "last_name"), status: form.get("status"), needs_review: form.get("needs_review") === "Needs review" };
      ["household_name", "email", "phone", "notes", "membership_number", "legacy_member_id", "middle_name", "preferred_name", "former_names", "address", "birth_date_text", "received_date_text", "how_received", "baptism_date_text", "dismissal_date_text", "reason_for_decrease"].forEach(function (key) { row[key] = textValue(form, key) || null; });
    } else {
      if (!hasTextContent(textValue(form, "title"))) throw new Error("Enter a title.");
      row = { title: textValue(form, "title"), category: form.get("category"), description: textValue(form, "description") || null };
      if (item.isNew) {
        var file = item.file || form.get("file");
        if (!file || !file.name || !file.size) throw new Error("Choose a non-empty file.");
        if (file.size > MAX_FILE_BYTES) throw new Error("This file is larger than 50 MB. Choose a smaller file.");
        item.file = file;
        if (el("upload-help")) el("upload-help").textContent = "This draft keeps the selected file through recovery. Start a new upload to choose a different file.";
        var suffix = file.name.includes(".") ? file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : "";
        item.path = item.path || session.user.id + "/" + item.id + (suffix ? "." + suffix : "");
        Object.assign(row, { storage_path: item.path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size });
      }
    }
    return row;
  }
  async function saveEditor(event) {
    event.preventDefault();
    if (!session || !canEdit() || !draft || draft.busy || draft.requiresRefresh || draft.conflict) return;
    try {
      var payload = draft.unresolvedWrites ? draft.submitted : payloadFor(new FormData(event.currentTarget), draft);
      if (draft.kind === "person" && draft.isNew) {
        renderPersonReview();
        var review = personReview(payload);
        if (review.matches.length && (draft.personReviewKey !== review.key || !draft.personReviewAccepted)) {
          el("editor-error").textContent = "Review the similar records before adding a different person.";
          el("person-review").querySelector("button").focus(); return;
        }
      }
      await persistDraft(payload);
    }
    catch (error) { if (draft) el("editor-error").textContent = error.message || "Check the form and try again."; }
  }
  async function persistDraft(payload) {
    var item = draft, epoch = authEpoch;
    if (!item || item.busy || !canEdit()) return;
    item.busy = true; item.submitted = payload; item.attempted = false;
    el("editor-error").textContent = ""; syncEditor();
    try {
      if (!await ensureReady(epoch) || draft !== item) throw new Error("The workspace could not be verified. Refresh before saving.");
      requireCurrent(epoch);
      if (item.kind === "document" && item.isNew && !item.uploadVerified) {
        item.attempted = true; item.uploadUncertain = true;
        var uploaded = await draftWrite(item, epoch, db.storage.from("church-documents").upload(item.path, item.file, { contentType: item.file.type || "application/octet-stream", upsert: false }), "upload");
        requireCurrent(epoch); if (draft !== item) return;
        if (uploaded.error) throw uploaded.error;
        item.uploadVerified = true; item.uploadUncertain = false;
      }
      requireCurrent(epoch);
      if (!canEdit() || draft !== item) throw new Error("Your access changed. Refresh before saving.");
      // A refresh may reveal another match while the readiness check is pending.
      // This is a review stop before any write, so keep the draft editable.
      if (item.kind === "person" && item.isNew) {
        renderPersonReview();
        var review = personReview(payload);
        if (review.matches.length && (item.personReviewKey !== review.key || !item.personReviewAccepted)) {
          el("editor-error").textContent = "Review the similar records before adding a different person.";
          return;
        }
      }
      item.attempted = true;
      var query = item.isNew ? db.from(tableFor(item.kind)).insert(Object.assign({ id: item.id }, payload)) : db.from(tableFor(item.kind)).update(payload).eq("id", item.id).eq("version", item.version);
      var result = await draftWrite(item, epoch, query.select("*").single());
      if (!current(epoch) || draft !== item) return;
      if (result.error) throw result.error;
      if (!result.data || result.data.id !== item.id || result.data.version !== (item.isNew ? 1 : item.version + 1)) throw new Error("The saved record could not be confirmed.");
      if (item.kind === "document" && item.isNew && result.data.storage_path !== item.path) throw new Error("The uploaded document could not be confirmed.");
      item.busy = false; clearEditor(true);
      notice(payload.is_archived === true ? "Event archived. You can restore it from Archived events." : payload.is_archived === false ? "Event restored." : "Saved and confirmed.");
      await loadAll(epoch);
    } catch (error) {
      if (!current(epoch) || draft !== item) return;
      if (authFailure(error)) { queueSession(null); el("login-error").textContent = "Your session could not be verified. Sign in again."; return; }
      item.requiresRefresh = true;
      el("editor-error").textContent = item.attempted ? "The save could not be confirmed. Your submitted draft is locked temporarily. Refresh workspace to check whether it saved before trying again." : "The workspace could not be verified. Your draft is preserved. Refresh before trying again.";
    } finally { if (draft === item) { item.busy = false; syncEditor(); if (el("workspace-refresh")) el("workspace-refresh").disabled = refreshing; } }
  }
  async function reconcileDraft(epoch, readDraft) {
    var item = draft;
    if (!item || item.busy || !readDraft || readDraft.item !== item) return;
    function freshRead() {
      if ((item.writeRevision || 0) === readDraft.revision) return true;
      item.requiresRefresh = true; item.settlementNeedsRead = true;
      el("editor-error").textContent = "A save request started or settled during this refresh. Refresh workspace again to check its current result.";
      return false;
    }
    if (!freshRead()) return;
    var rows = state[item.kind === "event" ? "events" : item.kind === "person" ? "people" : "documents"], saved = rows.find(function (row) { return row.id === item.id; });
    if (item.requiresRefresh && item.attempted && saved && saved.version === (item.isNew ? 1 : item.version + 1) && valuesMatch(saved, item.submitted)) {
      clearEditor(true); notice("The previous save was confirmed during refresh. Review the saved record before making more changes."); return;
    }
    if ((!item.isNew && (!saved || saved.version !== item.version)) || (item.isNew && saved)) {
      item.requiresRefresh = false; item.settlementNeedsRead = false; item.conflict = true;
      el("editor-error").textContent = "This record changed or is no longer available. Your draft is preserved. Review or copy your changes, then close and reopen the current record; this older draft cannot overwrite it.";
      return;
    }
    if (item.requiresRefresh && item.uploadUncertain && item.path) {
      var split = item.path.lastIndexOf("/"), name = item.path.slice(split + 1);
      var result = await deadline(db.storage.from("church-documents").list(item.path.slice(0, split), { search: name, limit: 100 }));
      if (!current(epoch) || draft !== item) return;
      if (result.error || !Array.isArray(result.data)) throw result.error || new Error("The uploaded file could not be checked.");
      if (!freshRead()) return;
      var stored = result.data.find(function (file) { return file.name === name; });
      if (stored && (!stored.metadata || Number(stored.metadata.size) !== item.file.size)) {
        item.settlementNeedsRead = false; item.conflict = true; el("editor-error").textContent = "An upload exists at this draft's reserved path but its details could not be verified. Keep this draft and ask the office administrator to review it."; return;
      }
      item.uploadVerified = !!stored; item.uploadUncertain = false;
    }
    if (item.requiresRefresh) {
      item.requiresRefresh = false; item.settlementNeedsRead = false;
      el("editor-error").textContent = item.unresolvedWrites ? "The save was not found, but an earlier request is still unresolved. Keep this draft open; you may retry the same submitted record using its existing ID." : "The previous save was not found. Your draft is preserved and can be retried using the same record ID.";
    }
  }
  async function archiveEvent() {
    if (!draft || draft.kind !== "event" || draft.isNew || draft.busy || draft.unresolvedWrites || draft.settlementNeedsRead || draft.requiresRefresh || draft.conflict || !canEdit()) return;
    if (editorSnapshot() !== draft.initial) { el("editor-error").textContent = "Save your other event changes before archiving or restoring it, or close and discard those changes first."; return; }
    if (!draft.archived && !window.confirm("Archive this staff calendar event? It will leave the active list and can be restored from Archived events.")) return;
    await persistDraft({ is_archived: !draft.archived });
  }
  async function openDocument(id) {
    if (!session || !role || !workspaceReady) return;
    var item = state.documents.find(function (x) { return x.id === id; }); if (!item) return;
    var epoch = authEpoch, request = ++documentEpoch;
    el("document-result").textContent = "Preparing a private link…"; el("document-dialog").showModal();
    try {
      if (!await verifyReadiness(epoch) || !workspaceReady) throw new Error("The workspace could not be verified. Refresh before opening a file.");
      var result = await deadline(db.storage.from("church-documents").createSignedUrl(item.storage_path, 60));
      if (!current(epoch) || request !== documentEpoch || !el("document-dialog").open) return;
      if (result.error) throw result.error;
      var address = documentUrl(result.data.signedUrl);
      var link = document.createElement("a"); link.href = address.href; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Open " + item.title;
      var note = document.createElement("p"); note.textContent = "This private link expires after one minute. Close this dialog and open the document again for a fresh link.";
      el("document-result").replaceChildren(link, note); link.focus();
      window.clearTimeout(documentExpiryTimer);
      documentExpiryTimer = window.setTimeout(function () {
        if (current(epoch) && request === documentEpoch && el("document-dialog").open) el("document-result").textContent = "This private link has expired. Close this dialog and open the document again for a fresh link.";
      }, 60000);
    } catch (error) { if (current(epoch) && request === documentEpoch) el("document-result").textContent = error.message || "Could not prepare the document. Please try again."; }
  }

  start().catch(function () { show("setup"); el("setup").querySelector("p:last-child").textContent = "The secure workspace could not start. Check the connection and browser storage settings, then reload."; });
})();
