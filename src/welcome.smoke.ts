import { renderSubscribeThankYouEmail } from "./welcome.js";

const { subject, html } = renderSubscribeThankYouEmail({
  subscriber: {
    email: "neighbor@example.com",
    first_name: "Alex",
    unsubscribe_token: "preview-token",
  },
  appUrl: "https://ebbflow.example",
});

if (!subject.includes("Ebb & Flow")) throw new Error("bad subject");
if (!html.includes("Alex")) throw new Error("missing first name");
if (!html.includes("neighbor@example.com")) throw new Error("missing email");
if (!html.includes("/unsubscribe/preview-token")) {
  throw new Error("missing unsubscribe link");
}
if (!html.includes("/archive")) {
  throw new Error("missing archive link");
}
if (!html.includes("Monday morning")) {
  throw new Error("missing Monday expectation");
}
if (!html.includes("Subscription confirmed")) {
  throw new Error("missing confirmation eyebrow");
}
if (!html.includes("/brand/logo.png") && !html.includes("cid:")) {
  throw new Error("missing logo url");
}
if (!html.includes('width="112"')) {
  throw new Error("welcome logo should be larger (112px)");
}

console.log("welcome.smoke ok");
