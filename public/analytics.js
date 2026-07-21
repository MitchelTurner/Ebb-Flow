/**
 * First-party landing analytics + optional Plausible.
 * Events are allowlisted server-side; failures never break the page.
 */

const params = new URLSearchParams(window.location.search);

export function attribution() {
  return {
    utm_source: params.get("utm_source") || params.get("ref") || "",
    utm_medium: params.get("utm_medium") || "",
    utm_campaign: params.get("utm_campaign") || "",
    referrer: document.referrer || "",
    path: window.location.pathname || "/",
  };
}

let enabled = true;

export async function track(name, meta = {}) {
  if (!enabled) return;
  const attr = attribution();
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...attr, meta }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }

  // Mirror to Plausible when present.
  if (typeof window.plausible === "function") {
    try {
      window.plausible(name, { props: meta });
    } catch {
      /* ignore */
    }
  }
}

function loadPlausible(domain) {
  if (!domain || document.getElementById("plausible-script")) return;
  window.plausible =
    window.plausible ||
    function () {
      (window.plausible.q = window.plausible.q || []).push(arguments);
    };
  const script = document.createElement("script");
  script.id = "plausible-script";
  script.defer = true;
  script.setAttribute("data-domain", domain);
  script.src = "https://plausible.io/js/script.js";
  document.head.appendChild(script);
}

function wireTrackedLinks() {
  document.querySelectorAll("[data-track]").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.getAttribute("data-track");
      if (name) track(name);
    });
  });
}

function wireViewTracking() {
  const nodes = document.querySelectorAll("[data-track-view]");
  if (!nodes.length || !("IntersectionObserver" in window)) return;
  const seen = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const name = entry.target.getAttribute("data-track-view");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        track(name);
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.55 }
  );
  nodes.forEach((node) => io.observe(node));
}

async function bootstrap() {
  wireTrackedLinks();
  wireViewTracking();

  try {
    const res = await fetch("/api/public/landing");
    if (!res.ok) throw new Error("landing bootstrap failed");
    const data = await res.json();
    enabled = data.analytics_enabled !== false;

    const proof = document.getElementById("proof-label");
    if (proof instanceof HTMLElement && data.proof_label) {
      proof.textContent = data.proof_label;
    }

    if (data.plausible_domain) {
      loadPlausible(String(data.plausible_domain));
    }
  } catch {
    enabled = true;
  }

  track("page_view", {
    has_utm: Boolean(params.get("utm_source") || params.get("ref")),
  });
}

bootstrap();
