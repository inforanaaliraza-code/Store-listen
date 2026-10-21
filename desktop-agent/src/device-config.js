(() => {
  function migrateSavedApiBase(savedConfig, application) {
    if (!savedConfig || !application?.isPackaged || application.error || !application.apiBase) return savedConfig;
    if (savedConfig.apiBase === application.apiBase) return savedConfig;
    return { ...savedConfig, apiBase: application.apiBase };
  }

  function isDeviceSessionExpired(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /invalid or expired (?:device )?session|invalid or expired device|invalid device credentials/i.test(message);
  }

  const deviceConfig = { isDeviceSessionExpired, migrateSavedApiBase };

  if (typeof window !== 'undefined') window.StoreListenDeviceConfig = deviceConfig;
  if (typeof module !== 'undefined') module.exports = deviceConfig;
})();