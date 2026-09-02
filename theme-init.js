// Apply the saved theme before paint to avoid a flash. Kept as an external
// file so the page can enforce a strict `script-src 'self'` CSP (no inline JS).
try {
  var t = localStorage.getItem("tasktrack.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
