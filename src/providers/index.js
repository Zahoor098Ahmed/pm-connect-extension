const { CustomProvider } = require("./customProvider");
const { TrelloProvider } = require("./trelloProvider");

const PROVIDERS = {
  custom: new CustomProvider(),
  trello: new TrelloProvider(),
};

function getActiveProviderId(getConfig) {
  return getConfig("pmConnect.provider", "custom");
}

function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

module.exports = { PROVIDERS, getActiveProviderId, getProvider };
