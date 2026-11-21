(() => {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

  if (!isLocal && !isIp) {
    return;
  }

  document.querySelectorAll("[data-service][data-port]").forEach((link) => {
    link.href = `http://${host}:${link.dataset.port}`;
  });
})();
