// Apply the saved theme before paint to avoid a flash. Kept as an external
// file so the page can enforce a strict `script-src 'self'` CSP (no inline JS).
// Light is the default; dark applies only if the user has toggled to it.
try {
  var t = localStorage.getItem("tasktrack.theme");
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
} catch (e) {
  document.documentElement.setAttribute("data-theme", "light");
}
