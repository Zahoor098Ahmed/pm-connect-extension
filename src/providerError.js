class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {string} provider
   * @param {unknown} [cause]
   */
  constructor(message, provider, cause) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.cause = cause;
  }
}

module.exports = { ProviderError };
