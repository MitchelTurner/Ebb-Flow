/** Shared branded HTML shells for unsubscribe / preferences / archive. */

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function brandPage(params: {
  title: string;
  body: string;
  eyebrow?: string;
}): string {
  const eyebrow = params.eyebrow ?? "The Ebb & Flow · Ketchikan";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(params.title)} · The Ebb &amp; Flow</title>
  <link rel="icon" type="image/png" href="/brand/logo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap" rel="stylesheet">
  <style>
    :root {
      --navy: #0c1824;
      --ink: #eef3f6;
      --mute: #8fa3b4;
      --gold: #c4a15f;
      --paper: #f0ede8;
      --body: #3a352e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Figtree, system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(ellipse 80% 50% at 20% 0%, rgba(196,161,95,0.12), transparent 55%),
        linear-gradient(160deg, #08131c 0%, var(--navy) 45%, #163044 100%);
    }
    main {
      max-width: 36rem;
      margin: 0 auto;
      padding: clamp(2.5rem, 8vw, 4.5rem) 1.5rem 3rem;
    }
    .mark { display:block; width:4.5rem; height:auto; margin:0 0 1.25rem; }
    .eyebrow {
      margin: 0 0 0.75rem;
      font-size: 0.72rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--mute);
    }
    h1 {
      margin: 0 0 1rem;
      font-family: Fraunces, Georgia, serif;
      font-size: clamp(2rem, 7vw, 2.75rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1;
      color: #f7f3ec;
    }
    p, li { color: rgba(238,243,246,0.86); line-height: 1.55; }
    a { color: var(--gold); }
    .card {
      margin-top: 1.5rem;
      padding: 1.25rem 1.35rem;
      background: rgba(7,13,19,0.45);
      border: 1px solid rgba(238,243,246,0.12);
      border-radius: 12px;
    }
    label { display:block; margin:0 0 0.85rem; color: var(--mute); font-size: 0.85rem; }
    input {
      display:block; width:100%; margin-top:0.35rem; padding:0.7rem 0.85rem;
      border-radius: 8px; border:1px solid rgba(238,243,246,0.18);
      background: rgba(0,0,0,0.25); color: var(--ink); font: inherit;
    }
    button, .btn {
      display:inline-block; margin-top:0.75rem; padding:0.7rem 1.15rem;
      border:0; border-radius:8px; background: var(--gold); color:#101820;
      font: inherit; font-weight:600; cursor:pointer; text-decoration:none;
    }
    button.secondary, .btn.secondary {
      background: transparent; color: var(--ink);
      border: 1px solid rgba(238,243,246,0.28);
    }
    .muted { color: var(--mute); font-size: 0.92rem; }
    .archive-list { list-style:none; padding:0; margin:1rem 0 0; }
    .archive-list li { padding:0.85rem 0; border-bottom:1px solid rgba(238,243,246,0.1); }
    .archive-list a { text-decoration:none; font-family: Fraunces, Georgia, serif; font-size:1.15rem; }
  </style>
</head>
<body>
  <main>
    <img class="mark" src="/brand/logo.png" width="72" height="72" alt="The Ebb &amp; Flow">
    <p class="eyebrow">${escape(eyebrow)}</p>
    <h1>${escape(params.title)}</h1>
    ${params.body}
  </main>
</body>
</html>`;
}

export { escape as escapeHtml };
