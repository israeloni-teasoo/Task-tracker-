// Register the service worker (offline support) and surface an "Update
// available" banner when a new version is ready — the user taps to refresh,
// so a reload never interrupts them mid-task. External file so the page can
// enforce a strict `script-src 'self'` CSP (no inline JS).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  let updateAccepted = false;
  const banner = document.getElementById("updateBanner");

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateAccepted) location.reload();   // only after the user opted in
  });

  function offerUpdate(reg) {
    if (!reg.waiting || !banner) return;
    banner.hidden = false;
    banner.onclick = () => {
      updateAccepted = true;
      banner.hidden = true;
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    };
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      if (reg.waiting) offerUpdate(reg);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(reg);
        });
      });
      reg.update();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
      setInterval(() => reg.update(), 60 * 60 * 1000);
    }).catch((e) => console.warn("SW registration failed:", e));
  });
}
