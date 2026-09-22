function createMockContext(config, secrets = {}) {
  return {
    getSecret: async (key) => secrets[key],
    setSecret: async (key, value) => {
      secrets[key] = value;
    },
    getConfig: (key, fallback) => config[key] ?? fallback,
  };
}

module.exports = { createMockContext };
