const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginFlash = document.getElementById("login-flash");
const appFlash = document.getElementById("app-flash");
const statsEl = document.getElementById("stats");
const subscribersBody = document.getElementById("subscribers-body");
const issuesBody = document.getElementById("issues-body");
const issueEditor = document.getElementById("issue-editor");
const issueForm = document.getElementById("issue-form");
const storyForm = document.getElementById("story-form");
const storiesList = document.getElementById("stories-list");
const previewLink = document.getElementById("preview-link");
const taskBoard = document.getElementById("task-board");

/** @type {any[]} */
let issuesCache = [];
/** @type {string | null} */
let selectedIssueId = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function flash(el, text, kind = "") {
  if (!(el instanceof HTMLElement)) return;
  el.className = `flash ${kind}`.trim();
  el.textContent = text;
}

function showLogin() {
  loginView?.classList.remove("hidden");
  appView?.classList.add("hidden");
}

function showApp() {
  loginView?.classList.add("hidden");
  appView?.classList.remove("hidden");
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.getAttribute("data-panel") !== name);
  });
}

async function bootstrap() {
  try {
    const session = await api("/api/admin/session");
    if (!session.configured) {
      showLogin();
      flash(
        loginFlash,
        "Set ADMIN_PASSWORD in Railway env vars, then redeploy.",
        "err"
      );
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showApp();
    await refreshAll();
  } catch (err) {
    showLogin();
    flash(loginFlash, err.message, "err");
  }
}

async function refreshAll() {
  await Promise.all([loadStats(), loadSubscribers(), loadIssues(), loadTasks()]);
}

async function loadStats() {
  const { stats } = await api("/api/admin/stats");
  if (!statsEl) return;
  const items = [
    ["Active subscribers", stats.active_subscribers],
    ["Total subscribers", stats.total_subscribers],
    ["Draft issues", stats.draft_issues],
    ["Ready to send", stats.ready_issues],
    ["Open tasks", stats.open_tasks],
  ];
  statsEl.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
    )
    .join("");
}

async function loadSubscribers() {
  const { subscribers } = await api("/api/admin/subscribers");
  if (!subscribersBody) return;
  subscribersBody.innerHTML = subscribers
    .map((sub) => {
      const name = sub.first_name || "—";
      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(sub.email)}</td>
        <td><span class="badge ${escapeHtml(sub.status)}">${escapeHtml(sub.status)}</span></td>
        <td class="row-actions">
          ${
            sub.status === "active"
              ? `<button type="button" class="secondary" data-sub-status="${sub.id}" data-status="unsubscribed">Unsubscribe</button>`
              : `<button type="button" class="secondary" data-sub-status="${sub.id}" data-status="active">Reactivate</button>`
          }
          <button type="button" class="danger" data-sub-delete="${sub.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

async function loadIssues() {
  const { issues } = await api("/api/admin/issues");
  issuesCache = issues;
  if (!issuesBody) return;
  issuesBody.innerHTML = issues
    .map(
      (issue) => `<tr>
        <td>${escapeHtml(issue.issue_date)}</td>
        <td>${escapeHtml(issue.subject)}</td>
        <td><span class="badge ${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span></td>
        <td class="row-actions">
          <button type="button" class="secondary" data-issue-edit="${issue.id}">Edit</button>
          <a class="btn secondary" href="/preview/${issue.id}" target="_blank" rel="noopener">Preview</a>
          <button type="button" class="danger" data-issue-delete="${issue.id}">Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadTasks() {
  const { tasks } = await api("/api/admin/tasks");
  if (!taskBoard) return;
  const columns = [
    ["todo", "To do"],
    ["doing", "Doing"],
    ["done", "Done"],
  ];
  taskBoard.innerHTML = columns
    .map(([status, label]) => {
      const items = tasks.filter((t) => t.status === status);
      return `<div class="task-col">
        <h3>${label} (${items.length})</h3>
        ${
          items.length
            ? items
                .map(
                  (task) => `<div class="task">
                    <strong>${escapeHtml(task.title)}</strong>
                    <div class="muted">${escapeHtml(task.notes || "")}${
                      task.due_date ? ` · due ${escapeHtml(task.due_date)}` : ""
                    }</div>
                    <div class="row-actions" style="margin-top:0.45rem">
                      ${
                        status !== "todo"
                          ? `<button type="button" class="secondary" data-task-status="${task.id}" data-status="todo">To do</button>`
                          : ""
                      }
                      ${
                        status !== "doing"
                          ? `<button type="button" class="secondary" data-task-status="${task.id}" data-status="doing">Doing</button>`
                          : ""
                      }
                      ${
                        status !== "done"
                          ? `<button type="button" class="secondary" data-task-status="${task.id}" data-status="done">Done</button>`
                          : ""
                      }
                      <button type="button" class="danger" data-task-delete="${task.id}">Delete</button>
                    </div>
                  </div>`
                )
                .join("")
            : `<p class="muted">No tasks</p>`
        }
      </div>`;
    })
    .join("");
}

function fillIssueForm(issue) {
  if (!(issueForm instanceof HTMLFormElement)) return;
  selectedIssueId = issue.id;
  issueEditor?.classList.remove("hidden");
  const title = document.getElementById("issue-editor-title");
  if (title) title.textContent = `Edit · ${issue.subject}`;
  if (previewLink instanceof HTMLAnchorElement) {
    previewLink.href = `/preview/${issue.id}`;
  }
  for (const [key, value] of Object.entries(issue)) {
    const field = issueForm.elements.namedItem(key);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
      continue;
    }
    if (key === "coming_up") {
      field.value = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    } else {
      field.value = value == null ? "" : String(value);
    }
  }
  loadStories(issue.id);
}

async function loadStories(issueId) {
  const { stories } = await api(`/api/admin/issues/${issueId}/stories`);
  if (!storiesList) return;
  storiesList.innerHTML = stories.length
    ? stories
        .map(
          (story) => `<div class="story-item">
            <h3>0${story.position} · ${escapeHtml(story.title)}</h3>
            <div class="muted">${escapeHtml(story.eyebrow || "")}</div>
            ${
              story.source_notes
                ? `<p class="muted"><strong>Notes:</strong> ${escapeHtml(story.source_notes)}</p>`
                : ""
            }
            <p>${escapeHtml(story.summary || "")}</p>
            <div class="row-actions">
              <button type="button" class="secondary" data-story-edit='${escapeAttr(JSON.stringify(story))}'>Edit</button>
              <button type="button" class="danger" data-story-delete="${story.id}">Delete</button>
            </div>
          </div>`
        )
        .join("")
    : `<p class="muted">No stories yet. Add up to 6.</p>`;
}

function blankIssue() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: "",
    issue_date: today,
    volume_label: "",
    subject: `The Ebb & Flow — ${today}`,
    preheader: "",
    intro: "",
    weather: "",
    high_tides: "",
    low_tides: "",
    high_tide_label: "",
    coming_up: [],
    cta_url: "",
    cta_label: "Read the full stories →",
    tip_headline: "Got a tip or a story we missed?",
    tip_body: "Just hit reply — every message reaches the newsroom directly.",
    postal_address: "",
    status: "draft",
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const password = String(new FormData(form).get("password") ?? "");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    flash(loginFlash, "");
    showApp();
    await refreshAll();
  } catch (err) {
    flash(loginFlash, err.message, "err");
  }
});

document.getElementById("logout-btn")?.addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" });
  showLogin();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

document.getElementById("add-subscriber-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api("/api/admin/subscribers", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    flash(appFlash, "Subscriber added.", "ok");
    await Promise.all([loadSubscribers(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

subscribersBody?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  try {
    if (target.dataset.subStatus) {
      await api(`/api/admin/subscribers/${target.dataset.subStatus}`, {
        method: "PATCH",
        body: JSON.stringify({ status: target.dataset.status }),
      });
      await Promise.all([loadSubscribers(), loadStats()]);
    }
    if (target.dataset.subDelete) {
      if (!confirm("Delete this subscriber?")) return;
      await api(`/api/admin/subscribers/${target.dataset.subDelete}`, {
        method: "DELETE",
      });
      await Promise.all([loadSubscribers(), loadStats()]);
    }
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

document.getElementById("new-issue-btn")?.addEventListener("click", () => {
  fillIssueForm(blankIssue());
  selectedIssueId = null;
  const title = document.getElementById("issue-editor-title");
  if (title) title.textContent = "New issue";
  if (storiesList) storiesList.innerHTML = `<p class="muted">Save the issue first, then add stories.</p>`;
});

issuesBody?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  try {
    if (target.dataset.issueEdit) {
      const issue = issuesCache.find((i) => i.id === target.dataset.issueEdit);
      if (issue) fillIssueForm(issue);
    }
    if (target.dataset.issueDelete) {
      if (!confirm("Delete this issue and its stories?")) return;
      await api(`/api/admin/issues/${target.dataset.issueDelete}`, {
        method: "DELETE",
      });
      if (selectedIssueId === target.dataset.issueDelete) {
        issueEditor?.classList.add("hidden");
        selectedIssueId = null;
      }
      flash(appFlash, "Issue deleted.", "ok");
      await Promise.all([loadIssues(), loadStats()]);
    }
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

issueForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(issueForm instanceof HTMLFormElement)) return;
  const raw = Object.fromEntries(new FormData(issueForm).entries());
  const payload = {
    ...raw,
    coming_up: String(raw.coming_up || ""),
  };
  try {
    if (raw.id) {
      const { issue } = await api(`/api/admin/issues/${raw.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      flash(appFlash, "Issue saved.", "ok");
      fillIssueForm(issue);
    } else {
      const { issue } = await api("/api/admin/issues", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      flash(appFlash, "Issue created.", "ok");
      fillIssueForm(issue);
    }
    await Promise.all([loadIssues(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

async function sendSelected(dryRun) {
  if (!selectedIssueId) {
    flash(appFlash, "Save the issue before sending.", "err");
    return;
  }
  if (!dryRun && !confirm("Send this issue to all active subscribers?")) return;
  try {
    const { result } = await api(`/api/admin/issues/${selectedIssueId}/send`, {
      method: "POST",
      body: JSON.stringify({ dry_run: dryRun }),
    });
    flash(
      appFlash,
      dryRun
        ? `Dry run complete: ${result.skipped} skipped.`
        : `Send complete: ${result.sent} sent, ${result.failed} failed.`,
      result.failed ? "err" : "ok"
    );
    await Promise.all([loadIssues(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
}

document.getElementById("send-dry-btn")?.addEventListener("click", () => sendSelected(true));
document.getElementById("send-live-btn")?.addEventListener("click", () => sendSelected(false));

document.getElementById("generate-claude-btn")?.addEventListener("click", async () => {
  if (!selectedIssueId) {
    flash(appFlash, "Save the issue and at least one story first.", "err");
    return;
  }
  const btn = document.getElementById("generate-claude-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  flash(appFlash, "Claude is writing this issue…", "");
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/generate`, {
      method: "POST",
      body: "{}",
    });
    fillIssueForm(result.issue);
    flash(
      appFlash,
      `Claude draft saved (${result.model}). Review before sending.`,
      "ok"
    );
    await loadIssues();
  } catch (err) {
    flash(appFlash, err.message, "err");
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
});

storyForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedIssueId) {
    flash(appFlash, "Save the issue before adding stories.", "err");
    return;
  }
  if (!(storyForm instanceof HTMLFormElement)) return;
  const data = Object.fromEntries(new FormData(storyForm).entries());
  data.position = Number(data.position);
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/stories`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    storyForm.reset();
    const idField = storyForm.elements.namedItem("id");
    if (idField instanceof HTMLInputElement) idField.value = "";
    if (result.generated?.issue) {
      fillIssueForm(result.generated.issue);
      flash(appFlash, "Story saved and Claude rewrote the issue.", "ok");
    } else {
      flash(appFlash, "Story saved.", "ok");
      await loadStories(selectedIssueId);
    }
    await loadIssues();
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

storiesList?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !(storyForm instanceof HTMLFormElement)) return;
  if (target.dataset.storyEdit) {
    const story = JSON.parse(target.dataset.storyEdit);
    for (const [key, value] of Object.entries(story)) {
      const field = storyForm.elements.namedItem(key);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
        field.value = value == null ? "" : String(value);
      }
    }
  }
  if (target.dataset.storyDelete && selectedIssueId) {
    if (!confirm("Delete this story?")) return;
    try {
      await api(
        `/api/admin/issues/${selectedIssueId}/stories/${target.dataset.storyDelete}`,
        { method: "DELETE" }
      );
      await loadStories(selectedIssueId);
    } catch (err) {
      flash(appFlash, err.message, "err");
    }
  }
});

document.getElementById("task-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api("/api/admin/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    flash(appFlash, "Task added.", "ok");
    await Promise.all([loadTasks(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

taskBoard?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  try {
    if (target.dataset.taskStatus) {
      await api(`/api/admin/tasks/${target.dataset.taskStatus}`, {
        method: "PATCH",
        body: JSON.stringify({ status: target.dataset.status }),
      });
      await Promise.all([loadTasks(), loadStats()]);
    }
    if (target.dataset.taskDelete) {
      if (!confirm("Delete this task?")) return;
      await api(`/api/admin/tasks/${target.dataset.taskDelete}`, {
        method: "DELETE",
      });
      await Promise.all([loadTasks(), loadStats()]);
    }
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

bootstrap();
