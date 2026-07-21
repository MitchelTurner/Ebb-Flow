import { attribution, track } from "./analytics.js";

const form = document.getElementById("subscribe-form");
const message = document.getElementById("subscribe-message");
const successPanel = document.getElementById("success-panel");
const ctaBlock = document.getElementById("subscribe-cta");

function fillAttributionFields() {
  if (!(form instanceof HTMLFormElement)) return;
  const attr = attribution();
  for (const [key, value] of Object.entries(attr)) {
    const input = form.elements.namedItem(key);
    if (input instanceof HTMLInputElement) input.value = value;
  }
}

function showSuccess(firstName) {
  if (form instanceof HTMLFormElement) form.classList.add("hidden");
  if (successPanel instanceof HTMLElement) {
    successPanel.hidden = false;
    successPanel.classList.remove("hidden");
    const title = successPanel.querySelector("h2");
    if (title) {
      title.textContent = firstName
        ? `You’re on the list, ${firstName}`
        : "You’re on the list";
    }
  }
  ctaBlock?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showFormAgain() {
  if (successPanel instanceof HTMLElement) {
    successPanel.hidden = true;
    successPanel.classList.add("hidden");
  }
  if (form instanceof HTMLFormElement) {
    form.classList.remove("hidden");
    form.reset();
    fillAttributionFields();
    const email = form.elements.namedItem("email");
    if (email instanceof HTMLInputElement) email.focus();
  }
  if (message instanceof HTMLElement) {
    message.className = "message";
    message.textContent = "";
  }
}

fillAttributionFields();

// Desktop: focus email (opt-in best practice). Skip on coarse pointers / small screens.
const emailInput = document.getElementById("email-input");
if (
  emailInput instanceof HTMLInputElement &&
  window.matchMedia("(min-width: 720px) and (pointer: fine)").matches
) {
  emailInput.focus({ preventScroll: true });
}

let formStarted = false;
form?.addEventListener(
  "focusin",
  () => {
    if (formStarted) return;
    formStarted = true;
    track("form_start");
  },
  true
);

document.getElementById("success-reset")?.addEventListener("click", showFormAgain);

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(form instanceof HTMLFormElement) || !(message instanceof HTMLElement)) return;

  fillAttributionFields();
  const data = new FormData(form);
  const email = String(data.get("email") ?? "").trim();
  const first_name = String(data.get("first_name") ?? "").trim();
  const company_website = String(data.get("company_website") ?? "").trim();
  const attr = attribution();

  message.className = "message";
  message.textContent = "";

  const button = form.querySelector('button[type="submit"]');
  if (button instanceof HTMLButtonElement) button.disabled = true;

  track("subscribe_submit", { has_name: Boolean(first_name) });

  try {
    let res;
    try {
      res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          first_name,
          company_website,
          ...attr,
        }),
      });
    } catch {
      throw new Error(
        "Could not reach the server. Wait a moment, then try again."
      );
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not subscribe.");

    // subscribe_success is recorded server-side (source of truth for the funnel).
    showSuccess(first_name);
  } catch (err) {
    const text = err instanceof Error ? err.message : "Something went wrong.";
    track("subscribe_error", { message: text.slice(0, 120) });
    message.className = "message err";
    message.textContent = text;
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
});
