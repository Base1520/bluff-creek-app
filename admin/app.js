(function () {
  "use strict";
  var cfg = window.CREEK_OFFICE_CONFIG || {};
  var els = {};
  var db = null;
  var session = null;
  var role = null;
  var state = { events: [], people: [], documents: [], activity: [] };
  var titles = { dashboard: "Overview", calendar: "Calendar", people: "People", documents: "Documents", activity: "Activity" };

  function el(id) { return document.getElementById(id); }
  function show(id) { ["setup", "login", "workspace"].forEach(function (name) { el(name).classList.toggle("hidden", name !== id); }); }
  function safe(value) { var node = document.createElement("span"); node.textContent = value == null ? "" : String(value); return node.innerHTML; }
  function dateLabel(value) { if (!value) return ""; return new Date(value + (value.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  function notice(message, bad) { els.notice.textContent = message; els.notice.classList.remove("hidden"); els.notice.style.borderColor = bad ? "#9b3f2c" : "#3C5A45"; window.clearTimeout(notice.timer); notice.timer = window.setTimeout(function () { els.notice.classList.add("hidden"); }, 4500); }
  function fail(error) { console.error(error); notice(error.message || "Something went wrong.", true); }
  function canEdit() { return role === "admin" || role === "editor"; }

  async function start() {
    els.notice = el("notice");
    if (!cfg.supabaseUrl || !cfg.publishableKey || cfg.supabaseUrl.indexOf("YOUR_PROJECT") !== -1) { show("setup"); return; }
    if (!window.supabase || !window.supabase.createClient) { show("setup"); el("setup").querySelector("p:last-child").textContent = "The secure client could not load. Check the network connection and pinned client file."; return; }
    db = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    bind();
    var result = await db.auth.getSession();
    if (result.error) return fail(result.error);
    await useSession(result.data.session);
    db.auth.onAuthStateChange(function (_event, nextSession) { if ((!session && nextSession) || (session && !nextSession)) useSession(nextSession); });
  }

  function bind() {
    els.notice = el("notice");
    el("login-form").addEventListener("submit", login);
    el("logout").addEventListener("click", function () { db.auth.signOut(); });
    el("menu").addEventListener("click", function () { document.querySelector("aside").classList.toggle("open"); });
    window.addEventListener("hashchange", route);
    document.querySelectorAll("aside nav a").forEach(function (link) { link.addEventListener("click", function () { document.querySelector("aside").classList.remove("open"); }); });
    el("primary-action").addEventListener("click", primaryAction);
    document.querySelectorAll("[data-close-editor]").forEach(function (button) { button.addEventListener("click", function () { el("editor").close(); }); });
    ["event-search", "event-filter", "people-search", "people-filter", "document-search", "document-filter"].forEach(function (id) { el(id).addEventListener("input", render); });
    el("editor-form").addEventListener("submit", saveEditor);
  }

  async function login(event) {
    event.preventDefault(); el("login-error").textContent = "";
    var result = await db.auth.signInWithPassword({ email: el("email").value.trim(), password: el("password").value });
    if (result.error) el("login-error").textContent = result.error.message;
  }

  async function useSession(next) {
    session = next;
    if (!session) { role = null; show("login"); return; }
    var result = await db.from("staff_roles").select("role").eq("user_id", session.user.id).maybeSingle();
    if (result.error || !result.data) { await db.auth.signOut(); show("login"); el("login-error").textContent = "This account has not been approved for Creek Office."; return; }
    role = result.data.role;
    el("user-label").textContent = session.user.email;
    el("role-label").textContent = role;
    show("workspace");
    await loadAll(); route();
  }

  async function loadAll() {
    var results = await Promise.all([
      db.from("events").select("*").order("starts_at", { ascending: true }),
      db.from("contacts").select("*").order("last_name", { ascending: true }),
      db.from("documents").select("*").order("updated_at", { ascending: false }),
      db.from("audit_log").select("*").order("created_at", { ascending: false }).limit(100)
    ]);
    var names = ["events", "people", "documents", "activity"];
    results.forEach(function (result, index) { if (result.error) fail(result.error); else state[names[index]] = result.data || []; });
    render();
  }

  function route() {
    var view = (location.hash || "#dashboard").slice(1);
    if (!titles[view]) view = "dashboard";
    document.querySelectorAll(".view").forEach(function (node) { node.classList.toggle("hidden", node.id !== view + "-view"); });
    document.querySelectorAll("aside nav a").forEach(function (node) { node.classList.toggle("active", node.dataset.view === view); });
    el("page-title").textContent = titles[view];
    var labels = { calendar: "Add event", people: "Add person", documents: "Upload document" };
    el("primary-action").textContent = labels[view] || "Add";
    el("primary-action").classList.toggle("hidden", !labels[view] || !canEdit());
    render();
  }

  function render() {
    if (!session) return;
    var now = new Date();
    var future = state.events.filter(function (item) { return new Date(item.ends_at || item.starts_at) >= now; });
    el("event-count").textContent = future.length;
    el("people-count").textContent = state.people.length;
    el("document-count").textContent = state.documents.length;
    el("dashboard-events").innerHTML = future.slice(0, 5).map(eventRow).join("");
    var eventTerm = el("event-search").value.toLowerCase(), eventTag = el("event-filter").value;
    el("events-list").innerHTML = state.events.filter(function (item) { return (!eventTag || item.tag === eventTag) && (!eventTerm || [item.title, item.location, item.description].join(" ").toLowerCase().includes(eventTerm)); }).map(eventRow).join("");
    var peopleTerm = el("people-search").value.toLowerCase(), peopleStatus = el("people-filter").value;
    el("people-list").innerHTML = state.people.filter(function (item) { return (!peopleStatus || item.status === peopleStatus) && (!peopleTerm || [item.first_name, item.last_name, item.household_name].join(" ").toLowerCase().includes(peopleTerm)); }).map(personRow).join("");
    var docTerm = el("document-search").value.toLowerCase(), docCategory = el("document-filter").value;
    el("documents-list").innerHTML = state.documents.filter(function (item) { return (!docCategory || item.category === docCategory) && (!docTerm || [item.title, item.file_name, item.description].join(" ").toLowerCase().includes(docTerm)); }).map(documentRow).join("");
    el("activity-list").innerHTML = state.activity.map(activityRow).join("");
    bindRowActions();
  }

  function eventRow(item) {
    var start = new Date(item.starts_at);
    return '<article class="row"><time datetime="' + safe(item.starts_at) + '">' + safe(start.toLocaleDateString("en-US", { month: "short", day: "numeric" })) + '</time><div><b>' + safe(item.title) + '</b><small>' + safe(start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })) + (item.location ? " · " + safe(item.location) : "") + '</small></div>' + (canEdit() ? '<div class="row-actions"><button data-edit-event="' + item.id + '">Edit</button><button data-delete-event="' + item.id + '">Delete</button></div>' : "") + '</article>';
  }
  function personRow(item) { return '<tr><td><b>' + safe(item.last_name + ", " + item.first_name) + '</b></td><td><span class="tag">' + safe(item.status) + '</span></td><td>' + safe(item.household_name || "—") + '</td><td>' + dateLabel(item.updated_at.slice(0, 10)) + '</td><td>' + (canEdit() ? '<button class="quiet" data-edit-person="' + item.id + '">Edit</button>' : "") + '</td></tr>'; }
  function documentRow(item) { return '<tr><td><b>' + safe(item.title) + '</b><small>' + safe(item.file_name) + '</small></td><td><span class="tag">' + safe(item.category) + '</span></td><td>' + dateLabel(item.updated_at.slice(0, 10)) + '</td><td><button class="quiet" data-open-document="' + item.id + '">Open</button></td></tr>'; }
  function activityRow(item) { return '<article class="row"><time>' + safe(new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })) + '</time><div><b>' + safe(item.action) + " " + safe(item.entity_type) + '</b><small>Record ' + safe(item.entity_id || "") + '</small></div></article>'; }

  function bindRowActions() {
    document.querySelectorAll("[data-edit-event]").forEach(function (b) { b.onclick = function () { openEvent(state.events.find(function (x) { return x.id === b.dataset.editEvent; })); }; });
    document.querySelectorAll("[data-delete-event]").forEach(function (b) { b.onclick = function () { deleteEvent(b.dataset.deleteEvent); }; });
    document.querySelectorAll("[data-edit-person]").forEach(function (b) { b.onclick = function () { openPerson(state.people.find(function (x) { return x.id === b.dataset.editPerson; })); }; });
    document.querySelectorAll("[data-open-document]").forEach(function (b) { b.onclick = function () { openDocument(b.dataset.openDocument); }; });
  }

  function primaryAction() { var view = (location.hash || "#dashboard").slice(1); if (view === "calendar") openEvent(); if (view === "people") openPerson(); if (view === "documents") openUpload(); }
  function openEditor(kind, title, fields, id) { el("editor-kicker").textContent = kind; el("editor-title").textContent = title; el("editor-fields").innerHTML = fields; el("editor-error").textContent = ""; el("editor-form").dataset.kind = kind; el("editor-form").dataset.id = id || ""; el("editor").showModal(); }
  function input(name, label, type, value, wide) { return '<label class="' + (wide ? "wide" : "") + '">' + label + '<input name="' + name + '" type="' + type + '" value="' + safe(value || "") + '" ' + (["title", "first_name", "last_name", "starts_at"].indexOf(name) > -1 ? "required" : "") + '></label>'; }
  function select(name, label, options, value) { return '<label>' + label + '<select name="' + name + '">' + options.map(function (x) { return '<option value="' + x + '" ' + (x === value ? "selected" : "") + '>' + x + '</option>'; }).join("") + '</select></label>'; }
  function textArea(name, label, value) { return '<label class="wide">' + label + '<textarea name="' + name + '">' + safe(value || "") + '</textarea></label>'; }
  function localDateTime(value) { if (!value) return ""; var d = new Date(value); var offset = d.getTimezoneOffset(); return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16); }
  function openEvent(item) { item = item || {}; openEditor("event", item.id ? "Edit event" : "Add event", '<div class="form-grid">' + input("title", "Title", "text", item.title) + select("tag", "Type", ["Weekly", "Monthly", "Special"], item.tag || "Special") + input("starts_at", "Starts", "datetime-local", localDateTime(item.starts_at)) + input("ends_at", "Ends", "datetime-local", localDateTime(item.ends_at)) + input("location", "Location", "text", item.location, true) + textArea("description", "Details", item.description) + '</div>', item.id); }
  function openPerson(item) { item = item || {}; openEditor("person", item.id ? "Edit person" : "Add person", '<div class="form-grid">' + input("first_name", "First name", "text", item.first_name) + input("last_name", "Last name", "text", item.last_name) + select("status", "Status", ["active", "inactive", "visitor"], item.status || "active") + input("household_name", "Household", "text", item.household_name) + input("email", "Email", "email", item.email) + input("phone", "Phone", "tel", item.phone) + textArea("notes", "Pastoral or administrative notes", item.notes) + '</div>', item.id); }
  function openUpload() { openEditor("document", "Upload document", '<div class="form-grid">' + input("title", "Title", "text", "") + select("category", "Category", ["policy", "spreadsheet", "form", "minutes", "ministry", "other"], "policy") + '<label class="wide">File<input name="file" type="file" required></label>' + textArea("description", "Description", "") + '</div>'); }

  async function saveEditor(event) {
    event.preventDefault();
    var form = new FormData(event.currentTarget), kind = event.currentTarget.dataset.kind, id = event.currentTarget.dataset.id;
    el("save").disabled = true; el("editor-error").textContent = "";
    try {
      if (kind === "event") await saveEvent(form, id);
      if (kind === "person") await savePerson(form, id);
      if (kind === "document") await saveDocument(form);
      el("editor").close(); await loadAll(); notice("Saved.");
    } catch (error) { el("editor-error").textContent = error.message; }
    el("save").disabled = false;
  }
  async function saveEvent(form, id) { var row = { title: form.get("title"), tag: form.get("tag"), starts_at: new Date(form.get("starts_at")).toISOString(), ends_at: form.get("ends_at") ? new Date(form.get("ends_at")).toISOString() : null, location: form.get("location") || null, description: form.get("description") || null, updated_by: session.user.id }; var result = id ? await db.from("events").update(row).eq("id", id) : await db.from("events").insert(row); if (result.error) throw result.error; }
  async function savePerson(form, id) { var row = { first_name: form.get("first_name"), last_name: form.get("last_name"), status: form.get("status"), household_name: form.get("household_name") || null, email: form.get("email") || null, phone: form.get("phone") || null, notes: form.get("notes") || null, updated_by: session.user.id }; var result = id ? await db.from("contacts").update(row).eq("id", id) : await db.from("contacts").insert(row); if (result.error) throw result.error; }
  async function saveDocument(form) { var file = form.get("file"); if (!file || !file.name) throw new Error("Choose a file."); var ext = file.name.includes(".") ? "." + file.name.split(".").pop().toLowerCase() : ""; var path = session.user.id + "/" + crypto.randomUUID() + ext; var upload = await db.storage.from("church-documents").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false }); if (upload.error) throw upload.error; var result = await db.from("documents").insert({ title: form.get("title"), category: form.get("category"), description: form.get("description") || null, storage_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size, uploaded_by: session.user.id }); if (result.error) { await db.storage.from("church-documents").remove([path]); throw result.error; } }
  async function deleteEvent(id) { if (!window.confirm("Delete this calendar event?")) return; var result = await db.from("events").delete().eq("id", id); if (result.error) return fail(result.error); await loadAll(); notice("Event deleted."); }
  async function openDocument(id) { var item = state.documents.find(function (x) { return x.id === id; }); if (!item) return; var result = await db.storage.from("church-documents").createSignedUrl(item.storage_path, 60); if (result.error) return fail(result.error); window.open(result.data.signedUrl, "_blank", "noopener"); }

  start().catch(fail);
})();
