// Kept out of offline.html so the page works under the site's
// Content-Security-Policy (script-src 'self' - no inline scripts).
document.getElementById("retry")?.addEventListener("click", () => location.reload());
// Auto-retry the moment the connection comes back.
window.addEventListener("online", () => location.reload());
