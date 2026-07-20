const form = document.getElementById("subscribe-form");
const message = document.getElementById("subscribe-message");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(form instanceof HTMLFormElement) || !(message instanceof HTMLElement)) return;

  const data = new FormData(form);
  const email = String(data.get("email") ?? "").trim();
  const first_name = String(data.get("first_name") ?? "").trim();

  message.className = "message";
  message.textContent = "";

  const button = form.querySelector('button[type="submit"]');
  if (button instanceof HTMLButtonElement) button.disabled = true;

  try {
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, first_name }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Could not subscribe.");

    message.className = "message ok";
    message.textContent = `You're on the list${first_name ? `, ${first_name}` : ""}. Watch your inbox.`;
    form.reset();
  } catch (err) {
    message.className = "message err";
    message.textContent = err instanceof Error ? err.message : "Something went wrong.";
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
});
