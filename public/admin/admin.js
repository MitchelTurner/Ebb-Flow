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

/** @type {any[]} */
let issuesCache = [];
/** @type {string | null} */
let selectedIssueId = null;

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch {
    throw new Error(
      "Could not reach the server. Wait for Railway to finish deploying, then refresh."
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    err.checklist = data.checklist;
    throw err;
  }
  return data;
}

function formatChecklistFailures(checklist) {
  if (!checklist?.items?.length) return "";
  const failed = checklist.items.filter((item) => !item.pass && item.required);
  if (!failed.length) return checklist.ok ? "" : "Checklist incomplete.";
  return failed.map((item) => `✗ ${item.label}`).join(" · ");
}

function renderChecklistInto(panel, checklist, title = "Editorial checklist") {
  if (!(panel instanceof HTMLElement) || !checklist) {
    if (panel instanceof HTMLElement) panel.innerHTML = "";
    return;
  }
  panel.innerHTML = `<strong>${title}</strong> ${
    checklist.ok ? '<span class="pass">ready</span>' : '<span class="fail">incomplete</span>'
  }<ul>${checklist.items
    .map(
      (item) =>
        `<li class="${item.pass ? "pass" : "fail"}">${item.pass ? "✓" : "✗"} ${escapeHtml(item.label)}${
          item.required ? "" : " (optional)"
        }</li>`
    )
    .join("")}</ul>`;
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
  document.querySelectorAll(".tab-btn, .tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.getAttribute("data-panel") !== name);
  });
  document.querySelectorAll(".workflow-step[data-goto-tab]").forEach((step) => {
    step.classList.toggle("is-active", step.getAttribute("data-goto-tab") === name);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  await Promise.all([
    loadStats(),
    loadOps(),
    loadSubscribers(),
    loadIssues(),
    loadReview(),
    loadProposals(),
    loadTranscripts(),
  ]);
}

async function loadStats() {
  const { stats } = await api("/api/admin/stats");
  if (!statsEl) return;
  const items = [
    ["Active subscribers", stats.active_subscribers],
    ["Bounced", stats.bounced_subscribers ?? 0],
    ["Unused transcripts", stats.unused_transcripts ?? 0],
    ["Drafts to review", stats.draft_issues],
    ["Scheduled", stats.scheduled_issues],
    ["Ready / due", stats.ready_issues],
    ["Sent (7d)", stats.sent_7d ?? 0],
    ["Failed (7d)", stats.failed_sends_7d ?? 0],
  ];
  statsEl.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
    )
    .join("");
}

async function runAutoDraft() {
  flash(
    appFlash,
    "Quick draft: refining topics + autofilling weather & tides…",
    ""
  );
  try {
    const { draft } = await api("/api/admin/auto-draft", {
      method: "POST",
      body: "{}",
    });
    if (!draft.drafted) {
      flash(appFlash, draft.reason || "Nothing to draft.", "err");
      return;
    }
    const topics = draft.topicCount ?? draft.sourceCount ?? draft.findingCount;
    const sources = draft.sourceCount ?? draft.findingCount;
    flash(
      appFlash,
      `Draft ready — ${topics} topic${topics === 1 ? "" : "s"} from ${sources} source${sources === 1 ? "" : "s"} (weather & tides filled).`,
      "ok"
    );
    await refreshAll();
    if (draft.result?.issue) {
      selectTab("issues");
      fillIssueForm(draft.result.issue);
    } else {
      selectTab("desk");
    }
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
}

async function runProposeTopics() {
  flash(appFlash, "Proposing digestible topics from newest transcripts…", "");
  try {
    const result = await api("/api/admin/proposals", {
      method: "POST",
      body: "{}",
    });
    if (!result.proposed) {
      flash(appFlash, result.reason || "Nothing to propose.", "err");
      return;
    }
    flash(
      appFlash,
      `Proposed ${result.proposal.topics.length} topics from ${result.sourceCount} sources — select & write.`,
      "ok"
    );
    selectTab("desk");
    await refreshAll();
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
}

async function loadOps() {
  const panel = document.getElementById("ops-panel");
  if (!panel) return;
  try {
    const { ops, health, funnel } = await api("/api/admin/ops");
    const pill = (ok, label) =>
      `<span class="ops-pill ${ok ? "ok" : "warn"}">${ok ? "✓" : "!"} ${escapeHtml(label)}</span>`;
    const failures = (ops.recent_failures || [])
      .map(
        (row) =>
          `<li><strong>${escapeHtml(row.email)}</strong> · ${escapeHtml(row.subject)}<br><span class="muted">${escapeHtml(row.error || "failed")}</span></li>`
      )
      .join("");
    const funnelHtml = funnel
      ? `<p class="muted" style="margin-top:0.85rem">Landing funnel (7d):
          views ${funnel.page_view ?? 0} ·
          form ${funnel.form_start ?? 0} ·
          submit ${funnel.subscribe_submit ?? 0} ·
          success ${funnel.subscribe_success ?? 0}
        </p>`
      : "";
    panel.innerHTML = `
      <p><strong>${ops.sent_7d}</strong> sent · <strong>${ops.failed_sends_7d}</strong> failed · <strong>${ops.bounced_subscribers}</strong> bounced · <strong>${ops.ready_due}</strong> due now</p>
      <div class="ops-health">
        ${pill(health.resend_configured, "Resend")}
        ${pill(!health.dry_run, health.dry_run ? "DRY_RUN on (blocks live send)" : "Live send mode")}
        ${pill(health.reply_to_configured, "Reply-To")}
        ${pill(health.webhook_configured, "Bounce webhook")}
        ${pill(health.cron_secret_configured, "Cron secret")}
        ${pill(
          !health.weekly_cron_in_process || health.cron_secret_configured,
          health.weekly_cron_in_process
            ? "In-process Monday cron"
            : "In-process Monday cron off"
        )}
        ${pill(health.analytics_enabled !== false, "Landing analytics")}
      </div>
      ${funnelHtml}
      ${
        failures
          ? `<p class="muted">Recent failures</p><ul class="fail-list">${failures}</ul>`
          : `<p class="muted">No recent send failures.</p>`
      }`;
  } catch (err) {
    panel.innerHTML = `<p class="fail">${escapeHtml(err.message)}</p>`;
  }
}

async function loadChecklist(issueId) {
  const panel = document.getElementById("checklist-panel");
  if (!panel || !issueId) {
    if (panel) panel.innerHTML = "";
    return;
  }
  try {
    const { checklist } = await api(`/api/admin/issues/${issueId}/checklist`);
    renderChecklistInto(panel, checklist);
  } catch {
    panel.innerHTML = "";
  }
}

async function loadProposals() {
  const host = document.getElementById("proposals-list");
  if (!host) return;
  const { proposals } = await api("/api/admin/proposals");
  if (!proposals.length) {
    host.innerHTML = `<p class="muted">No pending topic proposals. Click <strong>Propose topics</strong> to start.</p>`;
    return;
  }
  host.innerHTML = proposals
    .map((proposal) => {
      const marine = proposal.marine || {};
      const when = proposal.created_at
        ? new Date(proposal.created_at).toLocaleString()
        : "";
      const topics = (proposal.topics || [])
        .map(
          (topic) => `<div class="proposal-topic">
            <input type="checkbox" data-proposal-id="${proposal.id}" data-topic-key="${topic.key}" ${
              topic.selected !== false ? "checked" : ""
            }>
            <div>
              <strong>${escapeHtml(topic.title)}</strong>
              <div class="muted">${escapeHtml(topic.eyebrow || "")}</div>
              <p>${escapeHtml(topic.summary || "")}</p>
              <details class="grounding"><summary>Source grounding</summary><pre class="grounding-pre">${escapeHtml(
                topic.source_notes || "—"
              )}</pre></details>
            </div>
          </div>`
        )
        .join("");
      return `<article class="proposal-card" data-proposal="${proposal.id}">
        <h4>Proposal · ${escapeHtml(when)}</h4>
        <p class="muted">${escapeHtml(marine.weather || "Weather pending")} · tides ${escapeHtml(
          marine.high_tides || "—"
        )} / ${escapeHtml(marine.low_tides || "—")}</p>
        ${topics}
        <div class="row-actions spaced">
          <button type="button" data-proposal-accept="${proposal.id}">Write selected topics</button>
          <button type="button" class="secondary" data-proposal-discard="${proposal.id}">Discard</button>
        </div>
      </article>`;
    })
    .join("");
}

async function loadReview() {
  const { issues } = await api("/api/admin/review");
  const body = document.getElementById("review-body");
  const select = document.getElementById("schedule-issue-select");
  const checklistCache = {};
  await Promise.all(
    issues.map(async (issue) => {
      try {
        const { checklist } = await api(`/api/admin/issues/${issue.id}/checklist`);
        checklistCache[issue.id] = checklist;
      } catch {
        checklistCache[issue.id] = null;
      }
    })
  );
  if (body) {
    body.innerHTML = issues.length
      ? issues
          .map((issue) => {
            const scheduled = issue.scheduled_for
              ? new Date(issue.scheduled_for).toLocaleString()
              : "—";
            const checklist = checklistCache[issue.id];
            const checkLabel = checklist
              ? checklist.ok
                ? "ready"
                : "incomplete"
              : "—";
            const checkClass = checklist?.ok ? "ready" : "draft";
            return `<tr>
              <td>${escapeHtml(issue.subject)}</td>
              <td><span class="badge ${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span></td>
              <td><span class="badge ${checkClass}">${checkLabel}</span></td>
              <td>${escapeHtml(scheduled)}</td>
              <td class="row-actions">
                <button type="button" class="secondary" data-review-edit="${issue.id}">Open &amp; send</button>
                <a class="btn secondary" href="/preview/${issue.id}" target="_blank" rel="noopener">Preview</a>
              </td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="muted">No drafts yet. Propose topics from transcripts, then write.</td></tr>`;
  }
  if (select instanceof HTMLSelectElement) {
    select.innerHTML = issues
      .filter((i) => i.status === "draft" || i.status === "ready")
      .map(
        (issue) =>
          `<option value="${issue.id}">${escapeHtml(issue.subject)} (${issue.status})</option>`
      )
      .join("");
    if (select.value) await loadChecklist(select.value);
  }
}

async function loadTranscripts() {
  const { transcripts } = await api("/api/admin/transcripts");
  const body = document.getElementById("transcripts-body");
  if (!body) return;
  body.innerHTML = transcripts.length
    ? transcripts
        .map((row) => {
          const when = row.recorded_at
            ? new Date(row.recorded_at).toLocaleString()
            : "—";
          const used = row.used_in_issue_id ? "used" : "unused";
          const preview = String(row.content || "");
          return `<tr>
            <td>${escapeHtml(when)}</td>
            <td>
              <strong>${escapeHtml(row.title || "(untitled)")}</strong>
              <div class="muted">${escapeHtml(preview.slice(0, 160))}${preview.length > 160 ? "…" : ""}</div>
            </td>
            <td><span class="badge ${used === "unused" ? "todo" : "done"}">${used}</span></td>
            <td class="row-actions">
              ${
                row.used_in_issue_id
                  ? ""
                  : `<button type="button" class="danger" data-transcript-delete="${row.id}">Delete</button>`
              }
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="muted">No transcripts yet.</td></tr>`;
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

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const scheduledField = issueForm.elements.namedItem("scheduled_for_display");
  if (scheduledField instanceof HTMLInputElement) {
    scheduledField.value = toLocalInputValue(issue.scheduled_for);
  }
  loadStories(issue.id);
  loadContextFiles(issue.id);
}

async function loadContextFiles(issueId) {
  const list = document.getElementById("context-files-list");
  const status = document.getElementById("context-upload-status");
  if (!list) return;
  if (!issueId) {
    list.innerHTML = `<p class="muted">Save the issue first, then upload context files.</p>`;
    return;
  }
  try {
    const { files } = await api(`/api/admin/issues/${issueId}/context-files`);
    if (!files?.length) {
      list.innerHTML = `<p class="muted">No context files yet. Upload PDF/TXT/MD/CSV notes for Claude.</p>`;
      return;
    }
    list.innerHTML = files
      .map((file) => {
        const scope =
          file.story_position == null
            ? "Whole issue"
            : `Story ${file.story_position}`;
        const kb = Math.max(1, Math.round((file.byte_size || 0) / 1024));
        return `<div class="context-file-row">
          <div>
            <strong>${escapeHtml(file.filename)}</strong>
            <div class="muted">${escapeHtml(scope)} · ${kb} KB · ${file.char_count || 0} chars for AI</div>
          </div>
          <button type="button" class="danger" data-context-delete="${file.id}">Remove</button>
        </div>`;
      })
      .join("");
  } catch (err) {
    if (status) {
      status.textContent =
        err instanceof Error ? err.message : "Could not load context files.";
    }
  }
}

document
  .getElementById("context-upload-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedIssueId) {
      flash("Open an issue before uploading context.", "err");
      return;
    }
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const status = document.getElementById("context-upload-status");
    const fileInput = form.elements.namedItem("file");
    const positionField = form.elements.namedItem("story_position");
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.[0]) {
      flash("Choose a file to upload.", "err");
      return;
    }

    const body = new FormData();
    body.append("file", fileInput.files[0]);
    body.append(
      "story_position",
      positionField instanceof HTMLSelectElement ? positionField.value : "issue"
    );

    const button = form.querySelector('button[type="submit"]');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    if (status) status.textContent = "Uploading & extracting text…";

    try {
      const res = await fetch(`/api/admin/issues/${selectedIssueId}/context-files`, {
        method: "POST",
        body,
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Upload failed.");
      const matched =
        payload.file?.auto_matched && payload.file?.story_position
          ? ` (matched story ${payload.file.story_position})`
          : payload.file?.story_position
            ? ` (story ${payload.file.story_position})`
            : " (issue-wide)";
      flash(
        appFlash,
        `Added ${payload.file?.filename || "file"} to AI context${matched}.`,
        "ok"
      );
      form.reset();
      if (status) {
        status.textContent = payload.file?.auto_matched
          ? `Auto-matched to story ${payload.file.story_position}.`
          : "";
      }
      await loadContextFiles(selectedIssueId);
      await loadStories(selectedIssueId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      flash(message, "err");
      if (status) status.textContent = message;
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  });

document
  .getElementById("context-files-list")
  ?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.contextDelete) return;
    if (!selectedIssueId) return;
    if (!confirm("Remove this context file from AI grounding?")) return;
    try {
      await api(
        `/api/admin/issues/${selectedIssueId}/context-files/${target.dataset.contextDelete}`,
        { method: "DELETE", body: "{}" }
      );
      flash("Context file removed.", "ok");
      await loadContextFiles(selectedIssueId);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not remove file.", "err");
    }
  });

async function loadStories(issueId) {
  const { stories } = await api(`/api/admin/issues/${issueId}/stories`);
  if (!storiesList) return;
  storiesList.innerHTML = stories.length
    ? stories
        .map(
          (story) => `<div class="story-item">
            <h3>0${story.position} · ${escapeHtml(story.title)}</h3>
            <div class="muted">${escapeHtml(story.eyebrow || "")}</div>
            <p>${escapeHtml(story.summary || "")}</p>
            ${
              story.why_it_matters
                ? `<p class="muted"><em>${escapeHtml(story.why_it_matters)}</em></p>`
                : ""
            }
            <div class="grounding-panel ${
              story.source_notes ? "has-notes" : "missing-notes"
            }">
              <div class="grounding-head">
                <strong>Transcript grounding</strong>
                <span class="badge ${
                  story.source_notes ? "done" : "draft"
                }">${
                  story.source_notes
                    ? "Names must appear below"
                    : "Missing — fact-check / send will block"
                }</span>
              </div>
              ${
                story.source_notes
                  ? `<details class="grounding" open><summary>Show source notes</summary><pre class="grounding-pre">${escapeHtml(
                      story.source_notes
                    )}</pre></details>`
                  : `<p class="muted">Paste the raw transcript excerpt into Source notes when editing. Person names in the story must appear in that text.</p>`
              }
            </div>
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
    cta_label: "",
    tip_headline: "Got a tip or a story we missed?",
    tip_body: "Just hit reply — every message reaches the newsroom directly.",
    postal_address: "",
    status: "draft",
    fact_reviewed_at: null,
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

document.querySelectorAll(".tab-btn, .tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

document.querySelectorAll("[data-goto-tab]").forEach((el) => {
  const go = () => {
    const name = el.getAttribute("data-goto-tab");
    if (name) selectTab(name);
  };
  el.addEventListener("click", go);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      go();
    }
  });
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
  if (
    !dryRun &&
    !confirm(
      "Send this issue to all active subscribers?\n\nAfter a successful send it will appear in the public archive."
    )
  ) {
    return;
  }
  const forceEl = document.getElementById("send-force");
  const force = forceEl instanceof HTMLInputElement && forceEl.checked;
  const sendChecklistPanel = document.getElementById("send-checklist-panel");
  const sendBtn = document.getElementById("send-live-btn");
  if (!dryRun && sendBtn instanceof HTMLButtonElement) sendBtn.disabled = true;
  try {
    const data = await api(`/api/admin/issues/${selectedIssueId}/send`, {
      method: "POST",
      body: JSON.stringify({ dry_run: dryRun, force }),
    });
    const { result, checklist, archived, archive_url: archiveUrl } = data;
    renderChecklistInto(sendChecklistPanel, checklist, "Send checklist");
    if (dryRun || result?.dryRun) {
      flash(
        appFlash,
        `Dry run only — nothing delivered or archived (${result?.skipped ?? 0} would-skip).`,
        "err"
      );
    } else if (!result?.sent) {
      flash(appFlash, "No emails were sent — issue was not archived.", "err");
    } else if (result.failed > 0) {
      flash(
        appFlash,
        `Sent ${result.sent}, ${result.failed} failed.${
          archived ? " Issue is in the archive." : ""
        }`,
        "err"
      );
    } else {
      flash(
        appFlash,
        `Sent ${result.sent} email${result.sent === 1 ? "" : "s"}.${
          archived
            ? ` Live in archive: ${archiveUrl || "/archive"}`
            : " Refresh archive if it doesn’t show yet."
        }`,
        "ok"
      );
    }
    if (data.issue) fillIssueForm(data.issue);
    await Promise.all([loadIssues(), loadStats(), loadOps(), loadReview()]);
  } catch (err) {
    if (err.checklist) {
      renderChecklistInto(sendChecklistPanel, err.checklist, "Send blocked");
    }
    const detail = formatChecklistFailures(err.checklist);
    flash(appFlash, detail ? `${err.message} — ${detail}` : err.message, "err");
  } finally {
    if (sendBtn instanceof HTMLButtonElement) sendBtn.disabled = false;
  }
}

document.getElementById("send-dry-btn")?.addEventListener("click", () => sendSelected(true));
document.getElementById("send-live-btn")?.addEventListener("click", () => sendSelected(false));

document.getElementById("overview-auto-draft-btn")?.addEventListener("click", runAutoDraft);
document.getElementById("review-auto-draft-btn")?.addEventListener("click", runAutoDraft);
document.getElementById("overview-propose-btn")?.addEventListener("click", runProposeTopics);
document.getElementById("review-propose-btn")?.addEventListener("click", runProposeTopics);

document.getElementById("schedule-issue-select")?.addEventListener("change", (event) => {
  const select = event.currentTarget;
  if (select instanceof HTMLSelectElement) loadChecklist(select.value);
});

document.getElementById("proposals-list")?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.dataset.proposalAccept) {
    const proposalId = target.dataset.proposalAccept;
    const keys = [
      ...document.querySelectorAll(
        `input[type="checkbox"][data-proposal-id="${proposalId}"]:checked`
      ),
    ].map((el) => el.getAttribute("data-topic-key"));
    flash(appFlash, "Writing full draft from selected topics…", "");
    try {
      const result = await api(`/api/admin/proposals/${proposalId}/accept`, {
        method: "POST",
        body: JSON.stringify({ topic_keys: keys }),
      });
      flash(appFlash, "Draft written — review checklist, then schedule.", "ok");
      await refreshAll();
      if (result.result?.issue) {
        selectTab("issues");
        fillIssueForm(result.result.issue);
      }
    } catch (err) {
      flash(appFlash, err.message, "err");
    }
    return;
  }

  if (target.dataset.proposalDiscard) {
    if (!confirm("Discard this topic proposal?")) return;
    try {
      await api(`/api/admin/proposals/${target.dataset.proposalDiscard}/discard`, {
        method: "POST",
        body: "{}",
      });
      await loadProposals();
    } catch (err) {
      flash(appFlash, err.message, "err");
    }
  }
});

document.getElementById("review-body")?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.reviewEdit) return;
  const issue = issuesCache.find((i) => i.id === target.dataset.reviewEdit);
  if (issue) {
    selectTab("issues");
    fillIssueForm(issue);
  } else {
    await loadIssues();
    const again = issuesCache.find((i) => i.id === target.dataset.reviewEdit);
    if (again) {
      selectTab("issues");
      fillIssueForm(again);
    }
  }
});

document.getElementById("schedule-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  const issueId = String(data.get("issue_select") ?? "");
  const local = String(data.get("scheduled_for") ?? "");
  const force = Boolean(data.get("force"));
  if (!issueId || !local) {
    flash(appFlash, "Pick an issue and delivery time.", "err");
    return;
  }
  const scheduled_for = new Date(local).toISOString();
  try {
    await api(`/api/admin/issues/${issueId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduled_for, force }),
    });
    flash(appFlash, "Issue approved and scheduled.", "ok");
    await refreshAll();
  } catch (err) {
    flash(appFlash, err.message, "err");
    await loadChecklist(issueId);
  }
});

document.getElementById("preview-email-btn")?.addEventListener("click", async () => {
  if (!selectedIssueId) {
    flash(appFlash, "Save or open an issue first.", "err");
    return;
  }
  const input = document.getElementById("preview-email-input");
  const to = input instanceof HTMLInputElement ? input.value.trim() : "";
  if (!to) {
    flash(appFlash, "Enter your email for the preview.", "err");
    return;
  }
  const btn = document.getElementById("preview-email-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/preview-email`, {
      method: "POST",
      body: JSON.stringify({ to }),
    });
    flash(appFlash, `Preview sent to ${result.to}.`, "ok");
  } catch (err) {
    flash(appFlash, err.message, "err");
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
});

document.getElementById("transcript-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = Object.fromEntries(new FormData(form).entries());
  if (data.recorded_at) {
    data.recorded_at = new Date(String(data.recorded_at)).toISOString();
  } else {
    delete data.recorded_at;
  }
  try {
    await api("/api/admin/transcripts", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    flash(appFlash, "Transcript added.", "ok");
    await Promise.all([loadTranscripts(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

document.getElementById("transcripts-body")?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.transcriptDelete) return;
  if (!confirm("Delete this unused transcript?")) return;
  try {
    await api(`/api/admin/transcripts/${target.dataset.transcriptDelete}`, {
      method: "DELETE",
    });
    await Promise.all([loadTranscripts(), loadStats()]);
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

document.getElementById("generate-claude-btn")?.addEventListener("click", async () => {
  if (!selectedIssueId) {
    flash(appFlash, "Save the issue and at least one story first.", "err");
    return;
  }
  const btn = document.getElementById("generate-claude-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  flash(appFlash, "Claude is refining topics and rewriting this issue…", "");
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/generate`, {
      method: "POST",
      body: "{}",
    });
    fillIssueForm(result.issue);
    const panel = document.getElementById("fact-review-panel");
    if (panel) {
      panel.innerHTML =
        `<p class="muted">Draft rewritten — run <strong>AI fact-check</strong> before scheduling.</p>`;
    }
    flash(
      appFlash,
      `Claude draft saved (${result.model}). Run AI fact-check next.`,
      "ok"
    );
    await loadIssues();
    await loadStories(selectedIssueId);
  } catch (err) {
    flash(appFlash, err.message, "err");
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
});

function renderFactReview(result) {
  const panel = document.getElementById("fact-review-panel");
  if (!panel) return;
  const findings = result.findings || [];
  const nameFindings = findings.filter((f) =>
    String(f.evidence || "").includes("Deterministic name gate")
  );
  const otherFindings = findings.filter(
    (f) => !String(f.evidence || "").includes("Deterministic name gate")
  );
  const renderFinding = (f) => `<div class="finding ${escapeHtml(f.severity)}">
            <strong>${escapeHtml(f.severity)}</strong>
            ${f.story_position != null ? ` · story ${f.story_position}` : ""}
            · ${escapeHtml(f.field)}<br>
            ${escapeHtml(f.issue)}<br>
            <span class="muted">Evidence: ${escapeHtml(f.evidence || "—")}</span><br>
            <span class="muted">Fix: ${escapeHtml(f.suggestion || "—")}</span>
            ${
              f.source_url
                ? `<br><a href="${escapeAttr(f.source_url)}" target="_blank" rel="noopener">Web source</a>`
                : ""
            }
          </div>`;
  const findingHtml = findings.length
    ? `${
        nameFindings.length
          ? `<p class="name-gate-label">Name gate (${nameFindings.length})</p>${nameFindings
              .map(renderFinding)
              .join("")}`
          : ""
      }${
        otherFindings.length
          ? `<p class="name-gate-label">Transcript + web</p>${otherFindings
              .map(renderFinding)
              .join("")}`
          : ""
      }`
    : `<p class="pass">No name/detail issues flagged against transcripts or the web.</p>`;

  const gateLabel =
    result.name_gate_ok === false
      ? `<p class="fail">Name gate: failed — unsupported person names were flagged or stripped.</p>`
      : result.name_gate_ok
        ? `<p class="pass">Name gate: passed — every person-like name appears in transcript grounding.</p>`
        : "";

  const confirmReady =
    result.editor_confirm_ready ||
    (result.ok && result.name_gate_ok !== false);
  const alreadyConfirmed = Boolean(result.issue?.fact_reviewed_at);

  panel.innerHTML = `<h4>AI fact-check (transcripts + web + names)</h4>
    <p>${escapeHtml(result.summary || "")}${
      result.applied ? " Corrections were applied to the draft." : ""
    }</p>
    ${gateLabel}
    ${findingHtml}
    ${
      !result.ok && result.corrected && !result.applied
        ? `<div class="row-actions spaced">
            <button type="button" id="fact-review-apply-btn">Apply corrections</button>
          </div>`
        : ""
    }
    ${
      confirmReady && !alreadyConfirmed
        ? `<div class="row-actions spaced">
            <button type="button" id="fact-review-confirm-btn">Confirm fact-check</button>
            <span class="muted">Required before schedule / send.</span>
          </div>`
        : alreadyConfirmed
          ? `<p class="pass">Editor confirmed — checklist fact-check item is ready.</p>`
          : ""
    }`;
}

document.getElementById("fact-review-btn")?.addEventListener("click", async () => {
  if (!selectedIssueId) {
    flash(appFlash, "Save or open an issue first.", "err");
    return;
  }
  const btn = document.getElementById("fact-review-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  flash(
    appFlash,
    "Fact-checking names against transcripts, then the public web…",
    ""
  );
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/fact-review`, {
      method: "POST",
      body: JSON.stringify({ apply: true }),
    });
    renderFactReview(result);
    fillIssueForm(result.issue);
    await loadStories(selectedIssueId);
    await loadIssues();
    flash(
      appFlash,
      result.ok
        ? "Fact-check passed (transcripts + web + name gate)."
        : result.applied
          ? `Fact-check updated draft (${result.findings.filter((f) => f.severity === "error").length} error(s) flagged). Re-check names in the panel.`
          : "Fact-check found issues.",
      result.ok ? "ok" : "err"
    );
  } catch (err) {
    flash(appFlash, err.message, "err");
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
});

document.getElementById("fact-review-panel")?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === "fact-review-confirm-btn") {
    if (!selectedIssueId) return;
    target.setAttribute("disabled", "true");
    try {
      const result = await api(
        `/api/admin/issues/${selectedIssueId}/confirm-fact-review`,
        { method: "POST", body: "{}" }
      );
      fillIssueForm(result.issue);
      renderFactReview({
        ...result,
        ok: true,
        editor_confirm_ready: true,
        name_gate_ok: true,
        summary: "Editor confirmed fact-check.",
        findings: [],
        applied: false,
      });
      flash(appFlash, "Fact-check confirmed — you can schedule or send.", "ok");
      await Promise.all([loadIssues(), loadReview()]);
    } catch (err) {
      flash(appFlash, err.message, "err");
    } finally {
      target.removeAttribute("disabled");
    }
    return;
  }

  if (target.id !== "fact-review-apply-btn") return;
  if (!selectedIssueId) return;
  flash(appFlash, "Applying fact-check corrections…", "");
  try {
    const result = await api(`/api/admin/issues/${selectedIssueId}/fact-review`, {
      method: "POST",
      body: JSON.stringify({ apply: true }),
    });
    renderFactReview(result);
    fillIssueForm(result.issue);
    await loadStories(selectedIssueId);
    flash(appFlash, "Corrections applied.", "ok");
  } catch (err) {
    flash(appFlash, err.message, "err");
  }
});

document.getElementById("autofill-marine-btn")?.addEventListener("click", async () => {
  if (!selectedIssueId) {
    flash(appFlash, "Save or open an issue first.", "err");
    return;
  }
  const btn = document.getElementById("autofill-marine-btn");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  flash(appFlash, "Fetching Ketchikan weather & NOAA tides…", "");
  try {
    const { issue } = await api(`/api/admin/issues/${selectedIssueId}/marine`, {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    fillIssueForm(issue);
    flash(appFlash, "Weather and tides updated.", "ok");
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

bootstrap();
